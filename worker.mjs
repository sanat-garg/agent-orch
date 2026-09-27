#!/usr/bin/env node
// agent-orch worker daemon (BRIEF goal 11; design: .agent-orch/CLUSTER.md, wire format: cluster-protocol.mjs). Runs on
// extra machines, dials OUT to the controller over WSS (no inbound port), reports its inventory and resources, and runs
// the jobs it is given in local checkouts of the project's GitHub repo with the same adapters as the controller.
//   node worker.mjs pair --controller https://<host> --code ABCD-1234 [--name mac]   one time: stores the node token
//   node worker.mjs run                                                              the daemon (systemd / launchd)
//   node worker.mjs status                                                           the stored pairing (no token)
// Everything lives in ~/.agent-orch-worker (AGENT_ORCH_WORKER_HOME overrides): config.json (0600), repos/ (bare cache
// clones), worktrees/, deps/ (node_modules by lockfile hash), logs/. No UI. git and gh use the machine's own login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION, WS_PATH, CLAIM_PATH, HEARTBEAT_MS, HEARTBEAT_MISSES, WIP_PUSH_MS, SLEEP_JUMP_MS, MAX_FRAME, MAX_BATCH, MSG, OUTCOMES,
  EVENT_KINDS, OS_KINDS, GRACE_MS, backoffMs, createSender, decode,
} from './cluster-protocol.mjs';
import { AGENTS, agentStatus, clearLoginCache, fetchLimits, modelCatalog, readVersion, runAgentCli } from './agents.mjs';
import { agentAccount } from './health.mjs';
import { createNodeLogins } from './remote-login.mjs';
import { createModelStore } from './models.mjs';
import { createLimitStore } from './usage.mjs';
import { createResources, readSystem, registerPid, withOwner } from './resources.mjs';
import { runHelper } from './helpers.mjs';
import { MEM } from './parallel.mjs';
import { GIT_ID, commitAll, taskBranch } from './worktrees.mjs';
import { extractCommand, runCheck } from './orchestrator.mjs';

const execFileP = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return 'unknown'; } })();
export const workerHome = () => process.env.AGENT_ORCH_WORKER_HOME || path.join(os.homedir(), '.agent-orch-worker');
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
const LOG_MAX = 10 * 1024 ** 2;

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

// ---------------------------------------------------------------- pairing

