#!/usr/bin/env node
// agent-orch worker daemon (BRIEF goal 11; design: .agent-orch/CLUSTER.md, wire format: cluster-protocol.mjs). Runs on
// extra machines, dials OUT to the controller over WSS (no inbound port), reports its inventory and resources, and runs
// the jobs it is given in local checkouts of the project's GitHub repo with the same adapters as the controller. It
// reports richly: each job's phases with progress hints, health telemetry every heartbeat, structured errors, its log
// tail on request, and it updates itself (git pull + service restart) when the controller asks while it is idle. On a
// Mac it follows its power policy from the controller (power.mjs): no new jobs on low battery or when hot, and awake
// (caffeinate) only while jobs run.
// Compute-only (BRIEF goal 11): no chat, planner, reflection or management here, and nothing of the controller's is
// loaded (server.mjs, orchestrator.mjs, cluster.mjs). It acts only on the head's allow-listed frames (cluster-protocol.mjs
// WORKER_ACCEPTS), rejecting and logging anything else; it opens no TCP port; its slots, power policy and draining come
// only from the head. The one local setting is the machine's contribution cap (cap.mjs), a ceiling the head keeps to and
// the worker enforces itself (worker-cap.mjs); the one local UI is a terminal status view, fed over a unix socket in its
// home (worker-status.mjs). These are its only commands (the installers add --uninstall):
//   node worker.mjs pair --controller https://<host> --code ABCD-1234 [--name mac]   one time: stores the node token
//   node worker.mjs check [--controller https://<host>]                              is the pairing still good (installers)
//   node worker.mjs run                                                              the daemon (systemd / launchd)
//   node worker.mjs status [--once]                                                  the live status view (q quits)
//   node worker.mjs limit --cpu <cores|N%> --mem <GB|N%> [--max-tasks N] [--only-on-ac] | --show | --reset
// Everything lives in ~/.agent-orch-worker (AGENT_ORCH_WORKER_HOME overrides): config.json (0600: the pairing and the
// cap), worker.sock (the status socket, 0600), repos/ (bare cache clones), worktrees/, deps/ (node_modules by lockfile
// hash), npm-cache/, run/ (each job's wrapper scripts and pids), logs/, extensions/ (the head's MCP servers, 0600, and synced.json:
// the skills and subagents it wrote into ~/.claude and ~/.codex). git and gh use the machine's own login.
// Disk hygiene (pruneCaches, at start and after every job's worktree is removed): a deps/<hash> no worktree's
// node_modules links to and unused for DEPS_TTL_MS (3 days) is deleted, npm-cache/ goes whole once over 300 MB, and
// repos/ caches go after 14 idle days.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION, WS_PATH, CLAIM_PATH, WHOAMI_PATH, EXT_PATH, EXT_MAX_BODY, HEARTBEAT_MS, HEARTBEAT_MISSES, WIP_PUSH_MS, SLEEP_JUMP_MS, MAX_FRAME, MAX_BATCH, MSG, OUTCOMES,
  EVENT_KINDS, OS_KINDS, GRACE_MS, FEATURES, FEATURE_LIST, WORKER_ACCEPTS, backoffMs, createSender, decode,
} from './cluster-protocol.mjs';
import { AGENTS, agentStatus, clearLoginCache, fetchLimits, modelCatalog, readVersion, runAgentCli } from './agents.mjs';
import { createExtensions } from './extensions.mjs';
import { agentAccount } from './health.mjs';
import { createNodeLogins } from './remote-login.mjs';
import { parseCodexAuth } from './agent-share.mjs';
import { createModelStore } from './models.mjs';
import { createLimitStore } from './usage.mjs';
import { cpuPercent, createResources, readSystem, registerPid, withOwner } from './resources.mjs';
import { helperOut, runHelper } from './helpers.mjs';
import { autoTasks, createKeepAwake, effectivePolicy, intake as intakeOf, readPower, reserveBytes, wantsAwake } from './power.mjs';
import { MEM } from './parallel.mjs';
import { GIT_ID, commitAll, taskBranch } from './worktrees.mjs';
import { isBrowserTask } from './browser-task.mjs';
import { extractCommand, runCheck, toolLine } from './taskrun.mjs';
import { JOB_ENV, workerHome } from './role.mjs';
import { FOOTPRINT, applyLimit, capRejection, capTasks, capText, fmtCores, fmtGB, resolveCap } from './cap.mjs';
import { createJobUsage, createWrappers, heldBy, probeLimiter } from './worker-cap.mjs';
import { request as statusRequest, serveStatus, statusCli } from './worker-status.mjs';
import { ensureBrowser, needsBrowser, normIdentity } from './browser.mjs';
import { APPROVAL_TTL_MS, hostGate, patternsWith } from './gate.mjs';
import { MEDIA_ID_RE } from './media.mjs';
import { createLiveBrowsers, screenOp } from './browser-live.mjs';

const execFileP = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return 'unknown'; } })();
const RESUME_PROMPT = 'You were interrupted before finishing. Continue the same task from where you left off.';
const EVENT_FLUSH_MS = 1000;
const MAX_PENDING_EVENTS = 5000; // events kept per job for a replay after a reconnect (oldest dropped)
const CLOCK_MS = 5000; // the sleep detector's tick
// Tests shorten these: the reconnect backoff's ceiling and the time jump that counts as a sleep.
const BACKOFF_MAX_MS = Number(process.env.AGENT_ORCH_WORKER_BACKOFF_MAX_MS) || Infinity;
const SLEEP_MS = Number(process.env.AGENT_ORCH_WORKER_SLEEP_JUMP_MS) || SLEEP_JUMP_MS;
// A timer due every `interval` that fires `gap` ms after the last one: the process was suspended (a laptop's sleep).
export const sleptFor = (gap, interval, jump = SLEEP_JUMP_MS) => (gap > interval + jump ? gap - interval : 0);
const BATCH_BYTES = 512 * 1024;
const CACHE_TTL_MS = 14 * 86400e3; // cached repos unused this long are pruned
const DEPS_TTL_MS = 3 * 86400e3; // a deps/<hash> no worktree links to and unused this long is pruned
const NPM_CACHE_MAX = 300 * 1024 ** 2; // npm-cache/ over this is removed whole (npm recreates it)
const LOG_MAX = 10 * 1024 ** 2;
const PROGRESS_MS = 5000; // a running job's progress hints go out at most this often (when they changed)
// Telemetry probes, cached between heartbeats: GitHub's reachability (a TCP connect; host:port, 'off' in tests) once a
// minute, a Mac's battery and thermal state (pmset, notifyutil) once a minute and fresh before an offer is answered.
const NET_PROBE = process.env.AGENT_ORCH_WORKER_NET_PROBE || 'github.com:443';
const PROBE_EVERY_MS = 60_000;
// AGENT_ORCH_WORKER_POWER: a fixture file with those readings (power.mjs readPower), re-read every heartbeat; tests use
// it (with AGENT_ORCH_WORKER_CAFFEINATE, a stub caffeinate) to run the power policy on any OS.
const POWER_FIXTURE = process.env.AGENT_ORCH_WORKER_POWER || null;
const POWERED = process.platform === 'darwin' || !!POWER_FIXTURE;
// The agent-orch checkout this worker runs from, which node.update pulls (tests point it at a scratch repo).
const SRC_DIR = process.env.AGENT_ORCH_WORKER_SRC || ROOT;
// The local cap (cap.mjs): running jobs' CPU/RAM are sampled this often; jobs over its RAM cap for CAP_PAUSE_MS pause the
// newest, which isn't taken back here for CAP_DECLINE_MS (tests shorten the pause).
const USAGE_MS = 2000;
const CAP_PAUSE_MS = Number(process.env.AGENT_ORCH_WORKER_CAP_PAUSE_MS) || 30_000;
const CAP_DECLINE_MS = 10 * 60_000;
const RECENT = 5; // finished jobs the status view lists
// Browser tasks (browser.mjs): at start the worker checks for a Chromium/Chrome and, without one, installs Playwright's.
// AGENT_ORCH_WORKER_BROWSER=off|check|install; under node:test it only checks unless told to install.
const BROWSER_MODE = process.env.AGENT_ORCH_WORKER_BROWSER || (process.env.NODE_TEST_CONTEXT ? 'check' : 'install');
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// The files an edit tool call touched: Claude's file_path, or codex's file_change lines ("add hello.txt").
const editedFiles = (e) => (EDIT_TOOLS.has(e.name) ? String(e.input?.file_path || e.input?.path || '').split('\n')
  .map((l) => l.replace(/^(add|update|delete|modify|rename|move)\s+/, '').trim()).filter(Boolean) : []);
const firstLine = (e) => String(e?.message || e || '').trim().split('\n')[0].slice(0, 500);

// ---------------------------------------------------------------- config, logs

const configFile = (home) => path.join(home, 'config.json');
export function readConfig(home = workerHome()) {
  try { return JSON.parse(fs.readFileSync(configFile(home), 'utf8')); } catch { return null; }
}
function writeConfig(home, cfg) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const f = configFile(home), tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 1), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, f);
}

function createLog(home) {
  const dir = path.join(home, 'logs'), file = path.join(dir, 'worker.log');
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  const log = (m, level = 'info') => {
    const line = `${new Date().toISOString()} ${level} ${m}\n`;
    try {
      if ((fs.statSync(file, { throwIfNoEntry: false })?.size || 0) > LOG_MAX) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, line);
    } catch {}
    process.stdout.write(line);
  };
  log.job = (id, entry) => { try { fs.appendFileSync(path.join(dir, 'jobs', `${id}.jsonl`), JSON.stringify(entry) + '\n'); } catch {} };
  return log;
}
const logFile = (home) => path.join(home, 'logs', 'worker.log');

// The last n lines of a log (and of its rotated predecessor when that one is too short), each clipped to 2000 chars and
// together small enough for one frame (the oldest lines give way).
export function tailLines(file, n, maxBytes = 512 * 1024) {
  const read = (f) => {
    let fd;
    try { fd = fs.openSync(f, 'r'); } catch { return []; }
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(size, maxBytes), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      if (len < size) lines.shift(); // cut mid-line
      return lines;
    } finally { fs.closeSync(fd); }
  };
  let lines = read(file);
  if (lines.length < n) lines = [...read(`${file}.1`), ...lines];
  const out = [];
  for (let i = lines.length - 1, bytes = 0; i >= 0 && out.length < n; i--) {
    const l = lines[i].length > 2000 ? `${lines[i].slice(0, 2000)}…` : lines[i];
    if ((bytes += JSON.stringify(l).length + 1) > 700_000) break;
    out.push(l);
  }
  return out.reverse();
}

// ---------------------------------------------------------------- pairing

// The name a machine pairs under unless --name is given: on a Mac its model and local host name ('MacBook Pro
// (Sanat-MBP-2)'), else its short hostname. The controller makes it unique; the owner can rename it (Machines view).
export const macName = (hardware, host) => `${/Model Name:\s*(.+)/.exec(hardware || '')?.[1]?.trim() || 'Mac'}${host ? ` (${host})` : ''}`;
export async function defaultName() {
  const short = os.hostname().split('.')[0] || 'worker';
  if (process.platform !== 'darwin') return short;
  const out = (cmd, args) => helperOut(cmd, args, { timeoutMs: 15_000 }).then((s) => s.trim(), () => '');
  const [hw, host] = await Promise.all([out('/usr/sbin/system_profiler', ['SPHardwareDataType']), out('/usr/sbin/scutil', ['--get', 'LocalHostName'])]);
  return macName(hw, host || short);
}