// Trades a one-time pairing code (from the owner's "Add machine") for a node id + bearer token, stored 0600.
export async function pair({ controller, code, name = os.hostname(), home = workerHome() }) {
  if (!OS_KINDS.includes(process.platform)) throw new Error(`unsupported OS ${process.platform} (need ${OS_KINDS.join(' or ')})`);
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

// ---------------------------------------------------------------- the daemon

export function createWorker({ home = workerHome(), config = readConfig(home), log = createLog(home) } = {}) {
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

  // Model lists (once a day per agent, cached) and plan limits (only on limits.refresh): nothing polls (BRIEF goal 7).
  const models = createModelStore({ file: path.join(home, 'models.json'), log, onChange: () => sendInventory() });
  const limits = createLimitStore({ file: path.join(home, 'limits.json'), ids, fetch: (id) => fetchLimits(id), log });
  // Remote sign-in: the controller's Connections window drives this machine's CLI logins (remote-login.mjs).
  const logins = createNodeLogins({ send: (t, f) => raw(t, f), log, afterChange: (id) => {
    clearLoginCache();
    sendInventory();
    models.refresh([id]).catch(() => {});
  } });
  const reaperMode = process.env.AGENT_ORCH_REAPER || 'on';
  const resources = fs.existsSync('/proc/self/stat') && reaperMode !== 'off' ? createResources({
    mode: reaperMode, isActive: (o) => o.kind === 'task' && jobs.get(Number(o.id))?.state === 'running', loginActive: () => logins.active(), log,
  }) : null;

  // ---- frames
  const live = () => welcomed && ws?.readyState === WebSocket.OPEN;
  function raw(t, fields) {
    if (!live()) return false;
    try { ws.send(send(t, fields)); return true; } catch (e) { log(`could not send ${t}: ${e.message}`, 'warn'); return false; }
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
      if (!sendEvents(job, c.upto) || !raw(c.t, c.fields)) return;
      if (c.t === MSG.JOB_DONE) c.seqSent = true;
      job.ctlSent++;
    }
    sendEvents(job, evEnd(job));
  }
  const allJobs = () => [...jobs.values(), ...held.values()];
  const flusher = setInterval(() => { for (const j of allJobs()) flushJob(j); }, EVENT_FLUSH_MS);
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

  // ---- inventory and resources
  async function inventory() {
    const agents = await Promise.all(Object.values(AGENTS).map(async (a) => {
      const installed = !!a.available(), signedIn = installed && !!a.loggedIn();
      const version = installed ? await readVersion(a.id).catch(() => null) : null;
      const cat = modelCatalog(a.id);
      return { id: a.id, installed, version, signedIn, account: signedIn ? agentAccount(a.id) : null, models: cat.models, modelsError: cat.error };
    }));
    let gitVersion = null;
    try { gitVersion = /\d+\.\d+[\w.]*/.exec(await git(home, ['--version']))?.[0] || null; } catch {}
    return {
      node: config.node, name: config.name || os.hostname(), os: process.platform, arch: process.arch, cores: os.cpus().length, mem: os.totalmem(),
      agents, limits: Object.fromEntries(ids.map((id) => [id, limits.get(id)]).filter(([, v]) => v)),
      versions: { agentOrch: VERSION, node: process.version, git: gitVersion },
    };
  }
  let invBusy = null;
  function sendInventory() {
    if (!live() || invBusy) return invBusy;
    return invBusy = inventory().then((inv) => raw(MSG.INVENTORY, inv)).catch((e) => log(`inventory failed: ${e.message}`, 'warn')).finally(() => { invBusy = null; });
  }
  function sendResources() {
    const sys = readSystem();
    const swapUsedPct = sys.swapTotal ? Math.round((sys.swapTotal - (sys.swapFree || 0)) / sys.swapTotal * 1000) / 10 : 0;
    raw(MSG.RESOURCES, { memAvailable: sys.memAvailable ?? os.freemem(), load: sys.load, running: [...jobs.keys()], swapUsedPct });
  }

  // ---- connection: dial out, hello, reconnect with backoff forever
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
      sock.send(send(MSG.HELLO, { node: config.node, protocol: PROTOCOL_VERSION, version: VERSION,
        jobs: allJobs().map((j) => ({ job: j.id, state: held.has(j.id) ? 'done' : j.state, next: evEnd(j), ...(j.pushed ? { sha: j.pushed } : {}) })) }));
    });
    sock.on('unexpected-response', (_req, res) => {
      log(res.statusCode === 401 ? 'the controller refused this node token (revoked?): pair again' : `connection refused: HTTP ${res.statusCode}`, 'warn');
      sock.terminate();
    });
    sock.on('message', (data, isBinary) => {
      if (ws !== sock) return;
      lastFrame = Date.now();
      const { msg, error } = decode(isBinary ? null : data.toString('utf8'), { from: 'c' });
      if (error) { log(`bad frame from the controller: ${error}`, 'warn'); return raw(MSG.ERROR, { message: error }); }
      handle(msg).catch((e) => log(`handling ${msg.t} failed: ${e.stack || e.message}`, 'error'));
    });
    sock.on('error', (e) => log(`connection error: ${e.message}`, 'warn'));
    sock.on('close', (code, reason) => {
      if (ws !== sock) return;
      ws = null; welcomed = false;
      clearInterval(beat); beat = null;
      for (const j of allJobs()) if (j.attached) { j.attached = false; j.detachedAt = Date.now(); }
      if (connectedAt) log(`disconnected (${code}${reason?.length ? ` ${reason}` : ''})`);
      if (connectedAt && Date.now() - connectedAt > 60_000) attempt = 0;
      connectedAt = 0;
      if (stopping) return;
      const delay = Math.min(BACKOFF_MAX_MS, backoffMs(attempt++));
      reconnectTimer = setTimeout(connect, delay);
    });
  }

  function onWelcome(msg) {
    heartbeatMs = msg.heartbeatMs || HEARTBEAT_MS;
    wipPushMs = msg.wipPushMs || WIP_PUSH_MS;
    graceMs = msg.graceMs || graceMs;
    welcomed = true;
    log(`welcomed as ${msg.node}`);
    clearInterval(beat);
    // Resources every heartbeat (any frame counts as one); a controller silent for HEARTBEAT_MISSES beats is gone.
    beat = setInterval(() => {
      if (Date.now() - lastFrame > heartbeatMs * HEARTBEAT_MISSES) { log('controller went silent; reconnecting', 'warn'); return ws?.terminate(); }
      sendResources();
      try { ws?.ping(); } catch {}
    }, heartbeatMs);
    sendInventory();
    sendResources();
    if (pendingWake) { raw(MSG.WAKE, pendingWake); pendingWake = null; }
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
      case MSG.HEARTBEAT: return;
      case MSG.ACK: { // the controller has a finished job's job.done: nothing of it is left to replay
        const j = msg.job != null && held.get(msg.job);
        if (j && j.ctl.some((c) => c.t === MSG.JOB_DONE && c.seqSent)) held.delete(msg.job);
        return;
      }
      case MSG.JOB_ATTACH: return attachJob(msg);
      case MSG.ERROR: return log(`controller error: ${msg.message}`, 'warn');
      case MSG.BYE: log(`controller said bye (${msg.reason || 'no reason'})`); return ws?.close(1000, 'bye');
      case MSG.JOB_OFFER: {
        const reason = offerRejection(msg);
        return reason ? raw(MSG.JOB_REJECT, { job: msg.job, reason }) : raw(MSG.JOB_ACCEPT, { job: msg.job });
      }
      case MSG.JOB_START: return startJob(msg);
      case MSG.JOB_CANCEL: return stopJob(msg.job, 'cancel', msg.reason);
      case MSG.JOB_PAUSE: return stopJob(msg.job, 'pause');
      case MSG.JOB_RESUME: return resumeJob(msg);
      case MSG.GIT_CREDENTIAL: gitCreds.set(msg.host, msg.token); return log(`received a git credential for ${msg.host}`);
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
      default: return;
    }
  }

  function offerRejection(msg) {
    if (stopping) return 'draining';
    const st = agentStatus(msg.agent);
    if (st === 'not installed' || st === 'unknown agent') return 'agent_missing';
    if (st !== true) return 'not_signed_in';
    if ([...jobs.values()].filter((j) => j.state !== 'paused').length >= (config.maxJobs || os.cpus().length)) return 'busy';
    const avail = readSystem().memAvailable ?? os.freemem();
    if (avail - (msg.footprint || 0) < MEM.claimFloor) return 'low_memory';
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

  // Bare cache clone (blob-less), fetched before each job; remote branches land in refs/remotes/origin/*.
  async function ensureCache(repo) {
    const dir = path.join(dirs.repos, `${cacheName(repo)}.git`), env = gitAuthEnv(repo);
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
    cache: null, env: gitAuthEnv(spec.repo),
    dir: path.join(dirs.worktrees, `${cacheName(spec.repo).split('__').pop()}-task-${spec.job}`),
    sessionId: spec.resume || null, pushed: null, remoteStart: null, stop: null, lock: Promise.resolve(),
  });

  async function startJob(spec) {
    if (jobs.has(spec.job)) return raw(MSG.ERROR, { message: `job ${spec.job} is already on this worker`, job: spec.job });
    const job = newJob(spec);
    jobs.set(job.id, job);
    finished.delete(job.id);
    held.delete(job.id);
    log(`job ${job.id} start: ${spec.title} (${spec.agent}${spec.model ? `/${spec.model}` : ''})`);
    if (!(await setup(job))) return;
    if (await stopped(job)) return; // paused or cancelled during setup
    await runTurn(job, spec.prompt, spec.resume || null);
  }

  // Cache fetch → worktree on agent-orch/task-<id> (from the pushed branch when it exists, else baseSha) → install.
  async function setup(job) {
    const { spec } = job, branch = taskBranch(job.id);
    job.state = 'setup';
    try {
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
      log(`job ${job.id} ${text}`, 'error');
      await dropWorktree(job);
      jobs.delete(job.id);
      held.set(job.id, job);
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
    const nm = path.join(dir, 'node_modules');
    const cacheable = argv[0] === 'npm' && argv[1] === 'ci' && fs.existsSync(lock);
    const key = cacheable && crypto.createHash('sha256').update(fs.readFileSync(lock)).update(process.version).digest('hex').slice(0, 16);
    const cached = key && path.join(dirs.deps, key, 'node_modules');
    if (cached && fs.existsSync(cached) && !fs.existsSync(nm)) { fs.symlinkSync(cached, nm, 'dir'); return; }
    const r = await runHelper(argv[0], argv.slice(1), {
      cwd: dir, timeoutMs: (spec.timeouts.installSec || 900) * 1000,
      env: { ...process.env, npm_config_cache: dirs.npmCache, npm_config_prefer_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' },
    });
    if (r.error || r.timedOut || r.code !== 0) throw new Error(`${argv.join(' ')} failed: ${r.timedOut ? 'timed out' : String(r.stderr || r.error?.message || `exit ${r.code}`).trim().split('\n').slice(-3).join(' ')}`);
    if (cached && fs.existsSync(nm) && !fs.lstatSync(nm).isSymbolicLink() && !fs.existsSync(cached)) {
      try { fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.renameSync(nm, cached); fs.symlinkSync(cached, nm, 'dir'); } catch (e) { log(`dependency cache failed: ${e.message}`, 'warn'); }
    }
  }

  // One agent turn, then (unless paused/cancelled) the check, the final push and job.done.
  async function runTurn(job, prompt, resume) {
    const { spec } = job;
    job.state = 'running';
    job.ac = new AbortController();
    const kill = setTimeout(() => { job.stop = { kind: 'timeout' }; job.ac.abort(); }, (spec.timeouts.taskSec || 3 * 3600) * 1000);
    const wip = setInterval(() => pushWip(job).catch(() => {}), wipPushMs);
    let res;
    try {
      res = await runAgentCli({
        agent: spec.agent, model: spec.model || undefined, effort: spec.effort || undefined, prompt, cwd: job.dir, resume: resume || undefined, systemAppend: spec.systemAppend || undefined,
        autonomous: spec.autonomous ?? true, signal: job.ac.signal, onEvent: (e) => pushEvent(job, e),
        env: withOwner(process.env, 'task', job.id), onSpawn: ({ pid, pgid }) => registerPid({ pid, pgid, kind: 'task', id: job.id }),
      });
    } catch (e) { res = { outcome: 'error', text: `agent crashed: ${e?.message || e}` }; }
    finally { clearTimeout(kill); clearInterval(wip); }
    if (res.sessionId) job.sessionId = res.sessionId;
    log(`job ${job.id} agent turn ended: ${res.outcome}`);
    if (await stopped(job)) return;
    if (job.stop?.kind === 'timeout') res.outcome = 'timeout';
    await finish(job, res);
  }

  // A pause/cancel that landed while the agent (or the check) ran: pause keeps the worktree, cancel drops it.
  async function stopped(job) {
    const s = job.stop;
    if (!s || s.kind === 'timeout') return false;
    if (s.kind === 'pause') {
      job.state = 'paused';
      await pushWip(job).catch((e) => log(`job ${job.id} WIP push on pause failed: ${e.message}`, 'warn'));
      log(`job ${job.id} paused`);
      return true;
    }
    if (s.reason !== 'reassigned' && s.reason !== 'disabled') await pushWip(job).catch((e) => log(`job ${job.id} WIP push on cancel failed: ${e.message}`, 'warn'));
    await dropWorktree(job);
    jobs.delete(job.id);
    log(`job ${job.id} cancelled${s.reason ? ` (${s.reason})` : ''}`);
    return true;
  }

  async function finish(job, res) {
    const { spec } = job;
    const command = res.outcome === 'ok' ? extractCommand(spec.doneWhen) : null;
    if (command) {
      job.state = 'checking';
      let [pass, output, code] = [false, '', null];
      try { [pass, output, code] = await runCheck(command, job.dir, withOwner(process.env, 'task', job.id), spec.timeouts.verifySec || 600, job.ac.signal); }
      catch (e) { output = `verification crashed: ${e?.message || e}`; }
      if (await stopped(job)) return;
      log(`job ${job.id} check ${pass ? 'passed' : 'failed'}: ${command}`);
      emit(job, MSG.JOB_CHECK, { job: job.id, command, output: String(output).slice(-3000), pass, ...(Number.isInteger(code) ? { code } : {}) });
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
    if (held.size > 50) held.delete(held.keys().next().value);
    emit(job, MSG.JOB_DONE, {
      job: job.id, outcome, text: String(res.text || ''), usage: res.usage || {}, ...(limitsOut ? { limits: limitsOut } : {}),
      ...(sha ? { sha } : {}), ...(job.sessionId ? { sessionId: job.sessionId } : {}),
    });
    log(`job ${job.id} done: ${outcome}${sha ? ` at ${sha.slice(0, 8)}` : ''}`);
    await dropWorktree(job);
    finished.set(job.id, { ...spec, resume: job.sessionId || undefined });
    if (finished.size > 20) finished.delete(finished.keys().next().value);
  }

  // Commits everything and pushes agent-orch/task-<id> (force-with-lease against our last push), then job.wip.
  // Serialised per job. A final push retries until it lands (or the job is cancelled); a WIP push tries 3 times.
  // Past the grace period without the controller, a WIP push is skipped and a final one waits for job.attach.
  function pushWip(job, message = `agent-orch #${job.id} (wip)`, { final = false } = {}) {
    const run = job.lock.then(async () => {
      if (!fs.existsSync(job.dir)) return job.pushed;
      if (pastGrace(job)) {
        if (!final) return job.pushed;
        log(`job ${job.id} finished while the controller was away past the grace period; waiting to push`);
        while (pastGrace(job) && job.stop?.kind !== 'cancel') await new Promise((r) => setTimeout(r, 500));
        if (job.stop?.kind === 'cancel') throw new Error('cancelled');
      }
      await commitAll(job.dir, message);
      const sha = (await git(job.dir, ['rev-parse', 'HEAD'])).trim();
      if (sha === job.pushed) return sha;
      const branch = taskBranch(job.id);
      for (let i = 0; ; i++) {
        try {
          await git(job.dir, [...GIT_ID, 'push', '-q', `--force-with-lease=refs/heads/${branch}:${job.pushed || ''}`, 'origin', `HEAD:refs/heads/${branch}`], { env: job.env });
          break;
        } catch (e) {
          const why = String(e.stderr || e.message).trim().split('\n').pop();
          log(`job ${job.id} push failed (${why})`, 'warn');
          raw(MSG.ERROR, { message: `push of ${branch} failed: ${why}`, job: job.id });
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
  }

  async function start() {
    log(`agent-orch worker ${config.name || ''} (${config.node}) starting; home ${home}`);
    await sweepLeftovers().catch((e) => log(`leftover sweep failed: ${e.message}`, 'warn'));
    resources?.start();
    models.start().catch((e) => log(`model discovery failed: ${e.message}`, 'warn'));
    connect();
  }

  // Clean shutdown (systemd stop, a Mac going to sleep via launchd): pause running jobs (WIP pushed), say bye.
  async function stop({ timeoutMs = 60_000 } = {}) {
    if (stopping) return;
    stopping = true;
    clearTimeout(reconnectTimer);
    const pausing = [...jobs.values()].filter((j) => j.state === 'running' || j.state === 'checking');
    for (const j of pausing) { j.stop = { kind: 'pause' }; j.ac?.abort(); }
    await Promise.race([
      Promise.all(pausing.map((j) => (async () => { while (j.state !== 'paused' && jobs.has(j.id)) await new Promise((r) => setTimeout(r, 100)); })())),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
    for (const j of allJobs()) flushJob(j);
    raw(MSG.BYE, { reason: 'shutdown' });
    clearInterval(flusher); clearInterval(beat); clearInterval(clock);
    models.stop(); limits.stop(); resources?.stop();
    try { ws?.close(1000, 'shutdown'); } catch {}
  }

  return { start, stop, jobs, isConnected: live };
}

// ---------------------------------------------------------------- CLI

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
    const r = await pair({ controller, code, name: a.name || os.hostname() });
    console.log(`paired as ${r.name} (${r.node}); token saved in ${configFile(workerHome())}. Start it with: node worker.mjs run`);
  } else if (cmd === 'run') {
    const w = createWorker();
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { w.stop().finally(() => process.exit(0)); });
    await w.start();
  } else if (cmd === 'status') {
    const c = readConfig();
    console.log(c ? JSON.stringify({ ...c, token: undefined }, null, 1) : 'not paired');
  } else {
    console.log('usage: node worker.mjs pair --controller https://<host> --code <code> [--name <name>] | run | status');
    process.exitCode = cmd ? 1 : 0;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