// Trades a pairing code from the owner's "Add machine" (one-time, or one code for several machines) for this machine's
// own node id + bearer token, stored 0600.
export async function pair({ controller, code, name, home = workerHome() }) {
  if (!OS_KINDS.includes(process.platform)) throw new Error(`unsupported OS ${process.platform} (need ${OS_KINDS.join(' or ')})`);
  name ||= await defaultName();
  const base = new URL(controller);
  const r = await fetch(new URL(CLAIM_PATH, base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name, os: process.platform, arch: process.arch }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(`pairing failed (HTTP ${r.status}): ${j.error || 'no token'}`);
  writeConfig(home, { controller: base.origin, node: j.node, name: j.name || name, token: j.token, pairedAt: Date.now() });
  return { node: j.node, name: j.name || name };
}

// Is this machine still paired with the head (`controller`: the one the installer names; another head = not paired)?
// 'ok' {name}: the head still knows it. 'unpaired': no pairing here, one for another head, or the head removed it.
// 'unknown': the head couldn't be asked (offline, or a head too old to answer); the installer then keeps the pairing.
export async function checkPairing({ controller = null, home = workerHome() } = {}) {
  const c = readConfig(home);
  if (!c?.token || !c?.controller) return { state: 'unpaired', why: 'not paired' };
  if (controller && new URL(controller).origin !== c.controller) return { state: 'unpaired', why: `paired with ${c.controller}` };
  try {
    const r = await fetch(new URL(WHOAMI_PATH, c.controller), { headers: { authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.node === c.node) return { state: 'ok', name: j.name || c.name };
    if (r.status === 401) return { state: 'unpaired', why: 'the head removed this machine' };
    return { state: 'unknown', why: `HTTP ${r.status}` };
  } catch (e) { return { state: 'unknown', why: e.message }; }
}

// ---------------------------------------------------------------- git

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0' };
async function git(cwd, args, { env, timeout = 600_000 } = {}) {
  return (await execFileP('git', args, { cwd, env: { ...process.env, ...GIT_ENV, ...env }, encoding: 'utf8', timeout, maxBuffer: 64 << 20 })).stdout;
}
const gitOk = (cwd, args, opts) => git(cwd, args, opts).then(() => true, () => false);
// https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git) → 'owner__repo'.
export function cacheName(repo) {
  const parts = repo.replace(/\.git$/, '').split(/[/:]/).filter(Boolean);
  return parts.slice(-2).join('__').replace(/[^\w.-]/g, '_');
}

// The summed file sizes under dir (symlinks not followed); stops counting once past `stop`.
async function dirSize(dir, stop = Infinity) {
  let total = 0;
  const walk = async (d) => {
    for (const e of await fs.promises.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (total > stop) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await fs.promises.stat(p).catch(() => null))?.size || 0;
    }
  };
  await walk(dir);
  return total;
}

// ---------------------------------------------------------------- the daemon

// restart(): after a self-update, start the new code (default: a clean stop, then exit 0 so systemd/launchd restart it).
export function createWorker({ home = workerHome(), config = readConfig(home), log = createLog(home), srcDir = SRC_DIR, restart = null } = {}) {
  if (!config?.token || !config?.node || !config?.controller) throw new Error(`not paired: run \`node worker.mjs pair --controller https://<host> --code <code>\` first (${configFile(home)})`);
  const dirs = { repos: path.join(home, 'repos'), worktrees: path.join(home, 'worktrees'), deps: path.join(home, 'deps'), npmCache: path.join(home, 'npm-cache') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const ids = Object.keys(AGENTS);
  const jobs = new Map(); // job id -> job (setup | running | paused | checking | pushing)
  const finished = new Map(); // job id -> job.start spec of recently finished jobs (a later job.resume restarts from the pushed branch)
  const held = new Map(); // job id -> a finished job whose job.done the controller hasn't acked yet (replayed on reconnect)
  const gitCreds = new Map(); // host -> token from git.credential (memory only)
  let ws = null, send = null, welcomed = false, attempt = 0, connectedAt = 0, lastFrame = 0, stopping = false;
  let heartbeatMs = HEARTBEAT_MS, wipPushMs = WIP_PUSH_MS, graceMs = process.platform === 'darwin' ? GRACE_MS.mac : GRACE_MS.vps, beat = null, reconnectTimer = null;
  let pendingWake = null;
  let peer = new Set(); // the controller's features (welcome.features): newer frame types go only to one that reads them
  let srcSha = null, lastInv = null, updating = false;
  // The power policy and task cap the controller set for this node (welcome.policy, node.policy); its OS defaults until then.
  let policy = effectivePolicy(process.platform), policyText = '';
  const awake = POWERED ? createKeepAwake({ log }) : null;
  // The local cap (`node worker.mjs limit`, config.json; reloaded over the status socket) and how its jobs are held to it
  // (worker-cap.mjs: probed once a CPU/RAM cap exists). use: the jobs' CPU/RAM, sampled while they run.
  const machine = { cores: os.cpus().length, memTotal: os.totalmem() };
  let cap = resolveCap(config.cap, machine), limiter = null, limiterBusy = null;
  const wrappers = createWrappers({ dir: path.join(home, 'run'), cap: () => cap, mode: () => limiter || 'off' });
  const usage = createJobUsage();
  let use = { at: 0, cpu: 0, mem: 0, jobs: new Map() }, sampling = null, overSince = 0;
  const capPaused = new Map(); // job id -> until (ms): the memory watch paused it; not taken back here meanwhile
  // For the status view: the last finished jobs, the head's count of tasks up next for this machine, the connection.
  const recent = [];
  let queued = null, downSince = Date.now(), retryAt = 0, connError = null, status = null;
  // browser: {capable, headed, error?} once checked (inventory.browser).
  let browser = null, browserAbort = null;
  // The owner's live view of a browser profile here (browser-live.mjs), driven by the head's screen.* frames; frames are
  // dropped while the socket is backed up. Created on first use.
  let screens = null;
  const screenOut = {
    onFrame: (f) => { if ((ws?.bufferedAmount || 0) < 2 * MAX_FRAME) raw(MSG.SCREEN_FRAME, f); },
    onState: (st) => raw(MSG.SCREEN_STATE, st),
  };
  async function screenReq(msg) {
    screens ??= createLiveBrowsers({ log });
    let out;
    try { out = { result: await screenOp(screens, msg, screenOut) }; } catch (e) { out = { error: String(e.message || e).slice(0, 500) }; }
    raw(MSG.SCREEN_RES, { req: msg.req, ...out });
  }

  // Model lists (once a day per agent, cached) and plan limits (only on limits.refresh): nothing polls (BRIEF goal 7).
  const models = createModelStore({ file: path.join(home, 'models.json'), log, onChange: () => sendInventory() });
  const limits = createLimitStore({ file: path.join(home, 'limits.json'), ids, fetch: (id) => fetchLimits(id), log });
  // Remote sign-in: the controller's Connections window drives this machine's CLI logins (remote-login.mjs).
  const logins = createNodeLogins({ send: (t, f) => raw(t, f), log, afterChange: (id) => {
    clearLoginCache();
    sendInventory();
    models.refresh([id]).catch(() => {});
  } });
  // The controller's skills, subagents and MCP servers (extensions.mjs bundle), written into this machine's homes.
  const ext = createExtensions({ dataDir: home });
  let extRun = null, extError = null;
  const reaperMode = process.env.AGENT_ORCH_REAPER || 'on';
  const resources = fs.existsSync('/proc/self/stat') && reaperMode !== 'off' ? createResources({
    mode: reaperMode, isActive: (o) => o.kind === 'task' && jobs.get(Number(o.id))?.state === 'running', loginActive: () => logins.active(), log,
  }) : null;

  // ---- frames
  const live = () => welcomed && ws?.readyState === WebSocket.OPEN;
  const supports = (t) => !FEATURES[t] || peer.has(FEATURES[t]);
  function raw(t, fields) {
    if (!live() || !supports(t)) return false;
    try { ws.send(send(t, fields)); return true; } catch (e) { log(`could not send ${t}: ${e.message}`, 'warn'); return false; }
  }
  // Compute-only: a frame type off the allow-list (WORKER_ACCEPTS: a chat, a prompt, a setting, a frame only a worker
  // sends…) is never acted on: logged, and answered with an error.
  function reject(t) {
    log(`rejected ${JSON.stringify(t)} from the controller: not on the worker's allow-list (compute-only)`, 'warn');
    return raw(MSG.ERROR, { message: `${JSON.stringify(t)} is not accepted by a worker: workers are compute-only (jobs, sign-in, refreshes, logs, updates and policy from the head)` });
  }

  // ---- a job's stream: its events (index = position since the job started) and its other frames (job.check, job.wip,
  // job.done), each placed after the events emitted before it. Nothing is dropped once sent: after a reconnect the
  // controller answers job.attach {from} and the worker replays from there, so events arrive once, in order. Until
  // then (or while the controller is away) frames wait here; the agent keeps running either way.
  const clip = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) + '\n…' : v);
  function slim(e) {
    if (e.k === 'image') return { k: 'image', tool: e.tool, mediaType: e.mediaType, ...(e.data?.length <= 256 * 1024 ? { data: e.data } : { dropped: true }) };
    const out = { ...e, text: clip(e.text, 32_000) };
    if (JSON.stringify(out).length > 64_000) return { k: e.k, name: e.name, id: e.id, text: clip(String(e.text ?? JSON.stringify(e.input ?? '')), 32_000), clipped: true };
    return out;
  }
  const evEnd = (job) => job.evBase + job.ev.length;
  function pushEvent(job, e) {
    if (!e || !EVENT_KINDS.includes(e.k)) return;
    const s = slim(e);
    log.job(job.id, s.k === 'image' ? { ...s, data: undefined } : s);
    if (s.k === 'tool') {
      const p = job.progress;
      p.tools++;
      p.last = toolLine(s).slice(0, 200);
      for (const f of editedFiles(s)) if (p.files.size < 10_000) p.files.add(f);
    }
    if (s.k === 'tool' || (s.k === 'text' && String(s.text || '').trim())) { // its last activity, for the status view
      job.activity = s.k === 'tool' ? job.progress.last : firstLine(s.text).slice(0, 200);
      job.activityAt = Date.now();
    }
    job.ev.push(s);
    if (job.ev.length > MAX_PENDING_EVENTS) {
      const n = job.ev.length - MAX_PENDING_EVENTS;
      job.ev.splice(0, n); job.evBase += n; job.sent = Math.max(job.sent, job.evBase);
    }
  }
  function emit(job, t, fields) {
    job.ctl.push({ t, fields, upto: evEnd(job) });
    flushJob(job);
  }
  // Sends events [sent, upto) in batches of at most MAX_BATCH / BATCH_BYTES.
  function sendEvents(job, upto) {
    while (job.sent < upto && live()) {
      const i0 = job.sent - job.evBase;
      let n = 0, bytes = 0;
      while (job.sent + n < upto && n < MAX_BATCH && (n === 0 || bytes + JSON.stringify(job.ev[i0 + n]).length < BATCH_BYTES)) bytes += JSON.stringify(job.ev[i0 + n++]).length;
      if (!raw(MSG.JOB_EVENT, { job: job.id, from: job.sent, events: job.ev.slice(i0, i0 + n) })) return false;
      job.sent += n;
    }
    return job.sent >= upto;
  }
  function flushJob(job) {
    if (!job?.attached) return;
    while (job.ctlSent < job.ctl.length) {
      const c = job.ctl[job.ctlSent];
      if (!sendEvents(job, c.upto)) return;
      if (supports(c.t) && !raw(c.t, c.fields)) return; // a type this controller can't read is skipped
      if (c.t === MSG.JOB_DONE) c.seqSent = true;
      job.ctlSent++;
    }
    sendEvents(job, evEnd(job));
  }
  const allJobs = () => [...jobs.values(), ...held.values()];
  const flusher = setInterval(() => { for (const j of allJobs()) { flushJob(j); sendProgress(j); } syncAwake(); }, EVENT_FLUSH_MS);

  // ---- phases (job.phase): queued → cloning/fetching → installing → running → checking → committing → pushing → done.
  // Each frame is stamped when its phase starts and says how long the one before took; it rides the job's stream (held
  // while away, replayed after job.attach). Progress hints while the agent runs go out directly, at most every
  // PROGRESS_MS: the running phase again (same `at`) with {tools, files, last}.
  function setPhase(job, phase, extra = {}) {
    const t = Date.now(), prev = job.phase;
    if (prev?.name === 'running') sendProgress(job, true);
    job.phase = { name: phase, at: t };
    emit(job, MSG.JOB_PHASE, { job: job.id, phase, at: t, ...(prev ? { ms: Math.max(0, t - prev.at) } : {}), ...extra });
  }
  function sendProgress(job, now = false) {
    const p = job.progress, sig = `${p.tools}/${p.files.size}/${p.last}`;
    if (job.phase?.name !== 'running' || !job.attached || sig === job.progressSig || (!now && Date.now() - job.progressAt < PROGRESS_MS)) return;
    if (raw(MSG.JOB_PHASE, { job: job.id, phase: 'running', at: job.phase.at, progress: { tools: p.tools, files: p.files.size, last: p.last } })) {
      job.progressSig = sig;
      job.progressAt = Date.now();
    }
  }

  // ---- structured errors (job.error / node.error) with a stack or stderr tail; a controller that can't read them gets
  // a plain error frame instead.
  const tail = (v) => (v ? String(v).slice(-4000) : undefined);
  function jobError(job, kind, message, { stack, stderr } = {}) {
    log(`job ${job.id} ${kind}: ${message}`, 'error');
    const fields = { job: job.id, kind, message: String(message).slice(0, 2000), stack: tail(stack), stderr: tail(stderr), at: Date.now() };
    if (supports(MSG.JOB_ERROR)) emit(job, MSG.JOB_ERROR, fields);
    else raw(MSG.ERROR, { message: `${kind}: ${fields.message}`, job: job.id });
  }
  function nodeError(kind, message, { stack, stderr, re } = {}) {
    const fields = { kind, message: String(message).slice(0, 2000), stack: tail(stack), stderr: tail(stderr), re };
    return supports(MSG.NODE_ERROR) ? raw(MSG.NODE_ERROR, fields) : raw(MSG.ERROR, { message: `${kind}: ${fields.message}`, re });
  }
  // The controller has this job's stream up to `from`: drop what it has, replay the rest (frames placed at or after it).
  function attachJob(msg) {
    const job = jobs.get(msg.job) || held.get(msg.job);
    if (!job) return raw(MSG.ERROR, { message: `job ${msg.job} is not on this worker`, job: msg.job });
    const from = Math.min(Math.max(msg.from, 0), evEnd(job));
    if (from < job.evBase) log(`job ${job.id}: events ${from}-${job.evBase - 1} were dropped while away`, 'warn');
    job.ev.splice(0, Math.max(0, from - job.evBase));
    job.evBase = Math.max(job.evBase, from);
    job.sent = job.evBase;
    job.ctl = job.ctl.filter((c) => c.upto >= from);
    job.ctlSent = 0;
    job.attached = true;
    job.detachedAt = 0;
    log(`job ${job.id} re-attached (events from ${from})`);
    flushJob(job);
  }
  // The controller reassigns a job whose node stayed away past the grace period, so such a job pushes nothing more
  // until the controller re-attaches it (or cancels it): its branch may belong to the new run by now.
  const pastGrace = (job) => !job.attached && job.detachedAt && Date.now() - job.detachedAt > graceMs;

  // ---- the head's agent sign-ins (agent.credential, agent-share.mjs): nothing to sign in on this machine.
  // claude: the head's long-lived token, as CLAUDE_CODE_OAUTH_TOKEN for every Claude this worker starts (runs, the
  //         sign-in check, model and limit reads). Memory only: the head sends it again on every connect.
  // codex:  the head's ~/.codex/auth.json, written to this account's ~/.codex/auth.json (0600). Codex refreshes it now
  //         and then; a refresh made here goes back to the head, which keeps the newest and re-shares it.
  const codexAuthFile = path.join(os.homedir(), '.codex', 'auth.json');
  let codexShared = null; // the text last taken from, or sent back to, the head
  const readCodexAuth = () => { try { return fs.readFileSync(codexAuthFile, 'utf8'); } catch { return null; } };
  function applyCredential(msg) {
    if (msg.agent === 'claude') {
      if (msg.value) process.env.CLAUDE_CODE_OAUTH_TOKEN = msg.value;
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      log(msg.value ? "Claude: using the head's shared account" : 'Claude: the head stopped sharing its account');
    } else if (msg.agent === 'codex') {
      if (msg.value) {
        if (readCodexAuth() !== msg.value) {
          fs.mkdirSync(path.dirname(codexAuthFile), { recursive: true, mode: 0o700 });
          const tmp = `${codexAuthFile}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, msg.value, { mode: 0o600 });
          fs.renameSync(tmp, codexAuthFile);
        }
        codexShared = msg.value;
        log("Codex: using the head's sign-in");
      } else {
        // The head signed out: drop the copy it gave us (a sign-in made here by hand is left alone).
        if (codexShared && readCodexAuth() === codexShared) fs.rmSync(codexAuthFile, { force: true });
        codexShared = null;
        log('Codex: the head stopped sharing its sign-in');
      }
    }
    clearLoginCache();
    sendInventory();
    // Its models were read (or not, signed out) before this sign-in: read them again, then report.
    models.refresh([msg.agent]).catch(() => {}).then(() => sendInventory());
  }
  // Codex rewrote the shared file (a token refresh): the same account, newer → back to the head.
  function checkCodexRefresh() {
    if (!codexShared) return;
    const now = readCodexAuth();
    if (!now || now === codexShared) return;
    const mine = parseCodexAuth(now), was = parseCodexAuth(codexShared);
    if (!mine || !was || mine.accountId !== was.accountId || mine.lastRefresh <= was.lastRefresh) return;
    if (raw(MSG.AGENT_CREDENTIAL, { agent: 'codex', value: now })) { codexShared = now; log('Codex refreshed its sign-in here: sent the new one to the head'); }
  }
  const credWatch = setInterval(checkCodexRefresh, Number(process.env.AGENT_ORCH_CRED_WATCH_MS) || 10_000);
  credWatch.unref?.();

  // ---- inventory and resources
  async function inventory() {
    const agents = await Promise.all(Object.values(AGENTS).map(async (a) => {
      const installed = !!a.available(), signedIn = installed && !!a.loggedIn();
      const version = installed ? await readVersion(a.id).catch(() => null) : null;
      const cat = modelCatalog(a.id);
      // shared: signed in with the head's sign-in (agent.credential), not one made on this machine.
      const shared = a.id === 'claude' ? !!process.env.CLAUDE_CODE_OAUTH_TOKEN : !!codexShared && readCodexAuth() === codexShared;
      return { id: a.id, installed, version, signedIn, shared, account: signedIn ? agentAccount(a.id) : null, models: cat.models, modelsError: cat.error };
    }));
    let gitVersion = null;
    try { gitVersion = /\d+\.\d+[\w.]*/.exec(await git(home, ['--version']))?.[0] || null; } catch {}
    const synced = ext.synced();
    return {
      node: config.node, name: config.name || os.hostname(), os: process.platform, arch: process.arch, cores: os.cpus().length, mem: os.totalmem(),
      agents, limits: Object.fromEntries(ids.map((id) => [id, limits.get(id)]).filter(([, v]) => v)),
      versions: { agentOrch: VERSION, node: process.version, git: gitVersion }, cap, ...(browser && { browser }),
      ext: { hash: synced.hash, ...(extError ? { error: extError } : {}), ...(synced.kept.length ? { kept: synced.kept } : {}) },
    };
  }

  // ---- extensions: fetched from the controller (GET EXT_PATH, its bearer token) when its hash (ext.sync,
  // job.start.ext) isn't the one applied here. A caller waits for a fetch in flight and does at most one of its own, so
  // a bundle that changes again meanwhile can't keep it looping; the newest one wins either way. Logs carry names and
  // counts only: the bundle holds the MCP servers' secrets.
  async function fetchExt() {
    const r = await fetch(new URL(EXT_PATH, config.controller), { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`the controller answered HTTP ${r.status}`);
    const chunks = [];
    let n = 0;
    for await (const c of r.body) {
      if ((n += c.length) > EXT_MAX_BODY) throw new Error(`the bundle is over ${EXT_MAX_BODY >> 20} MB`);
      chunks.push(c);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('the bundle is not JSON'); } // (the parse error quotes the text)
  }
  async function applyExt() {
    try {
      const b = await fetchExt(), r = ext.applyBundle(b);
      extError = null;
      log(`extensions ${r.hash.slice(0, 12)} applied: ${r.skills} skills, ${r.agents} subagents, ${r.mcp} MCP servers`
        + `${r.kept.length ? `; kept this machine's own ${r.kept.join(', ')}` : ''}${b.skipped?.length ? `; left out by the controller: ${b.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}` : ''}`);
    } catch (e) {
      extError = String(e.message || e).slice(0, 300);
      log(`extension sync failed: ${extError}`, 'warn');
      throw e;
    } finally { sendInventory(); }
  }
  async function syncExt(want) {
    if (!want || want === ext.synced().hash) return;
    if (extRun) { await extRun.catch(() => {}); if (want === ext.synced().hash) return; }
    extRun ||= applyExt().finally(() => { extRun = null; });
    return extRun;
  }
  async function probeBrowser() {
    if (BROWSER_MODE === 'off') return;
    browserAbort = new AbortController();
    const st = await ensureBrowser({ install: BROWSER_MODE === 'install', signal: browserAbort.signal }).catch((e) => ({ capable: false, error: e.message }));
    if (stopping) return;
    browser = { capable: st.capable, headed: !!st.headed, ...(st.error && { error: st.error }) };
    log(st.capable ? `browser: ${st.executable}${st.headed ? ' (headed)' : ' (headless)'}` : `browser: none (${st.error || 'no Chromium or Chrome found'})`, st.capable ? 'info' : 'warn');
    sendInventory();
  }
  let invBusy = null;
  // One inventory at a time; a change while one is being gathered (a sign-in arriving) sends another after it, so the
  // head never keeps a reading taken before the change.
  let invAgain = false;
  function sendInventory() {
    if (!live()) return invBusy;
    if (invBusy) { invAgain = true; return invBusy; }
    return invBusy = inventory().then((inv) => { lastInv = inv; return raw(MSG.INVENTORY, inv); })
      .catch((e) => { log(`inventory failed: ${e.message}`, 'warn'); nodeError('inventory', `inventory failed: ${e.message}`, { stack: e.stack }); })
      .finally(() => { invBusy = null; if (invAgain) { invAgain = false; sendInventory(); } });
  }

  // ---- health telemetry, sent with every resources frame: CPU % per core, memory, swap, disk free on the volume holding
  // the repos, GitHub's reachability, the agents as last checked (never polled: BRIEF goal 7), uptimes, version and sha,
  // and on a Mac its battery and thermal state, whether its power policy lets it take new jobs, and whether it is held awake.
  let prevCpus = null, netState = null, netAt = 0, netBusy = false, power = null, powerAt = 0, powerBusy = null;
  function probeNet() {
    if (NET_PROBE === 'off' || netBusy || Date.now() - netAt < PROBE_EVERY_MS) return;
    const [host, port = '443'] = NET_PROBE.split(':'), t0 = Date.now();
    netBusy = true;
    const sock = net.connect({ host, port: Number(port), timeout: 5000 });
    const done = (ok, error) => {
      if (!netBusy) return;
      netBusy = false;
      netAt = Date.now();
      sock.destroy();
      netState = { host, ok, ms: ok ? netAt - t0 : null, at: netAt, ...(error ? { error: String(error).slice(0, 120) } : {}) };
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, 'timed out'));
    sock.once('error', (e) => done(false, e.code || e.message));
  }
  // Resolves once `power` is at most maxAge old (a fixture is read every time).
  function probePower(maxAge = PROBE_EVERY_MS) {
    if (!POWERED) return Promise.resolve();
    if (powerBusy || (!POWER_FIXTURE && Date.now() - powerAt < maxAge)) return powerBusy || Promise.resolve();
    powerAt = Date.now();
    return powerBusy = readPower().then((p) => { power = p; syncAwake(); }, () => {}).finally(() => { powerBusy = null; });
  }
  // ---- power policy (power.mjs): intake (no new jobs on low battery or when hot) and keep-awake while jobs run. The local
  // cap's --only-on-ac comes first: on battery, no new jobs at any charge.
  function intakeNow() {
    if (!POWERED) return { ok: true };
    const b = power?.battery;
    if (cap?.onlyOnAc && b?.source === 'battery') return { ok: false, reason: 'battery', text: `On battery (${b.pct}%): this machine's local cap takes tasks only on AC power` };
    return intakeOf(policy, power);
  }
  const activeJobs = () => [...jobs.values()].filter((j) => j.state !== 'paused').length;
  // At most the head's max tasks (Auto: cores − 1 on a Mac, all cores elsewhere): slots are set on the head only.
  const maxJobs = () => policy.maxTasks ?? autoTasks(process.platform, os.cpus().length);
  function syncAwake() { awake?.set(!stopping && wantsAwake(policy, power, activeJobs())); }
  function setPolicy(p) {
    policy = { ...effectivePolicy(process.platform), ...p };
    const rules = !POWERED ? '' : `new jobs on AC power${policy.minBattery == null ? ' only' : ` or above ${policy.minBattery}% battery`}` +
      `${policy.thermal === 'off' ? '' : `, none at ${policy.thermal} thermal pressure`}; awake while jobs run: ${{ ac: 'on AC power', always: 'always', never: 'never' }[policy.keepAwake]}; `;
    const text = `${rules}at most ${maxJobs()} jobs at once, leaving ${+(Math.max(MEM.claimFloor, reserveBytes(policy)) / 1024 ** 3).toFixed(1)} GB free`;
    if (text !== policyText) log(`policy: ${text}`);
    policyText = text;
    syncAwake();
  }
  function telemetry(sys) {
    const cpu = prevCpus && cpuPercent(prevCpus, sys.cpus || []);
    prevCpus = sys.cpus;
    let disk = null;
    try { const f = fs.statfsSync(home); disk = { path: home, free: f.bavail * f.bsize, total: f.blocks * f.bsize }; } catch {}
    probeNet();
    probePower();
    return {
      ...(cpu?.length ? { cpu } : {}), memTotal: sys.memTotal ?? os.totalmem(), swapTotal: sys.swapTotal || 0, swapUsed: sys.swapTotal ? sys.swapTotal - (sys.swapFree || 0) : 0,
      ...(disk ? { disk } : {}), ...(netState ? { net: netState } : {}),
      ...(lastInv ? { agents: lastInv.agents.map(({ id, installed, version, signedIn }) => ({ id, installed, version, signedIn })) } : {}),
      uptime: Math.round(sys.uptime || os.uptime()), procUptime: Math.round(process.uptime()), version: VERSION, ...(srcSha ? { sha: srcSha } : {}),
      ...(power?.battery ? { battery: power.battery } : {}), ...(power?.thermal ? { thermal: power.thermal } : {}),
      ...(POWERED ? { intake: intakeNow(), awake: !!awake?.active() } : {}),
    };
  }
  function sendResources() {
    const sys = readSystem();
    const swapUsedPct = sys.swapTotal ? Math.round((sys.swapTotal - (sys.swapFree || 0)) / sys.swapTotal * 1000) / 10 : 0;
    raw(MSG.RESOURCES, { memAvailable: sys.memAvailable ?? os.freemem(), load: sys.load, running: [...jobs.keys()], swapUsedPct, ...telemetry(sys),
      cap, jobsMem: Math.round(use.mem), jobsCpu: use.cpu });
  }

  // ---- the local cap (cap.mjs; CLUSTER.md "Local cap"): re-read from config.json ({op: 'reload'} over the status socket,
  // sent by `node worker.mjs limit`) and applied at once: the next offer and job, the memory watch, and the head, which
  // hears it in the inventory and every resources frame.
  function reloadCap() {
    const saved = readConfig(home), next = resolveCap(saved?.cap, machine), changed = JSON.stringify(next) !== JSON.stringify(cap);
    config.cap = saved?.cap ?? null;
    cap = next;
    if (changed) {
      log(`local cap: ${cap ? capText(cap, machine) : 'none (lends everything)'}`);
      overSince = 0;
      ensureLimiter();
      sendInventory();
      sendResources();
    }
    return { ok: true, cap, text: capText(cap, machine), changed, connected: live() };
  }
  // How jobs are held to a CPU/RAM cap here, probed once one is set (a systemd scope per job on Linux, else nice).
  function ensureLimiter() {
    if (limiter || limiterBusy || (cap?.cpu == null && cap?.mem == null)) return limiterBusy;
    return limiterBusy = probeLimiter().then((m) => { limiter = m; log(`the local cap holds jobs with ${heldBy(m, cap)}`); }, () => { limiter = 'nice'; })
      .finally(() => { limiterBusy = null; });
  }
  // What the running jobs use (their process trees, from the pids their wrappers recorded), at most USAGE_MS old.
  function sampleUsage() {
    if (sampling) return sampling;
    if (!jobs.size) { use = { at: Date.now(), cpu: 0, mem: 0, jobs: new Map() }; overSince = 0; return Promise.resolve(use); }
    return sampling = usage.sample(new Map([...jobs.keys()].map((id) => [id, wrappers.pids(id)])))
      .then((u) => { use = u; memWatch(); return u; }, () => use).finally(() => { sampling = null; });
  }
  const usageNow = () => (Date.now() - use.at < USAGE_MS ? Promise.resolve(use) : sampleUsage());
  const sampler = setInterval(() => { if (jobs.size || use.mem) sampleUsage(); }, USAGE_MS);
  // The memory watch: the jobs together over the RAM cap for CAP_PAUSE_MS → the newest running one stops, pushes its WIP
  // and goes back to the head as aborted (it requeues and resumes its session, like the controller's memGuard); it isn't
  // taken back here for CAP_DECLINE_MS. Another pause needs another full stretch over the cap.
  function memWatch() {
    if (cap?.mem == null || use.mem <= cap.mem) { overSince = 0; return; }
    overSince ||= Date.now();
    if (Date.now() - overSince < CAP_PAUSE_MS) return;
    const job = [...jobs.values()].filter((j) => ['running', 'checking'].includes(j.state) && !j.stop).sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!job) return;
    overSince = Date.now();
    capPaused.set(job.id, Date.now() + CAP_DECLINE_MS);
    const text = `paused by ${config.name || 'this machine'}'s local cap: its jobs used ${fmtGB(use.mem)} of ${fmtGB(cap.mem)} RAM for ${Math.round(CAP_PAUSE_MS / 1000)} s; it continues later`;
    log(`job ${job.id} ${text}`, 'warn');
    job.stop = { kind: 'cap', text };
    job.ac?.abort();
  }
  // Why taking the offered job would go over the local cap (the reject reason), or null.
  async function capCheck(msg) {
    const paused = capPaused.get(msg.job) > Date.now();
    if (!cap && !paused) return null;
    const u = await usageNow();
    const over = paused ? { kind: 'memory', text: `it was paused here for the local RAM cap less than ${CAP_DECLINE_MS / 60_000} min ago` }
      : capRejection(cap, { jobs: activeJobs(), jobsMem: u.mem, footprint: msg.footprint || FOOTPRINT[msg.agent] || FOOTPRINT.claude });
    if (!over) return null;
    log(`declined job ${msg.job}: ${over.text} (node worker.mjs limit)`);
    return peer.has('cap') ? 'cap' : over.kind === 'memory' ? 'low_memory' : 'busy';
  }
  // The finished jobs the status view lists (outcome, how long this run of it took).
  function remember(job, outcome) {
    recent.push({ id: job.id, title: job.spec.title, outcome, ms: Date.now() - job.startedAt, at: Date.now() });
    if (recent.length > RECENT) recent.shift();
  }

  // ---- the status view's snapshot ({op: 'status'} on the status socket; worker-status.mjs draws it)
  function connState(t) {
    if (stopping) return { state: 'stopping', since: t };
    if (live()) return { state: 'connected', since: connectedAt };
    const refused = REFUSED_RE.test(connError || '');
    return { state: !refused && t - downSince < graceMs ? 'reconnecting' : 'offline', since: downSince, retryAt: reconnectTimer ? retryAt : null, error: connError };
  }
  function snapshot() {
    const t = Date.now();
    return {
      ok: true, at: t, name: config.name || os.hostname(), node: config.node, controller: config.controller, version: VERSION, pid: process.pid, os: process.platform,
      machine, connection: connState(t), cap, limiter: heldBy(limiter || 'off', cap),
      usage: { cpu: use.cpu, mem: use.mem, at: use.at }, slots: Math.min(maxJobs(), capTasks(cap)), intake: intakeNow(),
      draining: stopping ? 'the worker is stopping' : updating ? 'it is updating itself' : null,
      jobs: [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt).map((j) => ({
        id: j.id, title: j.spec.title, agent: j.spec.agent, model: j.spec.model || null, state: j.state, phase: j.phase?.name || null, startedAt: j.startedAt,
        activity: j.activity || null, activityAt: j.activityAt || null, cpu: use.jobs.get(j.id)?.cpu ?? null, mem: use.jobs.get(j.id)?.mem ?? null,
      })),
      queued: live() ? queued : null, finished: [...recent].reverse(),
    };
  }
  function answer(req) {
    switch (req?.op) {
      case 'ping': return { ok: true, pid: process.pid };
      case 'status': return snapshot();
      case 'reload': return reloadCap();
      default: return { ok: false, error: `unknown request ${JSON.stringify(req?.op ?? null)} (status, reload)` };
    }
  }

  // ---- connection: dial out, hello, reconnect with backoff forever
  const REFUSED_RE = /refused this node token|disabled this machine/; // the head turned this machine away (401/403)
  function wsUrl() {
    const u = new URL(WS_PATH, config.controller);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.href;
  }
  function connect() {
    if (stopping) return;
    reconnectTimer = null;
    const sock = new WebSocket(wsUrl(), { headers: { authorization: `Bearer ${config.token}` }, maxPayload: MAX_FRAME, handshakeTimeout: 15_000 });
    ws = sock;
    welcomed = false;
    sock.on('open', () => {
      connectedAt = lastFrame = Date.now();
      send = createSender('w');
      log(`connected to ${config.controller}`);
      // Every job still here (finished ones whose job.done wasn't acked too): the controller attaches or cancels each.
      sock.send(send(MSG.HELLO, { node: config.node, protocol: PROTOCOL_VERSION, version: VERSION, ...(srcSha ? { sha: srcSha } : {}), features: FEATURE_LIST,
        jobs: allJobs().map((j) => ({ job: j.id, state: held.has(j.id) ? 'done' : j.state, next: evEnd(j), ...(j.pushed ? { sha: j.pushed } : {}) })) }));
    });
    sock.on('unexpected-response', (_req, res) => {
      connError = res.statusCode === 401 ? 'the controller refused this node token (revoked?): pair again'
        : res.statusCode === 403 ? 'the owner disabled this machine on the controller (Machines → Enable lets it back in)' : `connection refused: HTTP ${res.statusCode}`;
      log(connError, 'warn');
      sock.terminate();
    });
    sock.on('message', (data, isBinary) => {
      if (ws !== sock) return;
      lastFrame = Date.now();
      const { msg, error, refused } = decode(isBinary ? null : data.toString('utf8'), { from: 'c', accept: WORKER_ACCEPTS });
      if (refused != null) return reject(refused);
      if (error) { log(`bad frame from the controller: ${error}`, 'warn'); return raw(MSG.ERROR, { message: error }); }
      handle(msg).catch((e) => {
        log(`handling ${msg.t} failed: ${e.stack || e.message}`, 'error');
        nodeError('exception', `handling ${msg.t} failed: ${e.message}`, { stack: e.stack });
      });
    });
    sock.on('error', (e) => { if (!REFUSED_RE.test(connError || '')) connError = `connection error: ${e.message}`; log(`connection error: ${e.message}`, 'warn'); });
    sock.on('close', (code, reason) => {
      if (ws !== sock) return;
      ws = null; welcomed = false;
      clearInterval(beat); beat = null;
      for (const j of allJobs()) if (j.attached) { j.attached = false; j.detachedAt = Date.now(); }
      screens?.release(); // nobody watches any more, and no take-over outlives its viewer
      if (connectedAt) { log(`disconnected (${code}${reason?.length ? ` ${reason}` : ''})`); downSince = Date.now(); connError ??= code === 4003 ? `the controller ${reason?.length ? reason : 'revoked'} this machine` : `disconnected (${code})`; }
      if (connectedAt && Date.now() - connectedAt > 60_000) attempt = 0;
      connectedAt = 0;
      if (stopping) return;
      const delay = Math.min(BACKOFF_MAX_MS, backoffMs(attempt++));
      retryAt = Date.now() + delay;
      reconnectTimer = setTimeout(connect, delay);
    });
  }

  function onWelcome(msg) {
    heartbeatMs = msg.heartbeatMs || HEARTBEAT_MS;
    wipPushMs = msg.wipPushMs || WIP_PUSH_MS;
    graceMs = msg.graceMs || graceMs;
    peer = new Set(Array.isArray(msg.features) ? msg.features : []);
    welcomed = true;
    connError = null;
    queued = Number.isSafeInteger(msg.queued) ? msg.queued : null;
    log(`welcomed as ${msg.node}`);
    if (msg.policy) setPolicy(msg.policy);
    clearInterval(beat);
    // Resources every heartbeat (any frame counts as one); a controller silent for HEARTBEAT_MISSES beats is gone.
    beat = setInterval(() => {
      if (Date.now() - lastFrame > heartbeatMs * HEARTBEAT_MISSES) { log('controller went silent; reconnecting', 'warn'); return ws?.terminate(); }
      sendResources();
      try { ws?.ping(); } catch {}
    }, heartbeatMs);
    // The wake first: the controller excuses the lost connection before it weighs this one's health.
    if (pendingWake) { raw(MSG.WAKE, pendingWake); pendingWake = null; }
    sendInventory();
    sendResources();
  }

  // Sleep/wake: a clock tick that fires far too late means the machine was suspended. The socket is dead by then
  // (the controller saw the node go quiet), so reconnect now instead of waiting out the missed heartbeats.
  let lastTick = Date.now();
  const clock = setInterval(() => {
    const t = Date.now(), slept = sleptFor(t - lastTick, CLOCK_MS, SLEEP_MS);
    if (slept) {
      log(`woke up after ${Math.round(slept / 1000)} s asleep`);
      pendingWake = { sleptAt: lastTick, sleptMs: Math.round(slept) };
      attempt = 0;
      if (ws) ws.terminate();
      else if (reconnectTimer) { clearTimeout(reconnectTimer); connect(); }
    }
    lastTick = t;
  }, CLOCK_MS);

  async function handle(msg) {
    switch (msg.t) {
      case MSG.WELCOME: return onWelcome(msg);
      case MSG.HEARTBEAT: if (Number.isSafeInteger(msg.queued)) queued = msg.queued; return;
      case MSG.ACK: { // the controller has a finished job's job.done: nothing of it is left to replay
        const j = msg.job != null && held.get(msg.job);
        if (j && j.ctl.some((c) => c.t === MSG.JOB_DONE && c.seqSent)) held.delete(msg.job);
        return;
      }
      case MSG.JOB_ATTACH: return attachJob(msg);
      case MSG.ERROR: return log(`controller error: ${msg.message}`, 'warn');
      case MSG.BYE: log(`controller said bye (${msg.reason || 'no reason'})`); return ws?.close(1000, 'bye');
      case MSG.JOB_OFFER: {
        const reason = await offerRejection(msg);
        return reason ? raw(MSG.JOB_REJECT, { job: msg.job, reason }) : raw(MSG.JOB_ACCEPT, { job: msg.job });
      }
      case MSG.JOB_START: return startJob(msg);
      case MSG.JOB_APPROVAL: return jobs.get(msg.job)?.gate?.answer(msg);
      case MSG.JOB_CANCEL: return stopJob(msg.job, 'cancel', msg.reason);
      case MSG.JOB_PAUSE: return stopJob(msg.job, 'pause');
      case MSG.JOB_RESUME: return resumeJob(msg);
      case MSG.GIT_CREDENTIAL: gitCreds.set(msg.host, msg.token); return log(`received a git credential for ${msg.host}`);
      case MSG.AGENT_CREDENTIAL: return applyCredential(msg);
      case MSG.EXT_SYNC: return syncExt(msg.hash).catch(() => {}); // logged and reported in the inventory; a job retries it
      case MSG.MODELS_REFRESH: {
        clearLoginCache();
        await models.refresh([msg.agent]);
        sendInventory();
        const c = modelCatalog(msg.agent);
        return raw(MSG.MODELS, { agent: msg.agent, models: c.models, ...(c.error ? { error: c.error } : {}) });
      }
      case MSG.LIMITS_REFRESH: {
        await limits.refresh([msg.agent]);
        const l = limits.get(msg.agent);
        raw(MSG.LIMITS, { agent: msg.agent, windows: l?.windows || [], ...(l?.error ? { error: l.error } : {}) });
        return sendInventory();
      }
      case MSG.LOGIN_START: case MSG.LOGIN_CODE: case MSG.LOGIN_CANCEL: case MSG.LOGIN_LOGOUT: return logins.handle(msg);
      case MSG.LOGS_TAIL: return raw(MSG.LOGS, { req: msg.req, lines: tailLines(logFile(home), Math.max(1, Math.min(2000, msg.lines))) });
      case MSG.NODE_UPDATE: return selfUpdate(msg);
      case MSG.NODE_POLICY: setPolicy(msg.policy); return sendResources(); // the controller sees the new intake at once
      case MSG.SCREEN_REQ: return screenReq(msg);
      case MSG.SCREEN_INPUT: return screens?.input(msg.identity, msg.events);
      default: return reject(msg.t); // allow-listed but not handled here: still never acted on
    }
  }

  // Declined while stopping or updating, without the agent or its sign-in, at the task cap, over the local cap (its task
  // count, CPU or RAM: capCheck), when the job would leave less free memory than the claim floor or the policy's reserve
  // for the owner, or while the power policy pauses intake (checked on a reading at most 15 s old).
  async function offerRejection(msg) {
    if (stopping || updating) return 'draining';
    const st = agentStatus(msg.agent);
    if (st === 'not installed' || st === 'unknown agent') return 'agent_missing';
    if (st !== true) return 'not_signed_in';
    if (activeJobs() >= maxJobs()) return 'busy';
    const over = await capCheck(msg);
    if (over) return over;
    const avail = readSystem().memAvailable ?? os.freemem();
    if (avail - (msg.footprint || 0) < Math.max(MEM.claimFloor, reserveBytes(policy))) return 'low_memory';
    await probePower(15_000);
    if (!intakeNow().ok) return peer.has('policy') ? 'power' : 'busy';
    return null;
  }

  // ---- jobs
  const gitAuthEnv = (repo) => {
    const host = /^https:\/\/([^/:]+)/.exec(repo)?.[1], token = host && gitCreds.get(host);
    if (!token) return {};
    // The owner-authorised token (git.credential) via a one-off credential helper: never in a URL, a file or a log.
    return { AO_GIT_TOKEN: token, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '!f() { echo username=x-access-token; echo "password=$AO_GIT_TOKEN"; }; f' };
  };

  // What a job's agent and check run with: the reaper's owner tag, and JOB_ENV, so a server.mjs they start (the project's
  // own tests or screenshots, when the project is agent-orch) is a throwaway instance, not a head (role.mjs).
  const jobEnv = (job) => ({ ...withOwner(process.env, 'task', job.id), [JOB_ENV]: String(job.id) });

  // Bare cache clone (blob-less), fetched before each job; remote branches land in refs/remotes/origin/*.
  const cacheDir = (repo) => path.join(dirs.repos, `${cacheName(repo)}.git`);
  async function ensureCache(repo) {
    const dir = cacheDir(repo), env = gitAuthEnv(repo);
    if (!fs.existsSync(path.join(dir, 'HEAD'))) {
      fs.rmSync(dir, { recursive: true, force: true });
      await git(dirs.repos, ['clone', '--bare', '--filter=blob:none', '-q', repo, dir], { env });
      await git(dir, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
      fs.appendFileSync(path.join(dir, 'info', 'exclude'), '\nnode_modules\n');
    }
    await git(dir, ['remote', 'set-url', 'origin', repo]);
    await git(dir, ['fetch', '-q', '--prune', 'origin'], { env });
    const now = new Date();
    try { fs.utimesSync(dir, now, now); } catch {}
    return dir;
  }

  const newJob = (spec) => ({
    id: spec.job, spec, state: 'setup', ac: null, ev: [], evBase: 0, sent: 0, ctl: [], ctlSent: 0, attached: true, detachedAt: 0,
    startedAt: Date.now(), activity: null, activityAt: 0,
    phase: null, progress: { tools: 0, files: new Set(), last: '' }, progressSig: '', progressAt: 0,
    cache: null, env: isBrowserTask(spec) ? {} : gitAuthEnv(spec.repo),
    dir: isBrowserTask(spec) ? path.join(home, 'browser-tasks', String(spec.job)) : path.join(dirs.worktrees, `${cacheName(spec.repo).split('__').pop()}-task-${spec.job}`),
    sessionId: spec.resume || null, pushed: null, remoteStart: null, stop: null, lock: Promise.resolve(),
  });

  async function startJob(spec) {
    if (jobs.has(spec.job)) return raw(MSG.ERROR, { message: `job ${spec.job} is already on this worker`, job: spec.job });
    const job = newJob(spec);
    jobs.set(job.id, job);
    finished.delete(job.id);
    held.delete(job.id);
    syncAwake();
    log(`job ${job.id} start: ${spec.title} (${spec.agent}${spec.model ? `/${spec.model}` : ''})`);
    setPhase(job, 'queued');
    if (!(await setup(job))) return;
    if (await stopped(job)) return; // paused or cancelled during setup
    await runTurn(job, spec.prompt, spec.resume || null);
  }

  // The controller's extensions (job.start.ext) → cache fetch → worktree on agent-orch/task-<id> (from the pushed branch
  // when it exists, else baseSha) → install.
  async function setup(job) {
    const { spec } = job, branch = taskBranch(job.id);
    job.state = 'setup';
    try {
      await syncExt(spec.ext).catch((e) => { throw new Error(`could not get the controller's skills and MCP servers: ${e.message}`); });
      if (isBrowserTask(spec)) { fs.mkdirSync(job.dir, { recursive: true }); return true; }
      setPhase(job, fs.existsSync(path.join(cacheDir(spec.repo), 'HEAD')) ? 'fetching' : 'cloning');
      job.cache = await ensureCache(spec.repo);
      const remote = `refs/remotes/origin/${branch}`;
      job.remoteStart = (await gitOk(job.cache, ['rev-parse', '--verify', '-q', remote])) ? (await git(job.cache, ['rev-parse', remote])).trim() : '';
      if (fs.existsSync(path.join(job.dir, '.git'))) {
        await git(job.dir, ['checkout', '-q', branch]);
      } else {
        await git(job.cache, ['worktree', 'prune']);
        fs.rmSync(job.dir, { recursive: true, force: true });
        const start = job.remoteStart || spec.baseSha;
        if (!job.remoteStart && !(await gitOk(job.cache, ['cat-file', '-e', `${spec.baseSha}^{commit}`]))) {
          await git(job.cache, ['fetch', '-q', 'origin', spec.baseSha], { env: job.env });
        }
        await git(job.cache, ['worktree', 'add', '-q', '-f', '-B', branch, job.dir, start]);
      }
      job.pushed ??= job.remoteStart || null;
      await install(job);
      return true;
    } catch (e) {
      const text = `setup failed: ${String(e.stderr || e.message || e).trim().split('\n').slice(-5).join('\n')}`;
      // An install names its own failure; a git error's reason is its stderr's last line.
      const install = job.phase?.name === 'installing';
      jobError(job, install ? 'install_failed' : 'setup_failed', (!install && String(e.stderr || '').trim().split('\n').pop()) || firstLine(e),
        { stack: e.stderr ? undefined : e.stack, stderr: e.stderr });
      await dropWorktree(job);
      jobs.delete(job.id);
      held.set(job.id, job);
      wrappers.drop(job.id);
      remember(job, 'setup_failed');
      setPhase(job, 'done', { outcome: 'setup_failed' });
      emit(job, MSG.JOB_DONE, { job: job.id, outcome: 'setup_failed', text });
      return false;
    }
  }

  // job.start.install (the controller's choice) or, by default, `npm ci` / `npm install` when package.json exists.
  // An `npm ci` result is kept per lockfile hash (deps/<hash>) and symlinked into later worktrees with the same lockfile.
  async function install(job) {
    const { spec, dir } = job;
    const lock = path.join(dir, 'package-lock.json');
    const argv = spec.install ?? (fs.existsSync(path.join(dir, 'package.json')) ? ['npm', fs.existsSync(lock) ? 'ci' : 'install'] : null);
    if (!argv?.length) return;
    setPhase(job, 'installing');
    const nm = path.join(dir, 'node_modules');
    const cacheable = argv[0] === 'npm' && argv[1] === 'ci' && fs.existsSync(lock);
    const key = cacheable && crypto.createHash('sha256').update(fs.readFileSync(lock)).update(process.version).digest('hex').slice(0, 16);
    const cached = key && path.join(dirs.deps, key, 'node_modules');
    if (cached && fs.existsSync(cached) && !fs.existsSync(nm)) {
      const now = new Date();
      fs.utimesSync(path.dirname(cached), now, now); // its mtime is its last use (pruneCaches)
      fs.symlinkSync(cached, nm, 'dir');
      return;
    }
    const r = await runHelper(argv[0], argv.slice(1), {
      cwd: dir, timeoutMs: (spec.timeouts.installSec || 900) * 1000,
      env: { ...process.env, npm_config_cache: dirs.npmCache, npm_config_prefer_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' },
    });
    if (r.error || r.timedOut || r.code !== 0) {
      throw Object.assign(new Error(`${argv.join(' ')} failed: ${r.timedOut ? 'timed out' : String(r.stderr || r.error?.message || `exit ${r.code}`).trim().split('\n').slice(-3).join(' ')}`),
        { stderr: r.stderr || undefined });
    }
    if (cached && fs.existsSync(nm) && !fs.lstatSync(nm).isSymbolicLink() && !fs.existsSync(cached)) {
      try { fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.renameSync(nm, cached); fs.symlinkSync(cached, nm, 'dir'); } catch (e) { log(`dependency cache failed: ${e.message}`, 'warn'); }
    }
  }

  // One agent turn, then (unless paused/cancelled) the check, the final push and job.done.
  async function runTurn(job, prompt, resume) {
    const { spec } = job;
    job.state = 'running';
    setPhase(job, 'running');
    job.ac = new AbortController();
    // A browser run's calls go through the approval gate (gate.mjs); time held on the owner doesn't count to the timeout.
    const gate = needsBrowser(spec) ? (job.gate = openGate(job)) : null;
    const due = Date.now() + (spec.timeouts.taskSec || 3 * 3600) * 1000;
    const fire = () => {
      const left = due + (gate?.heldMs() || 0) - Date.now();
      if (gate && (left > 0 || gate.pending())) { kill = setTimeout(fire, Math.max(60_000, left)); return; }
      job.stop = { kind: 'timeout' }; job.ac.abort();
    };
    let kill = setTimeout(fire, due - Date.now());
    const wip = setInterval(() => pushWip(job).catch(() => {}), wipPushMs);
    let res;
    try {
      // The agent CLI runs through its wrapper: under the local cap, with its pid recorded for the usage sampler.
      const bin = wrappers.wrap(job.id, spec.agent, [AGENTS[spec.agent]?.bin || spec.agent]);
      const run = needsBrowser(spec) ? { browser: { identity: normIdentity(spec.identity), outputDir: path.join(job.dir, '.agent-orch', 'shots') }, gate: gate.spec } : null;
      res = await runAgentCli({
        agent: spec.agent, model: spec.model || undefined, effort: spec.effort || undefined, prompt, cwd: job.dir, resume: resume || undefined, systemAppend: spec.systemAppend || undefined,
        // The synced MCP servers as 0600 files (Claude's --mcp-config, codex -p): never on the command line.
        mcp: ext.mcpRun(spec.agent),
        autonomous: spec.autonomous ?? true, signal: job.ac.signal, onEvent: (e) => pushEvent(job, e), bin,
        env: jobEnv(job), onSpawn: ({ pid, pgid }) => registerPid({ pid, pgid, kind: 'task', id: job.id }),
        ...(run && { mcp: ext.mcpRun(spec.agent, run), gate: gate.spec }),
      });
    } catch (e) {
      res = { outcome: 'error', text: `agent crashed: ${e?.message || e}` };
      jobError(job, 'agent_crash', res.text, { stack: e?.stack });
    } finally { clearTimeout(kill); clearInterval(wip); gate?.close(); job.gate = null; }
    if (res.sessionId) job.sessionId = res.sessionId;
    log(`job ${job.id} agent turn ended: ${res.outcome}`);
    if (await stopped(job)) return;
    // The agent's process failed (not a limit, a sign-in or a stop): its stderr tells why.
    if (res.outcome === 'error' && !/^agent crashed:/.test(res.text || '')) {
      jobError(job, 'agent_crash', firstLine(res.text) || `${spec.agent} exited with an error`, { stderr: res.stderr });
    }
    if (job.stop?.kind === 'timeout') res.outcome = 'timeout';
    if (job.stop?.kind === 'cap') res = { ...res, outcome: 'aborted', text: job.stop.text };
    await finish(job, res);
  }

  // The approval gate of a browser job (gate.mjs): the proxy's held calls go to the head as `approval` events (after the
  // screenshot as an `image` event, same sha256 id) and its log lines as `audit` events; the head's job.approval answers.
  // Without a head that reads them (feature 'approvals'), held calls are denied at once.
  function openGate(job) {
    const dir = path.join(home, 'gate', `job-${job.id}`), g = job.spec.gate || {};
    fs.rmSync(dir, { recursive: true, force: true });
    const waiters = new Map(), sent = new Set();
    let held = 0;
    const image = (id) => {
      if (!MEDIA_ID_RE.test(id || '') || sent.has(id)) return; // a content hash, never a path (both files are the run's)
      sent.add(id);
      try {
        const data = fs.readFileSync(path.join(dir, 'shots', id)).toString('base64');
        pushEvent(job, { k: 'image', tool: 'gate', mediaType: id.endsWith('.png') ? 'image/png' : id.endsWith('.webp') ? 'image/webp' : 'image/jpeg', data });
      } catch {}
    };
    const stop = hostGate(dir, {
      onRequest: (a) => {
        if (!peer.has('approvals')) return { decision: 'deny', reason: 'the head runs an agent-orch too old to ask the owner, so outbound actions are refused' };
        image(a.screenshot);
        pushEvent(job, { k: 'approval', approval: a });
        flushJob(job);
        const at = Date.now();
        return new Promise((resolve) => waiters.set(String(a.id), (ans) => { held += Date.now() - at; resolve(ans); }));
      },
      onAudit: (e) => { image(e.screenshot); pushEvent(job, { k: 'audit', entry: e }); },
    });
    const ttlMs = Number(g.ttlMs) > 0 ? Number(g.ttlMs) : APPROVAL_TTL_MS;
    return {
      spec: { dir, task: job.id, patterns: patternsWith(g.patterns), ttlMs, hook: false },
      answer: (msg) => { const w = waiters.get(msg.id); if (!w) return; waiters.delete(msg.id); w({ decision: msg.decision, reason: msg.reason, by: msg.by }); },
      pending: () => waiters.size,
      heldMs: () => held,
      close: () => { stop(); for (const w of waiters.values()) w({ decision: 'deny', reason: 'the run ended' }); waiters.clear(); fs.rm(dir, { recursive: true, force: true }, () => {}); },
    };
  }

  // A pause/cancel that landed while the agent (or the check) ran: pause keeps the worktree, cancel drops it. A timeout or
  // the memory watch's pause (kind 'cap') ends the job as usual instead: its WIP is pushed and job.done says why.
  async function stopped(job) {
    const s = job.stop;
    if (!s || s.kind === 'timeout' || s.kind === 'cap') return false;
    if (s.kind === 'pause') {
      job.state = 'paused';
      await pushWip(job).catch((e) => log(`job ${job.id} WIP push on pause failed: ${e.message}`, 'warn'));
      log(`job ${job.id} paused`);
      return true;
    }
    if (s.reason !== 'reassigned' && s.reason !== 'disabled') await pushWip(job).catch((e) => log(`job ${job.id} WIP push on cancel failed: ${e.message}`, 'warn'));
    await dropWorktree(job);
    jobs.delete(job.id);
    wrappers.drop(job.id);
    remember(job, 'cancelled');
    log(`job ${job.id} cancelled${s.reason ? ` (${s.reason})` : ''}`);
    return true;
  }

  async function finish(job, res) {
    const { spec } = job;
    const command = !isBrowserTask(spec) && res.outcome === 'ok' ? extractCommand(spec.doneWhen) : null;
    if (command) {
      job.state = 'checking';
      setPhase(job, 'checking');
      let [pass, output, code] = [false, '', null];
      try { [pass, output, code] = await runCheck(command, job.dir, jobEnv(job), spec.timeouts.verifySec || 600, job.ac.signal, wrappers.wrap(job.id, 'check', ['bash'])); }
      catch (e) { output = `verification crashed: ${e?.message || e}`; jobError(job, 'check_crashed', output, { stack: e?.stack }); }
      if (await stopped(job)) return;
      if (job.stop?.kind === 'cap') res = { ...res, outcome: 'aborted', text: job.stop.text }; // stopped mid-check: no verdict
      else {
        log(`job ${job.id} check ${pass ? 'passed' : 'failed'}: ${command}`);
        emit(job, MSG.JOB_CHECK, { job: job.id, command, output: String(output).slice(-3000), pass, ...(Number.isInteger(code) ? { code } : {}) });
      }
    }
    job.state = 'pushing';
    let sha = null;
    try { sha = await pushWip(job, `agent-orch #${job.id}: ${spec.title}`, { final: true }); }
    catch (e) { log(`job ${job.id} final push gave up: ${e.message}`, 'error'); }
    if (await stopped(job)) return;
    const outcome = OUTCOMES.includes(res.outcome) ? res.outcome : 'error';
    const limitsOut = res.resetsAt || res.limitType || res.windows ? { resetsAt: res.resetsAt ?? null, limitType: res.limitType ?? null, windows: res.windows ?? null } : undefined;
    jobs.delete(job.id);
    held.set(job.id, job);
    wrappers.drop(job.id);
    remember(job, outcome);
    if (held.size > 50) held.delete(held.keys().next().value);
    setPhase(job, 'done', { outcome });
    emit(job, MSG.JOB_DONE, {
      job: job.id, outcome, text: String(res.text || ''), usage: res.usage || {}, ...(limitsOut ? { limits: limitsOut } : {}),
      ...(sha ? { sha } : {}), ...(job.sessionId ? { sessionId: job.sessionId } : {}),
    });
    log(`job ${job.id} done: ${outcome}${sha ? ` at ${sha.slice(0, 8)}` : ''}`);
    await dropWorktree(job);
    finished.set(job.id, { ...spec, ext: undefined, resume: job.sessionId || undefined }); // ext.sync keeps extensions current by then
    if (finished.size > 20) finished.delete(finished.keys().next().value);
  }

  // Commits everything and pushes agent-orch/task-<id> (force-with-lease against our last push), then job.wip.
  // Serialised per job. A final push retries until it lands (or the job is cancelled); a WIP push tries 3 times.
  // Past the grace period without the controller, a WIP push is skipped and a final one waits for job.attach.
  function pushWip(job, message = `agent-orch #${job.id} (wip)`, { final = false } = {}) {
    if (isBrowserTask(job.spec)) return Promise.resolve(null);
    const run = job.lock.then(async () => {
      if (!fs.existsSync(job.dir)) return job.pushed;
      if (pastGrace(job)) {
        if (!final) return job.pushed;
        log(`job ${job.id} finished while the controller was away past the grace period; waiting to push`);
        while (pastGrace(job) && job.stop?.kind !== 'cancel') await new Promise((r) => setTimeout(r, 500));
        if (job.stop?.kind === 'cancel') throw new Error('cancelled');
      }
      if (final) setPhase(job, 'committing');
      await commitAll(job.dir, message);
      const sha = (await git(job.dir, ['rev-parse', 'HEAD'])).trim();
      if (sha === job.pushed) return sha;
      const branch = taskBranch(job.id);
      if (final) setPhase(job, 'pushing');
      for (let i = 0; ; i++) {
        try {
          await git(job.dir, [...GIT_ID, 'push', '-q', `--force-with-lease=refs/heads/${branch}:${job.pushed || ''}`, 'origin', `HEAD:refs/heads/${branch}`], { env: job.env });
          break;
        } catch (e) {
          const why = String(e.stderr || e.message).trim().split('\n').pop();
          jobError(job, 'push_failed', `push of ${branch} failed: ${why}`, { stderr: e.stderr });
          if ((!final && i >= 2) || job.stop?.kind === 'cancel') throw new Error(why);
          await new Promise((r) => setTimeout(r, backoffMs(i)));
        }
      }
      job.pushed = sha;
      emit(job, MSG.JOB_WIP, { job: job.id, sha, branch });
      return sha;
    });
    job.lock = run.catch(() => {});
    return run;
  }

  async function dropWorktree(job) {
    if (!job.cache) return;
    await gitOk(job.cache, ['worktree', 'remove', '--force', job.dir]);
    fs.rmSync(job.dir, { recursive: true, force: true });
    await gitOk(job.cache, ['worktree', 'prune']);
    await gitOk(job.cache, ['branch', '-D', taskBranch(job.id)]);
    await pruneCaches().catch((e) => log(`cache prune failed: ${e.message}`, 'warn'));
  }

  // Disk hygiene: drop deps/<hash> installs no worktree's node_modules links to that are unused for DEPS_TTL_MS, and
  // npm-cache/ once it outgrows NPM_CACHE_MAX (not while a job installs: its npm may be using it).
  let pruning = null;
  function pruneCaches() {
    return (pruning ??= (async () => {
      const used = new Set();
      for (const name of await fs.promises.readdir(dirs.worktrees).catch(() => [])) {
        const target = await fs.promises.readlink(path.join(dirs.worktrees, name, 'node_modules')).catch(() => null);
        if (target) used.add(path.dirname(path.resolve(dirs.worktrees, name, target)));
      }
      for (const name of await fs.promises.readdir(dirs.deps)) {
        const dir = path.join(dirs.deps, name);
        const st = await fs.promises.stat(dir).catch(() => null);
        if (!st || used.has(dir) || Date.now() - st.mtimeMs <= DEPS_TTL_MS) continue;
        await fs.promises.rm(dir, { recursive: true, force: true });
        log(`pruned unused dependency cache deps/${name}`);
      }
      if ([...jobs.values()].some((j) => j.phase?.name === 'installing')) return;
      const size = await dirSize(dirs.npmCache, NPM_CACHE_MAX);
      if (size > NPM_CACHE_MAX) {
        await fs.promises.rm(dirs.npmCache, { recursive: true, force: true });
        fs.mkdirSync(dirs.npmCache, { recursive: true });
        log(`removed npm-cache/ (over ${fmtGB(NPM_CACHE_MAX)})`);
      }
    })().finally(() => { pruning = null; }));
  }

  async function stopJob(id, kind, reason) {
    const job = jobs.get(id);
    if (!job && kind === 'cancel' && held.delete(id)) return log(`job ${id} dropped (${reason || 'cancelled'})`); // finished; the controller doesn't want it
    if (!job) return raw(MSG.ERROR, { message: `job ${id} is not on this worker`, job: id });
    job.attached = true; job.detachedAt = 0; // the controller spoke about it: frames flow again
    if (kind === 'pause' && job.state === 'paused') return;
    job.stop = { kind, reason };
    if (job.state === 'running' || job.state === 'checking') return job.ac?.abort();
    if (job.state === 'paused') await stopped(job); // nothing running: cancel now (setup and pushing see job.stop when they end)
  }

  async function resumeJob(msg) {
    let job = jobs.get(msg.job);
    if (job && job.state !== 'paused') return raw(MSG.ERROR, { message: `job ${msg.job} is ${job.state}, not paused`, job: msg.job });
    if (!job) {
      const spec = finished.get(msg.job);
      if (!spec) return raw(MSG.ERROR, { message: `job ${msg.job} is not on this worker`, job: msg.job });
      job = newJob(spec);
      jobs.set(job.id, job);
      finished.delete(job.id);
      held.delete(job.id);
      setPhase(job, 'queued');
      if (!(await setup(job))) return;
    }
    job.stop = null;
    log(`job ${job.id} resumed`);
    await runTurn(job, msg.prompt || RESUME_PROMPT, job.sessionId);
  }

  // ---- leftovers from a previous run: push what's in stale worktrees (never forced), drop them, prune old caches
  async function sweepLeftovers() {
    for (const name of fs.readdirSync(dirs.worktrees)) {
      const dir = path.join(dirs.worktrees, name), id = Number(/-task-(\d+)$/.exec(name)?.[1]);
      if (jobs.has(id)) continue;
      try {
        if (id && fs.existsSync(path.join(dir, '.git'))) {
          await commitAll(dir, `agent-orch #${id} (wip)`);
          if (await gitOk(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${taskBranch(id)}`])) log(`pushed leftover work of job ${id}`);
          const common = (await git(dir, ['rev-parse', '--git-common-dir'])).trim();
          await gitOk(path.resolve(dir, common), ['worktree', 'remove', '--force', dir]);
        }
      } catch (e) { log(`leftover ${name}: ${e.message}`, 'warn'); }
      fs.rmSync(dir, { recursive: true, force: true });
      log(`removed leftover worktree ${name}`);
    }
    for (const name of fs.readdirSync(dirs.repos)) {
      const dir = path.join(dirs.repos, name);
      await gitOk(dir, ['worktree', 'prune']);
      if (Date.now() - fs.statSync(dir).mtimeMs > CACHE_TTL_MS) { fs.rmSync(dir, { recursive: true, force: true }); log(`pruned unused cache ${name}`); }
    }
    await pruneCaches();
  }

  // ---- self-update (node.update, sent by the controller while this machine is idle): git pull --ff-only in the checkout
  // this worker runs from, npm ci when the lockfile changed, and a trial import of the new worker.mjs; then a clean stop
  // and exit, and the service manager (systemd Restart=always, launchd KeepAlive) starts the new code. A busy worker
  // refuses; any failure rolls the checkout back and is reported (node.error kind update).
  const busyJobs = () => jobs.size + [...held.values()].filter((j) => !j.ctl.some((c) => c.t === MSG.JOB_DONE && c.seqSent)).length;
  // Runs a step of the update; its error names the step and the stderr line that says why (an Error line, npm's own).
  async function mustRun(step, cmd, argv, opts) {
    const r = await runHelper(cmd, argv, opts);
    if (!r.error && !r.timedOut && r.code === 0) return;
    const lines = String(r.stderr || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^Node\.js v\d/.test(l));
    const why = r.timedOut ? 'timed out' : lines.find((l) => /\b\w*Error\b|^npm (error|ERR!)/.test(l)) || lines.pop() || r.error?.message || `exit ${r.code}`;
    throw Object.assign(new Error(`${step} failed: ${why}`), { stderr: r.stderr });
  }
  async function selfUpdate(msg) {
    const n = busyJobs();
    if (updating || n) return nodeError('update', updating ? 'an update is already running' : `busy: ${n} job${n === 1 ? '' : 's'} on this machine`, { re: msg.seq });
    updating = true;
    const lockFile = path.join(srcDir, 'package-lock.json');
    const lockHash = () => { try { return crypto.createHash('sha256').update(fs.readFileSync(lockFile)).digest('hex'); } catch { return null; } };
    try {
      const before = (await git(srcDir, ['rev-parse', 'HEAD'])).trim(), lockBefore = lockHash();
      log(`updating agent-orch in ${srcDir} from ${before.slice(0, 8)}${msg.sha ? ` (the controller is at ${msg.sha.slice(0, 8)})` : ''}`);
      await git(srcDir, ['pull', '--ff-only', '-q'], { timeout: 300_000 });
      const after = (await git(srcDir, ['rev-parse', 'HEAD'])).trim();
      if (after === before) throw new Error('already up to date with its origin');
      const deps = lockHash() !== lockBefore;
      try {
        if (deps) await mustRun('npm ci', 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: srcDir, timeoutMs: 900_000 });
        await mustRun('loading the new worker.mjs', process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(srcDir, 'worker.mjs')).href)})`],
          { cwd: srcDir, timeoutMs: 60_000 });
      } catch (e) {
        await git(srcDir, ['reset', '-q', '--hard', before]).catch(() => {});
        if (deps) await runHelper('npm', ['ci', '--no-audit', '--no-fund'], { cwd: srcDir, timeoutMs: 900_000 });
        throw e;
      }
      log(`updated ${before.slice(0, 8)} → ${after.slice(0, 8)}; restarting`);
      await (restart ? restart() : stop({ reason: 'update' }).then(() => process.exit(0)));
    } catch (e) {
      updating = false;
      // A git command's reason is its stderr's last line ("Not possible to fast-forward"); ours name themselves.
      const why = (e.cmd && String(e.stderr || '').trim().split('\n').pop()) || firstLine(e);
      log(`update failed: ${why}`, 'error');
      nodeError('update', why, { stderr: e.stderr, re: msg.seq });
    }
  }

  // A crash of the daemon itself (main's uncaughtException): report it, stop cleanly (running jobs pause and push
  // their WIP), then exit non-zero for the service manager to restart it. Rejections are only reported.
  function reportError(e, kind = 'exception') {
    log(`${kind}: ${e?.stack || e}`, 'error');
    nodeError(kind, firstLine(e) || 'unknown error', { stack: e?.stack });
  }

  async function start() {
    log(`agent-orch worker ${config.name || ''} (${config.node}) starting; home ${home}`);
    // The status socket first: a second daemon on this home stops here, before it touches the first one's jobs.
    status = await serveStatus({ home, answer, log });
    wrappers.reset();
    if (cap) log(`local cap: ${capText(cap, machine)}`);
    ensureLimiter();
    srcSha = await git(srcDir, ['rev-parse', 'HEAD']).then((s) => s.trim(), () => null);
    if (srcSha && !/^[0-9a-f]{40}$/.test(srcSha)) srcSha = null;
    await sweepLeftovers().catch((e) => log(`leftover sweep failed: ${e.message}`, 'warn'));
    await probePower();
    setPolicy(policy);
    resources?.start();
    models.start().catch((e) => log(`model discovery failed: ${e.message}`, 'warn'));
    probeBrowser().catch((e) => log(`browser check failed: ${e.message}`, 'warn'));
    connect();
  }

  // Clean shutdown (systemd stop, a Mac going to sleep via launchd, an update): pause running jobs (WIP pushed), say bye.
  async function stop({ timeoutMs = 60_000, reason = 'shutdown' } = {}) {
    if (stopping) return;
    stopping = true;
    clearTimeout(reconnectTimer);
    browserAbort?.abort();
    const pausing = [...jobs.values()].filter((j) => j.state === 'running' || j.state === 'checking');
    for (const j of pausing) { j.stop = { kind: 'pause' }; j.ac?.abort(); }
    await Promise.race([
      Promise.all(pausing.map((j) => (async () => { while (j.state !== 'paused' && jobs.has(j.id)) await new Promise((r) => setTimeout(r, 100)); })())),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
    for (const j of allJobs()) flushJob(j);
    raw(MSG.BYE, { reason });
    clearInterval(flusher); clearInterval(beat); clearInterval(clock); clearInterval(sampler); clearInterval(credWatch);
    models.stop(); limits.stop(); resources?.stop(); awake?.stop();
    await screens?.close().catch(() => {});
    await status?.close().catch(() => {});
    // Let the bye and the close frame out before the process exits.
    const sock = ws;
    try { sock?.close(1000, reason); } catch {}
    if (sock && sock.readyState !== WebSocket.CLOSED) await new Promise((r) => { const t = setTimeout(r, 2000); sock.once('close', () => { clearTimeout(t); r(); }); });
  }

  return { start, stop, jobs, isConnected: live, reportError, snapshot, reloadCap };
}

// ---------------------------------------------------------------- CLI

const LIMIT_USAGE = 'usage: node worker.mjs limit --cpu <cores|N%> --mem <GB|N%> [--max-tasks N] [--only-on-ac] | --show | --reset\n' +
  '  sets only the parts given; "off" removes one (--cpu off); the worker applies it at once and the head keeps to it';
// `limit` options: --cpu/--mem/--max-tasks take a value; --only-on-ac takes none (or on/off); --show and --reset none.
export function limitArgs(argv) {
  const opts = {}, keys = { cpu: 'cpu', mem: 'mem', 'max-tasks': 'maxTasks' };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) return { error: `unexpected ${JSON.stringify(argv[i])}` };
    const [, k, v] = m;
    if (keys[k]) {
      const x = v ?? argv[++i];
      if (x == null || /^--/.test(x)) return { error: `--${k} needs a value` };
      opts[keys[k]] = x;
    } else if (k === 'only-on-ac') opts.onlyOnAc = v ?? (/^(on|off|yes|no|true|false)$/i.test(argv[i + 1] || '') ? argv[++i] : true);
    else if (k === 'show' || k === 'reset') opts[k] = true;
    else return { error: `unknown option --${k}` };
  }
  return { opts };
}

// `node worker.mjs limit …`: the machine's one local setting, how much CPU/RAM it lends (cap.mjs). Saved in config.json,
// then the running daemon re-reads it over the status socket and reports it to the head.
async function limitCli(argv) {
  const home = workerHome(), cfg = readConfig(home), machine = { cores: os.cpus().length, memTotal: os.totalmem() };
  if (!cfg?.node) {
    console.error(`this account has no worker pairing (no ${configFile(home)}): there is nothing to cap${process.platform === 'darwin'
      ? '. A Mac runs its worker as its own user: sudo -u agentorch -H node ~agentorch/agent-orch-worker/worker.mjs limit …' : ''}`);
    return 1;
  }
  const a = limitArgs(argv);
  if (a.error) { console.error(`${a.error}\n${LIMIT_USAGE}`); return 1; }
  const { show, reset, ...set } = a.opts, changes = Object.keys(set).length;
  if (reset && changes) { console.error(`--reset takes no other options\n${LIMIT_USAGE}`); return 1; }
  if (show || (!reset && !changes)) {
    const c = resolveCap(cfg.cap, machine), saved = cfg.cap || {};
    if (!c) {
      console.log(`No local cap: ${cfg.name || 'this machine'} lends all ${fmtCores(machine.cores)} and ${fmtGB(machine.memTotal)}; the head's own settings decide (Server details → Machines).`);
    } else {
      console.log(`Local cap on ${cfg.name || 'this machine'} (set here; the head keeps to it):`);
      if (c.cpu != null) console.log(`  CPU        ${fmtCores(c.cpu)} of ${machine.cores}${typeof saved.cpu === 'string' ? ` (${saved.cpu})` : ''}`);
      if (c.mem != null) console.log(`  RAM        ${fmtGB(c.mem)} of ${fmtGB(machine.memTotal)}${typeof saved.mem === 'string' ? ` (${saved.mem})` : ''}`);
      if (c.maxTasks != null) console.log(`  Max tasks  ${c.maxTasks}`);
      if (c.onlyOnAc) console.log('  Power      takes tasks only on AC power');
    }
    console.log(LIMIT_USAGE);
    return 0;
  }
  const r = reset ? { cap: null } : applyLimit(cfg.cap, set, machine);
  if (r.error) { console.error(r.error); return 1; }
  writeConfig(home, { ...readConfig(home), cap: r.cap ?? undefined }); // re-read: everything else stays as it is
  const c = resolveCap(r.cap, machine);
  console.log(c ? `Local cap saved: ${capText(c, machine)}.` : `Local cap removed: ${cfg.name || 'this machine'} lends all its CPU and RAM (the head's settings apply).`);
  if (c && (capTasks(c) < 1 || (c.mem != null && c.mem < FOOTPRINT.codex))) console.log('Note: that fits no task (each counts 1 core and about 0.8-1.2 GB), so this machine takes none.');
  const ans = await statusRequest(home, { op: 'reload' }).catch(() => null);
  console.log(ans?.ok ? `Applied now: the worker reloaded it${ans.connected ? ' and told the head' : '; the head hears it once the worker reconnects'}.`
    : 'The worker isn\'t running here; it applies the cap when it starts.');
  return 0;
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
    if (m) out[m[1]] = m[2] ?? argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2), a = args(rest);
  if (cmd === 'pair') {
    const controller = a.controller || a._[0], code = a.code || a._[1];
    if (!controller || !code) throw new Error('usage: node worker.mjs pair --controller https://<host> --code <code> [--name <name>]');
    const r = await pair({ controller, code, name: a.name });
    console.log(`paired as ${r.name} (${r.node}); token saved in ${configFile(workerHome())}. Start it with: node worker.mjs run`);
  } else if (cmd === 'check') {
    // exit 0: paired and known to the head; 3: not paired (with that head); 2: couldn't tell.
    const r = await checkPairing({ controller: a.controller || null });
    console.log(r.state === 'ok' ? `paired as ${r.name}` : r.state === 'unpaired' ? `not paired: ${r.why}` : `couldn't check the pairing: ${r.why}`);
    process.exitCode = r.state === 'ok' ? 0 : r.state === 'unpaired' ? 3 : 2;
  } else if (cmd === 'run') {
    const w = createWorker();
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { w.stop().finally(() => process.exit(0)); });
    process.on('unhandledRejection', (e) => w.reportError(e, 'exception'));
    process.once('uncaughtException', (e) => {
      w.reportError(e, 'exception');
      w.stop({ reason: 'crash' }).finally(() => process.exit(1));
    });
    await w.start();
  } else if (cmd === 'status') {
    const bad = rest.find((x) => x !== '--once');
    if (bad) throw new Error(`unknown option ${JSON.stringify(bad)}: node worker.mjs status [--once]`);
    const home = workerHome(), c = readConfig(home), machine = { cores: os.cpus().length, memTotal: os.totalmem() };
    const live = !rest.includes('--once') && process.stdout.isTTY && process.stdin.isTTY;
    process.exitCode = await statusCli({ home, once: !live, config: c && { ...c, token: undefined }, cap: resolveCap(c?.cap, machine), machine });
    if (live) process.exit(process.exitCode);
  } else if (cmd === 'limit') {
    process.exitCode = await limitCli(rest);
  } else {
    // Nothing else is local (compute-only): a worker's slots, power policy and draining are set on the head; this machine
    // only caps what it lends (limit).
    if (cmd) console.error(`unknown command ${JSON.stringify(cmd)}: this machine's max tasks, power policy and draining are set on the head (Server details → Machines); here only \`limit\` caps the CPU/RAM it lends`);
    console.log('usage: node worker.mjs pair --controller https://<host> --code <code> [--name <name>] | run | status [--once] | limit …');
    process.exitCode = cmd ? 1 : 0;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
