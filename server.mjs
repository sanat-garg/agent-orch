// agent-orch: login + chat UI for Claude Code, with the ttyd terminal proxied by Caddy at /shell/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createOrchestrator, parseJsonl, SHOT_HINT } from './orchestrator.mjs';
import { createGitHub } from './github.mjs';
import { retireRuntime, chatIdle, whenIdle } from './runtimes.mjs';
import { AGENTS, isAgent, agentEfforts, clampEffort, runAgentCli, clearLoginCache, isMissingSession, modelCatalog, claudeWindows, fetchLimits, agentVersion, readVersion, windowLabel, setMcpSource } from './agents.mjs';
import { createModelStore } from './models.mjs';
import { runHelper, claudeHelperSpawn } from './helpers.mjs';
import { createConnections, SPECS, codexAccount, onPath, tmuxRunnerFor, loginSocketFor } from './connections.mjs';
import { mediaCollector, MEDIA_ID_RE, MEDIA_TYPES, toolResultImages } from './media.mjs';
import { createUsageLog, createLimitStore, RANGES as USAGE_RANGES } from './usage.mjs';
import { handleFiles } from './files.mjs';
import { createStats } from './stats.mjs';
import { healthRow } from './health.mjs';
import { createResources, registerPid, withOwner, readSystem, cpuPercent } from './resources.mjs';
import { createCluster } from './cluster.mjs';
import { WS_PATH, PAIR_PATH, CLAIM_PATH, WHOAMI_PATH, EXT_PATH, GIT_PATH } from './cluster-protocol.mjs';
import { createClusterGit } from './cluster-git.mjs';
import { createRemoteLogins } from './remote-login.mjs';
import { createExtensions } from './extensions.mjs';
import { createPush, checkSub } from './push.mjs';
import { createAgentShare, wireAgentShare, shareTargets } from './agent-share.mjs';
import { saveUpload, readUpload, placeUploads, attachmentView, attachmentNote, claudeImageBlocks, MAX_UPLOAD_BYTES, MAX_ATTACHMENTS } from './uploads.mjs';
import { headRefusal } from './role.mjs';
import { createBrowserViews, LOCAL as BV_LOCAL } from './browser-view.mjs';
import { searchConvos } from './search.mjs';

// Backstop: a stray rejected promise is logged instead of killing the server (uncaught exceptions still exit).
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CW_DATA_DIR ? path.resolve(process.env.CW_DATA_DIR) : path.join(ROOT, 'data');
// Compute-only workers (BRIEF goal 11): a paired worker never runs the head (UI, chat, planner, orchestrator), and
// set-password can't make it one. Checked before anything is created or started.
const refusal = headRefusal({ dataDir: DATA });
if (refusal) { console.error(refusal); process.exit(1); }
const LOGS = path.join(DATA, 'logs');
const PUBLIC = path.join(ROOT, 'public');
const INSTALL_SCRIPTS = { '/install/worker-linux.sh': 'install-worker.sh', '/install/worker-macos.sh': 'install-worker-macos.sh' };
const HOME = os.homedir();
const WORKSPACE = path.join(HOME, 'workspace');
const PORT = Number(process.env.PORT || 3000);
const CLAUDE_BIN = path.join(HOME, '.local/bin/claude');
// Over HTTPS the cookie is `__Host-` prefixed so no other (same-site *.sslip.io) host can set or shadow it (AUDIT #34).
const COOKIE = 'cw_session', HOST_COOKIE = '__Host-cw_session';
const SESSION_DAYS = 30;
const DEVICE_NAME = process.env.CW_DEVICE_NAME || 'Oracle VM';

// Chat must run on the Claude subscription, never API credits: strip every variable that
// would make the CLI authenticate with a key or route to another provider.
const API_ENV = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/;
const CLAUDE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !API_ENV.test(k)));
// Key sources that bill API credits; a session reporting one of these is shut down.
const API_KEY_SOURCES = new Set(['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key', 'user', 'project', 'org', 'temporary']);

fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });

// ---------- small JSON store ----------
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); } catch { return fallback; }
}
function writeJSON(file, value) {
  const p = path.join(DATA, file);
  fs.writeFileSync(p + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(p + '.tmp', p);
}

// ---------- auth ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(pw) {
  const auth = readJSON('auth.json', null);
  if (!auth) return false;
  const got = crypto.scryptSync(String(pw), auth.salt, 64);
  return crypto.timingSafeEqual(got, Buffer.from(auth.hash, 'hex'));
}

let sessions = readJSON('sessions.json', {});
let sessionsMtime = 0;
// `set-password` rewrites sessions.json from another process; pick that up so old logins stop working.
function syncSessions() {
  try {
    const mtime = fs.statSync(path.join(DATA, 'sessions.json')).mtimeMs;
    if (mtime !== sessionsMtime) { sessions = readJSON('sessions.json', {}); sessionsMtime = mtime; }
  } catch {}
}
function pruneSessions() {
  const now = Date.now();
  for (const [k, v] of Object.entries(sessions)) if (v.exp < now) delete sessions[k];
}
function newSession(remember) {
  pruneSessions();
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = remember ? SESSION_DAYS * 864e5 : 864e5;
  sessions[token] = { exp: Date.now() + ttl, remember };
  writeJSON('sessions.json', sessions);
  return { token, remember, ttl };
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (k in out) continue; // the first cookie of a name is the most specific (host-only) one
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} // skip malformed %-escapes
  }
  return out;
}
function sessionToken(req) {
  const c = parseCookies(req);
  return c[HOST_COOKIE] || c[COOKIE];
}
// Only Caddy on loopback talks to us, so its X-Forwarded-Proto is trustworthy.
const isHttps = (req) => !!req.socket.encrypted || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function isAuthed(req) {
  syncSessions();
  const t = sessionToken(req);
  const s = t && sessions[t];
  return !!(s && s.exp > Date.now());
}
function sessionCookie(req, token, maxAgeSec) {
  const age = maxAgeSec == null ? '' : `; Max-Age=${maxAgeSec}`;
  return isHttps(req) ? `${HOST_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax${age}`
    : `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${age}`;
}

// Brute-force protection: 5 misses per IP locks it for 15 minutes.
const attempts = new Map();
function clientIp(req) {
  // Only Caddy on loopback talks to us, so its X-Forwarded-For is trustworthy.
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}
function lockedFor(ip) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) return 0;
  return a.until - Date.now();
}
function recordFailure(ip) {
  const now = Date.now();
  // Prune lapsed entries: expired locks and stale partial counts.
  for (const [k, v] of attempts) if (v.until < now && v.last < now - 15 * 60e3) attempts.delete(k);
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count += 1; a.last = now;
  if (a.count >= 5) { a.until = Date.now() + 15 * 60e3; a.count = 0; }
  attempts.set(ip, a);
  return 5 - a.count;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// ---------- conversations ----------
let convos = readJSON('convos.json', []);
const saveConvos = () => writeJSON('convos.json', convos);
// One chat per project: fold any older chats for the same folder into the newest one.
(function oneChatPerProject() {
  const byCwd = new Map();
  for (const c of [...convos].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!byCwd.has(c.cwd)) byCwd.set(c.cwd, []);
    byCwd.get(c.cwd).push(c);
  }
  let changed = false;
  for (const [cwd, list] of byCwd) {
    const keep = list.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    const merged = list.map((c) => { try { return fs.readFileSync(path.join(DATA, 'logs', `${c.id}.jsonl`), 'utf8'); } catch { return ''; } }).join('');
    if (list.length > 1) {
      fs.writeFileSync(path.join(DATA, 'logs', `${keep.id}.jsonl`), merged);
      for (const c of list) if (c !== keep) fs.rmSync(path.join(DATA, 'logs', `${c.id}.jsonl`), { force: true });
      convos = convos.filter((c) => c === keep || c.cwd !== cwd);
      changed = true;
    }
    const name = path.basename(cwd);
    if (keep.title !== name && !keep.renamed) { keep.title = name; changed = true; }
    // Full access by default on this disposable server (Plan mode and Orchestrator Mode are kept).
    if (!keep.fullAccess && ['default', 'acceptEdits', undefined].includes(keep.mode)) { keep.mode = 'bypassPermissions'; changed = true; }
    if (!keep.fullAccess) { keep.fullAccess = true; changed = true; }
  }
  if (changed) writeJSON('convos.json', convos);
})();
const findConvo = (id) => convos.find((c) => c.id === id);
const stats = createStats({ dataDir: DATA, convos: () => convos, log: (m) => console.log(`[stats] ${m}`) });
const logPath = (id) => path.join(LOGS, `${id}.jsonl`);
function appendLog(id, ev) { fs.appendFileSync(logPath(id), JSON.stringify(ev) + '\n'); }
function readLog(id) {
  try {
    return parseJsonl(fs.readFileSync(logPath(id), 'utf8'));
  } catch { return []; }
}
// A fallback list from a request body: null = none; an array (even empty) is used as-is, in order,
// deduplicated. Every entry must be a discovered model of a known agent. → {list} | {error}
function checkFallbacks(v) {
  if (v !== null && !Array.isArray(v)) return { error: 'fallbacks must be an array of {agent, model} or null' };
  if (!v) return { list: null };
  if (v.length > 20) return { error: 'At most 20 fallbacks' };
  const list = [];
  for (const f of v) {
    const agent = f?.agent, model = f?.model;
    if (!isAgent(agent)) return { error: `Unknown agent: ${agent}` };
    if (typeof model !== 'string' || !(modelCatalog(agent).models || []).some((m) => m.id === model)) return { error: `Unknown ${agent} model: ${model}` };
    if (!list.some((x) => x.agent === agent && x.model === model)) list.push({ agent, model });
  }
  return { list };
}
function publicConvo(c) {
  const rt = runtimes.get(c.id);
  // project: its orchestrator project's {id, position, priority} (the sidebar's drag order), null for a plain chat.
  return { ...c, fallbacks: c.fallbacks ?? null, effort: c.effort ?? null, persona: c.persona ?? null, busy: !!rt?.busy || planning.has(c.id) || agentTurns.has(c.id), project: orch?.projectRank(c.cwd) ?? null };
}
const planning = new Set(); // convo ids with an orchestrator planner turn in progress
const agentTurns = new Map(); // convo id -> AbortController of a running non-Claude chat turn
const chatAgent = (c) => (c.agent && c.agent !== 'claude' && isAgent(c.agent) ? c.agent : 'claude');
const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'orchestrator'];
// The chat's reasoning effort as its agent (and model) takes it: null = the agent's default (and for agents without efforts).
const chatEffort = (c) => clampEffort(chatAgent(c), c.effort || null, c.model || null);
// A live Claude chat session switches to the chat's current effort from its next turn (null goes back to the model default).
const applyChatEffort = (c) => runtimes.get(c.id)?.q.applyFlagSettings({ effortLevel: chatEffort(c) }).catch((e) => console.error('[chat] effort not applied', c.id, e?.message || e));
const sdkMode = (mode) => (mode === 'orchestrator' || !mode ? 'default' : mode);

const STOP_WORDS = new Set('a an the and or of for to in on with me my our your i we you it this that please can could would should make build create write add set up setup help need want let using use into from some new small simple quick basic'.split(' '));
// A typed name keeps every word; a name derived from a message drops filler words and keeps four.
function slugify(text, fromMessage = false) {
  if (!text) return '';
  const words = String(text).toLowerCase().replace(/[^a-z0-9\s._-]/g, ' ').split(/[\s_]+/).filter(Boolean);
  const keep = fromMessage ? words.filter((w) => !STOP_WORDS.has(w)) : words;
  return (keep.length ? keep : words).slice(0, fromMessage ? 4 : 8).join('-').replace(/[^a-z0-9.-]/g, '').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40);
}
function uniqueProjectDir(slug) {
  let dir = path.join(WORKSPACE, slug);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(WORKSPACE, `${slug}-${n}`);
  return dir;
}
const PROJECT_MARKERS = [['package.json', 'Node'], ['pyproject.toml', 'Python'], ['requirements.txt', 'Python'], ['go.mod', 'Go'], ['Cargo.toml', 'Rust'], ['Gemfile', 'Ruby'], ['pom.xml', 'Java'], ['index.html', 'Web']];
function listFolders(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .slice(0, 300)
    .map((d) => {
      const full = path.join(dir, d.name);
      let names = [];
      try { names = fs.readdirSync(full); } catch {}
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      return {
        name: d.name,
        path: full,
        items: names.length,
        hasSubfolders: names.slice(0, 200).some((n) => !n.startsWith('.') && n !== 'node_modules' && (() => { try { return fs.statSync(path.join(full, n)).isDirectory(); } catch { return false; } })()),
        git: names.includes('.git'),
        kind: (PROJECT_MARKERS.find(([f]) => names.includes(f)) || [])[1] || null,
        mtime,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function safeCwd(p) {
  const full = path.resolve(WORKSPACE, p || '.');
  if (full !== HOME && !full.startsWith(HOME + path.sep)) throw new Error('Folder must be inside your home directory');
  return full;
}
// ---------- Claude account (subscription check) ----------
let claudeAuth = { loggedIn: false, authMethod: null, plan: null, checkedAt: 0 };
function refreshClaudeAuth() {
  return runHelper(CLAUDE_BIN, ['auth', 'status'], { env: CLAUDE_ENV, timeoutMs: 15000 }).then(({ stdout }) => {
    try {
      const s = JSON.parse(stdout);
      claudeAuth = { loggedIn: !!s.loggedIn, authMethod: s.authMethod || null, plan: s.subscriptionType || null, checkedAt: Date.now() };
    } catch {
      claudeAuth = { loggedIn: false, authMethod: null, plan: null, checkedAt: Date.now() };
    }
    return claudeAuth;
  });
}
const onSubscription = () => claudeAuth.loggedIn && claudeAuth.authMethod === 'claude.ai';
setInterval(() => refreshClaudeAuth().catch((e) => console.error('[auth] refresh failed', e)), 5 * 60e3);

// ---------- self-restart ----------
// The boot commit tells the UI how far HEAD has moved since this process started (a restart is due).
const git = (args) => new Promise((resolve) => execFile('git', args, { cwd: ROOT, timeout: 5000 }, (err, out) => resolve(err ? '' : out.trim())));
// AGENT_ORCH_BOOT_COMMIT overrides it (tests only).
let bootCommit = '', restartPending = false, restartGen = 0, sinceBoot = { at: 0, count: 0, busy: false };
if (process.env.AGENT_ORCH_BOOT_COMMIT) bootCommit = process.env.AGENT_ORCH_BOOT_COMMIT;
else git(['rev-parse', 'HEAD']).then((c) => { bootCommit = c; });
function commitsSinceBoot() {
  if (bootCommit && !sinceBoot.busy && Date.now() - sinceBoot.at > 30e3) {
    sinceBoot.busy = true;
    git(['rev-list', '--count', `${bootCommit}..HEAD`]).then((n) => { sinceBoot = { at: Date.now(), count: Number(n) || 0, busy: false }; });
  }
  return sinceBoot.count;
}
// Stop claiming tasks, then exit 0 once the running ones and every chat reply/planner turn finish; systemd
// (Restart=always) brings the app back. Cancelled by POST /api/restart-when-idle {cancel:true}.
function startRestartDrain(reason) {
  if (restartPending) return;
  restartPending = true;
  const gen = ++restartGen;
  console.log(`[restart] ${reason}: waiting for running tasks and chat turns to finish`);
  const idle = () => chatIdle({ runtimes, agentTurns, planning, chatPlanning: orch.chatPlanning });
  const cancelled = () => gen !== restartGen;
  whenIdle({ drained: orch.drain(), cancelled, idle }).then(async (ok) => {
    if (!ok) return;
    const head = await git(['rev-parse', 'HEAD']);
    console.log('[restart] idle; checking that the new code boots');
    const why = await restartPreflight().catch((e) => String(e?.message || e));
    if (cancelled()) return;
    if (!why) {
      if (await whenIdle({ drained: null, cancelled, idle })) { console.log('[restart] exiting for restart'); process.exit(0); }
      return;
    }
    // Stay up on the old code: resume claiming like a cancel, and let the auto path wait for a newer HEAD.
    console.error(`[restart] preflight failed: ${why}`);
    restartPending = false; restartGen++; autoRestartSkipHead = head;
    orch.undrain();
    orch.logEvent(`Restart skipped: the code at ${head.slice(0, 8) || 'HEAD'} does not boot (${why.slice(0, 300)})`, { level: 'warn' });
    for (const ws of allClients) send(ws, { t: 'status', restartPending });
  });
  for (const ws of allClients) send(ws, { t: 'status', restartPending });
}
// Proves the code at HEAD boots before a restart: `node --check` every root and bin/ *.mjs, then start server.mjs
// once on a spare port with no orchestrator (never on the live DB) and a throwaway data dir, and wait up to 20 s
// for /auth/check to answer. Resolves '' when it booted, else why not.
async function restartPreflight() {
  const mjs = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.mjs')).map((f) => path.join(dir, f));
  for (const f of [...mjs('.'), ...mjs('bin')]) {
    const err = await new Promise((resolve) => execFile(process.execPath, ['--check', f], { cwd: ROOT, timeout: 30e3 },
      (e, _out, stderr) => resolve(e ? `${f}: ${String(stderr || e.message).trim().split('\n').slice(0, 5).join(' | ')}` : '')));
    if (err) return err;
  }
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orch-preflight-'));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dir, CW_NO_ORCHESTRATOR: '1' } });
  let out = '', exited = null;
  const tail = () => { const lines = out.trim().split('\n'); return lines.find((l) => /Error\b/.test(l))?.trim() || lines.slice(-3).join(' | '); };
  child.stdout.on('data', (d) => { out = (out + d).slice(-4000); });
  child.stderr.on('data', (d) => { out = (out + d).slice(-4000); });
  child.on('exit', (code, sig) => { exited = code ?? sig; });
  try {
    for (const end = Date.now() + 20e3; Date.now() < end && exited == null; await new Promise((r) => setTimeout(r, 500))) {
      try { await (await fetch(`http://127.0.0.1:${port}/auth/check`, { signal: AbortSignal.timeout(2000) })).body?.cancel(); return ''; } catch {}
    }
    return exited != null ? `server.mjs exited (${exited}) during boot: ${tail()}` : `server.mjs did not answer /auth/check within 20 s: ${tail()}`;
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// The owner's autoRestart setting: once merged commits since boot touch server-side code (root *.mjs, bin/,
// package.json, package-lock.json), drain and restart by itself. A cancelled auto restart waits for a newer HEAD.
const SERVER_FILE = (f) => /^[^/]+\.mjs$/.test(f) || f.startsWith('bin/') || f === 'package.json' || f === 'package-lock.json';
let autoRestartSkipHead = '', autoRestartBusy = false;
async function autoRestartCheck() {
  if (restartPending || autoRestartBusy || !bootCommit || !orch?.autoRestart()) return;
  autoRestartBusy = true;
  try {
    const head = await git(['rev-parse', 'HEAD']);
    if (!head || head === bootCommit || head === autoRestartSkipHead) return;
    const files = (await git(['diff', '--name-only', `${bootCommit}..${head}`])).split('\n').filter(SERVER_FILE);
    if (files.length && !restartPending && orch.autoRestart()) startRestartDrain(`auto: ${files.length} server file(s) changed since boot (${files.slice(0, 3).join(', ')})`);
  } finally { autoRestartBusy = false; }
}

// ---------- server metrics ----------
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, (err, out) => resolve(out || '')));

function cpuTimes() {
  const f = readText('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
  const [, , , idle = 0, iowait = 0, , , steal = 0] = f;
  return { total: f.reduce((a, b) => a + b, 0), idle: idle + iowait, iowait, steal };
}
function memInfo() {
  const o = {};
  for (const l of readText('/proc/meminfo').split('\n')) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) o[m[1]] = Number(m[2]) * 1024;
  }
  return o;
}
function netTotals() {
  let best = { iface: '', rx: 0, tx: 0 };
  for (const l of readText('/proc/net/dev').split('\n').slice(2)) {
    const [name, rest] = l.split(':');
    if (!rest || name.trim() === 'lo') continue;
    const f = rest.trim().split(/\s+/).map(Number);
    if (f[0] + f[8] >= best.rx + best.tx) best = { iface: name.trim(), rx: f[0], tx: f[8] };
  }
  return best;
}
function diskIo() {
  let r = 0, w = 0;
  for (const l of readText('/proc/diskstats').split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length > 9 && /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$/.test(f[2])) { r += Number(f[5]) * 512; w += Number(f[9]) * 512; }
  }
  return { r, w };
}
function listDir(dir) { try { return fs.readdirSync(dir); } catch { return []; } }
function temperatures() {
  const out = [];
  for (const z of listDir('/sys/class/thermal').filter((d) => d.startsWith('thermal_zone'))) {
    const v = Number(readText(`/sys/class/thermal/${z}/temp`));
    if (v) out.push({ name: readText(`/sys/class/thermal/${z}/type`).trim() || z, c: v / 1000 });
  }
  for (const h of listDir('/sys/class/hwmon')) {
    const base = `/sys/class/hwmon/${h}`;
    for (const f of listDir(base).filter((x) => /^temp\d+_input$/.test(x))) {
      const v = Number(readText(`${base}/${f}`));
      if (v) out.push({ name: readText(`${base}/name`).trim() || h, c: v / 1000 });
    }
  }
  return out;
}
function energyMicrojoules() {
  let total = null;
  // Top-level RAPL domains only (e.g. "intel-rapl:0"); subdomains ("intel-rapl:0:0") are already counted in them.
  for (const d of listDir('/sys/class/powercap').filter((x) => (x.match(/:/g) || []).length === 1)) {
    const v = readText(`/sys/class/powercap/${d}/energy_uj`);
    if (v) total = (total || 0) + Number(v);
  }
  return total;
}

// Samples are kept on disk so the charts survive restarts: every 3 s sample for the last 24 h,
// and one averaged point per minute for 90 days.
const SAMPLE_MS = 3000;
const RAW_KEEP_MS = 24 * 3600e3;
const MINUTE_KEEP_MS = 90 * 864e5;
const METRIC_FIELDS = ['cpu', 'steal', 'iowait', 'mem', 'rx', 'tx', 'dr', 'dw'];
const METRICS_DIR = path.join(DATA, 'metrics');
fs.mkdirSync(METRICS_DIR, { recursive: true });
const RAW_FILE = path.join(METRICS_DIR, 'raw.jsonl');
// Per-agent usage history (plan windows, tokens per turn/run, limit events): usage.mjs.
const usageLog = createUsageLog(DATA);
try { usageLog.compact(); } catch (e) { console.error('[usage] compact failed', e); }
// Every agent's latest plan-limit check (usage.mjs createLimitStore): only when the owner presses refresh on the usage
// card, for that one agent (each check can start a CLI). Claude goes through refreshUsage (it also feeds the sidebar);
// codex reads its newest rollout (agents.mjs fetchLimits). Readings land in usageLog and feed each connection's health.
const limitStore = createLimitStore({ file: path.join(DATA, 'limits.json'), ids: Object.keys(AGENTS), usageLog,
  log: (m) => console.log(`[limits] ${m}`),
  fetch: async (id) => {
    if (id !== 'claude') return fetchLimits(id);
    if (!AGENTS.claude.loggedIn()) return fetchLimits(id);
    if (!claudeAuth.checkedAt) await refreshClaudeAuth(); // at boot, before refreshUsage can tell it's a subscription
    await refreshUsage();
    return usage.available && !usage.error ? { ...limitStore.get('claude'), error: null }
      : { source: AGENTS.claude.limitSource, exposed: true, error: usage.error || 'Plan limits unavailable' };
  },
  onChange: () => { try { const list = connList(); for (const ws of allClients) send(ws, { t: 'connections', connections: list }); } catch {} } });
const MINUTE_FILE = path.join(METRICS_DIR, 'minutes.jsonl');

function loadSeries(file, keepMs) {
  const cutoff = Date.now() - keepMs;
  return parseJsonl(readText(file)).filter((s) => s.t > cutoff);
}
function rewriteSeries(file, rows) {
  fs.writeFileSync(file + '.tmp', rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  fs.renameSync(file + '.tmp', file);
}
const raw = loadSeries(RAW_FILE, RAW_KEEP_MS);
const minutes = loadSeries(MINUTE_FILE, MINUTE_KEEP_MS);
const history = raw; // latest sample is history[history.length - 1]

function average(rows, t) {
  const out = { t };
  for (const f of METRIC_FIELDS) out[f] = round(rows.reduce((a, r) => a + (r[f] || 0), 0) / rows.length, f);
  return out;
}
const round = (v, f) => (['rx', 'tx', 'dr', 'dw'].includes(f) ? Math.round(v) : Math.round(v * 10) / 10);

let prev = null;
let minuteStart = Math.floor(Date.now() / 60e3) * 60e3;
function sample() {
  const now = Date.now();
  const cur = { t: now, cpu: cpuTimes(), net: netTotals(), io: diskIo() };
  if (prev) {
    const dt = (now - prev.t) / 1000;
    const dTotal = cur.cpu.total - prev.cpu.total || 1;
    const mem = memInfo();
    const s = {
      t: now,
      cpu: Math.max(0, 100 * (1 - (cur.cpu.idle - prev.cpu.idle) / dTotal)),
      steal: 100 * (cur.cpu.steal - prev.cpu.steal) / dTotal,
      iowait: 100 * (cur.cpu.iowait - prev.cpu.iowait) / dTotal,
      mem: 100 * (1 - mem.MemAvailable / mem.MemTotal),
      rx: Math.max(0, (cur.net.rx - prev.net.rx) / dt),
      tx: Math.max(0, (cur.net.tx - prev.net.tx) / dt),
      dr: Math.max(0, (cur.io.r - prev.io.r) / dt),
      dw: Math.max(0, (cur.io.w - prev.io.w) / dt),
    };
    for (const f of METRIC_FIELDS) s[f] = round(s[f], f);
    raw.push(s);
    fs.appendFile(RAW_FILE, JSON.stringify(s) + '\n', () => {});
    // Roll the finished minute up into one averaged point.
    const m = Math.floor(now / 60e3) * 60e3;
    if (m > minuteStart) {
      const rows = raw.filter((r) => r.t >= minuteStart && r.t < m);
      if (rows.length) {
        const avg = average(rows, minuteStart);
        minutes.push(avg);
        fs.appendFile(MINUTE_FILE, JSON.stringify(avg) + '\n', () => {});
      }
      minuteStart = m;
    }
  }
  prev = cur;
}
// Trim both files hourly so they only hold what is kept.
setInterval(() => {
  const now = Date.now();
  while (raw.length && raw[0].t < now - RAW_KEEP_MS) raw.shift();
  while (minutes.length && minutes[0].t < now - MINUTE_KEEP_MS) minutes.shift();
  rewriteSeries(RAW_FILE, raw);
  rewriteSeries(MINUTE_FILE, minutes);
}, 3600e3);
sample();
setInterval(() => { sample(); pushMetrics(); }, SAMPLE_MS);

// Chart data for a time range, averaged down to at most ~480 points.
const RANGES = { '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 864e5, all: 0 };
function historyFor(rangeKey) {
  const now = Date.now();
  const rangeMs = RANGES[rangeKey] ?? RANGES['1h'];
  const earliest = Math.min(minutes[0]?.t ?? now, raw[0]?.t ?? now);
  const start = rangeMs ? now - rangeMs : earliest;
  // Use the 3 s samples whenever they cover the range; otherwise the minute averages plus the current minute.
  // (Minute points are stamped at the start of their minute, so allow a minute of slack.)
  const useRaw = (rangeMs && rangeMs <= RAW_KEEP_MS) || (raw.length && start >= raw[0].t - 60e3 - SAMPLE_MS);
  const src = useRaw
    ? raw.filter((r) => r.t >= start)
    : [...minutes.filter((r) => r.t >= start), ...raw.filter((r) => r.t >= (minutes[minutes.length - 1]?.t ?? 0) + 60e3)];
  const bucketMs = Math.max(SAMPLE_MS, Math.ceil((now - start) / 480 / 1000) * 1000);
  const points = [];
  let bucket = [], bStart = null;
  for (const r of src) {
    const b = Math.floor(r.t / bucketMs) * bucketMs;
    if (bStart !== null && b !== bStart) { points.push(average(bucket, bucket[bucket.length - 1].t)); bucket = []; }
    bStart = b;
    bucket.push(r);
  }
  if (bucket.length) points.push(average(bucket, bucket[bucket.length - 1].t));
  return { range: rangeKey, start, end: now, bucketMs, sampleMs: SAMPLE_MS, earliest, points };
}

// Every client gets each 3 s sample (sidebar card); clients with the server window open
// also get the full snapshot.
function pushMetrics() {
  const last = history[history.length - 1];
  if (!last) return;
  const tick = JSON.stringify({ t: 'mtick', s: last });
  for (const ws of allClients) if (ws.readyState === 1) ws.send(tick);
  const subs = [...allClients].filter((ws) => ws.metricsSub);
  if (subs.length) {
    metrics(Infinity).then((d) => {
      const msg = JSON.stringify({ t: 'mdetail', d });
      for (const ws of subs) if (ws.readyState === 1) ws.send(msg);
    }).catch(() => {});
  }
}

// ---------- Claude plan usage (5-hour and weekly limits) ----------
// Uses the data behind Claude Code's /usage screen. It is a control call to the CLI and uses
// no model tokens. The SDK marks it experimental, so every field is read defensively.
let usage = { available: false, updatedAt: 0 };
let usageRun = null;
// One long-lived probe answers every check (a fresh one would start a Claude CLI process each time); it is closed
// after a failed check and whenever auto-refresh stops.
let usageProbe = null, usageFails = 0, usageTriedAt = 0;
const usageProbeQuery = () => (usageProbe ||= query({
  prompt: (async function* idle() { await new Promise(() => {}); })(),
  options: { pathToClaudeCodeExecutable: CLAUDE_BIN, env: CLAUDE_ENV, cwd: WORKSPACE, spawnClaudeCodeProcess: claudeHelperSpawn },
}));
function closeUsageProbe() { try { usageProbe?.close(); } catch {} usageProbe = null; }
// One check at a time: callers during a check wait for its answer (the limit store reads `usage` afterwards).
function refreshUsage(liveQuery) { return (usageRun ||= refreshUsageNow(liveQuery).finally(() => { usageRun = null; })); }
async function refreshUsageNow(liveQuery) {
  if (!onSubscription()) {
    usage = { available: false, updatedAt: Date.now() };
    for (const ws of allClients) send(ws, { t: 'usage', usage });
    return;
  }
  try {
    const q = liveQuery || usageProbeQuery();
    const u = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 20000)),
    ]);
    const rl = u.rate_limits || {};
    const win = (w) => (w && w.utilization != null ? { pct: w.utilization, resetsAt: w.resets_at } : null);
    usage = {
      available: !!u.rate_limits_available,
      plan: u.subscription_type || claudeAuth.plan,
      session: win(rl.five_hour),
      weekly: win(rl.seven_day),
      weeklyOpus: win(rl.seven_day_opus),
      weeklySonnet: win(rl.seven_day_sonnet),
      models: (rl.model_scoped || []).filter((m) => m.utilization != null).map((m) => ({ name: m.display_name, pct: m.utilization, resetsAt: m.resets_at })),
      extraUsage: rl.extra_usage ? !!rl.extra_usage.is_enabled : null,
      breakdown: Array.isArray(rl.seven_day_breakdown?.rows) ? rl.seven_day_breakdown.rows.map((r) => ({ name: r.display_name, pct: r.percent })) : null,
      updatedAt: Date.now(),
      readAt: Date.now(), // a failed refresh moves updatedAt but not this: the numbers are still this old
    };
    const windows = claudeWindows(rl);
    for (const w of windows) usageLog.window('claude', w.window, w.pct, w.resetsAt);
    if (usage.available) limitStore.note('claude', { windows, at: usage.updatedAt });
    usageFails = 0;
  } catch (e) {
    usage = { ...usage, error: String(e?.message || e), updatedAt: Date.now() };
    usageFails++;
    if (!liveQuery) closeUsageProbe(); // a stuck or dead probe: the next check starts a new one
  }
  for (const ws of allClients) send(ws, { t: 'usage', usage });
}
// Auto-refresh: every 5 s while a browser is connected; with none, once a minute only while the orchestrator's Claude
// is at its limit (so a reset or a plan upgrade is seen and queued tasks start); otherwise off, and the probe closes.
// Failures back off (15 s, 30 s, … up to 5 min). Test and preflight copies (CW_NO_ORCHESTRATOR=1) never poll.
const USAGE_POLL_MS = 5000, USAGE_IDLE_POLL_MS = 60e3;
if (process.env.CW_NO_ORCHESTRATOR !== '1') setInterval(() => { // NO_ORCH is declared further down
  const watching = allClients.size > 0;
  if (usageRun) return;
  // Nobody watching and Claude not at its limit: stop at once (the limit check reads the DB, so only then).
  if (!onSubscription() || (!watching && !orch?.stateView().blockedUntil)) { if (usageProbe) closeUsageProbe(); return; }
  const due = Math.max(watching ? USAGE_POLL_MS : USAGE_IDLE_POLL_MS, usageFails ? Math.min(300e3, 15e3 * 2 ** (usageFails - 1)) : 0);
  if (Date.now() - usageTriedAt < due - 250) return;
  usageTriedAt = Date.now();
  refreshUsage().catch((e) => console.error('[usage] refresh failed', e));
}, 1000).unref?.();
// Until the first check answers, the card shows the last saved reading.
{
  const saved = limitStore.get('claude'), find = (id) => saved?.windows?.find((w) => w.window === id);
  const win = (w) => w && { pct: w.pct, resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null };
  if (saved?.at && find('five_hour')) usage = { available: true, session: win(find('five_hour')), weekly: win(find('seven_day')), updatedAt: saved.at, readAt: saved.at };
}
refreshClaudeAuth().catch((e) => console.error('[auth] refresh failed', e));

let instance = null;
fetch('http://169.254.169.254/opc/v2/instance/', { headers: { Authorization: 'Bearer Oracle' }, signal: AbortSignal.timeout(3000) })
  .then((r) => r.json())
  .then((d) => {
    instance = {
      shape: d.shape, region: d.canonicalRegionName || d.region, ad: d.availabilityDomain,
      ocpus: d.shapeConfig?.ocpus, memoryGB: d.shapeConfig?.memoryInGBs, bandwidthGbps: d.shapeConfig?.networkingBandwidthInGbps,
    };
  })
  .catch(() => {});

const slowCache = { at: 0, top: [], services: [] };
async function slowMetrics() {
  if (Date.now() - slowCache.at < 1900) return slowCache;
  const [ps, svc] = await Promise.all([
    run('ps', ['-eo', 'pid,comm,%cpu,rss', '--sort=-%cpu', '--no-headers']),
    run('systemctl', ['is-active', 'agent-orch', 'agent-orch-shell', 'caddy']),
  ]);
  slowCache.top = ps.trim().split('\n').slice(0, 8).map((l) => {
    const [pid, comm, cpu, rss] = l.trim().split(/\s+/);
    return { pid: Number(pid), name: comm, cpu: Number(cpu), rss: Number(rss) * 1024 };
  });
  const names = ['Web app', 'Terminal', 'HTTPS proxy'];
  slowCache.services = svc.trim().split('\n').map((s, i) => ({ name: names[i], active: s.trim() === 'active' }));
  slowCache.at = Date.now();
  return slowCache;
}

async function metrics(since) {
  const mem = memInfo();
  const disk = fs.statfsSync('/');
  const [load1, load5, load15, procs] = readText('/proc/loadavg').split(' ');
  const [running, total] = (procs || '0/0').split('/').map(Number);
  const cpuLine = readText('/proc/cpuinfo');
  const net = netTotals();
  const slow = await slowMetrics();
  return {
    device: DEVICE_NAME,
    instance,
    os: (readText('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]+)/m) || [])[1] || os.type(),
    kernel: os.release(),
    arch: os.arch(),
    uptime: Number(readText('/proc/uptime').split(' ')[0]),
    cpu: {
      cores: os.cpus().length,
      model: os.cpus()[0]?.model && os.cpus()[0].model !== 'unknown' ? os.cpus()[0].model : (cpuLine.match(/CPU part\s*:\s*0xd0c/) ? 'Arm Neoverse-N1' : os.arch()),
      load: [load1, load5, load15].map(Number),
    },
    procs: { running, total },
    mem: {
      total: mem.MemTotal, available: mem.MemAvailable, used: mem.MemTotal - mem.MemAvailable,
      cached: (mem.Cached || 0) + (mem.Buffers || 0), swapTotal: mem.SwapTotal, swapUsed: mem.SwapTotal - mem.SwapFree,
    },
    disk: { total: disk.blocks * disk.bsize, free: disk.bavail * disk.bsize, used: (disk.blocks - disk.bfree) * disk.bsize },
    net: { iface: net.iface, rxTotal: net.rx, txTotal: net.tx },
    sensors: { temps: temperatures(), energyAvailable: prev?.energy != null },
    services: slow.services,
    top: slow.top,
    claude: { loggedIn: claudeAuth.loggedIn, authMethod: claudeAuth.authMethod, plan: claudeAuth.plan, subscription: onSubscription() },
    history: since === Infinity ? [] : history.filter((h) => h.t > since).slice(-200),
  };
}

// ---------- live Claude runtimes ----------
const runtimes = new Map(); // convo id -> { q, push, busy, pending: Map }
const subscribers = new Map(); // convo id -> Set<ws>
const allClients = new Set();

// ---------- Skills, MCP servers, subagents and personas (extensions.mjs; Settings → Skills & tools) ----------
const ext = createExtensions({ dataDir: DATA });
setMcpSource((agent, run) => ext.mcpRun(agent, run)); // every runAgentCli run (tasks, planner, non-Claude chats) reads the list as it starts
ext.onChange((kind) => { for (const ws of allClients) send(ws, { t: 'ext', kind }); });
// A chat's persona as its system-prompt block (null: none, or deleted), and the MCP servers Claude chats get.
const personaOf = (convo) => ext.personaPrompt(convo.persona);
// Web Push to the owner's home-screen app (push.mjs): VAPID keys and subscribed devices under DATA.
const push = createPush({ dataDir: DATA, log: (m) => console.log(`[push] ${m}`) });
// At most one push per tag per minute, so a flapping event can't buzz the phone over and over.
const PUSH_TAG_MS = 60_000, PERM_PUSH_MS = 15_000;
const pushedAt = new Map(); // tag -> last send (ms)
function notify(n) {
  const t = Date.now(), key = n.tag || '';
  if (t - (pushedAt.get(key) || 0) < PUSH_TAG_MS) return;
  pushedAt.set(key, t);
  for (const [k, at] of pushedAt) if (t - at >= PUSH_TAG_MS) pushedAt.delete(k);
  return push.send(n);
}
const mcpSet = () => JSON.stringify(ext.mcpFor('claude'));

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(cid, msg) { for (const ws of subscribers.get(cid) || []) send(ws, { cid, ...msg }); }
function broadcastConvos() {
  const list = convos.map(publicConvo);
  for (const ws of allClients) send(ws, { t: 'convos', convos: list });
}
function emit(cid, ev) {
  if (!findConvo(cid)) return; // deleted while its session was winding down
  const stamped = { ...ev, ts: Date.now() };
  appendLog(cid, stamped);
  broadcast(cid, stamped);
}

// ---------- Orchestrator Mode (agent-orch) ----------
// CW_NO_ORCHESTRATOR=1 (preflight against a copy of real data): the DB is opened and migrated, but nothing runs or pushes.
const NO_ORCH = process.env.CW_NO_ORCHESTRATOR === '1';
const orch = process.argv[2] === 'set-password' ? null : createOrchestrator({
  // The controller's work slots come from its hardware (parallel.mjs headTarget; memory is only an emergency floor) unless
  // the owner sets 1-16 in Settings, and any agent may fill them all (rate limits are the fallback list's job).
  config: { agentSlots: Infinity },
  query,
  claudeBin: CLAUDE_BIN,
  claudeEnv: CLAUDE_ENV,
  dataDir: DATA,
  // The usage card's /usage reading, in the shape pacing expects (fractions, epoch seconds).
  usageLog,
  // Approvals, failed tasks, review checkpoints and waiting events reach the owner's phone (orchestrator.mjs notifyOwner).
  notify: (n) => notify(n),
  getLimits: () => {
    if (!usage.available) return [];
    const observed = (usage.readAt || usage.updatedAt) / 1000;
    const row = (type, w) => w && { limit_type: type, status: w.pct >= 100 ? 'rejected' : 'allowed', utilization: w.pct / 100,
      resets_at: w.resetsAt ? Date.parse(w.resetsAt) / 1000 : null, observed_at: observed };
    return [row('five_hour', usage.session), row('seven_day', usage.weekly)].filter(Boolean);
  },
  onSubscription: () => onSubscription(),
  emitChat: (cid, ev, { persist = true } = {}) => (persist ? emit(cid, ev) : broadcast(cid, ev)),
  broadcast: (msg) => { for (const ws of allClients) send(ws, msg); },
  convoExists: (cid) => !!findConvo(cid),
  convoFallbacks: (cid) => findConvo(cid)?.fallbacks ?? null,
  // Read at every task session boundary: tasks follow the chat's live effort, never a snapshot.
  convoEffort: (cid) => findConvo(cid)?.effort ?? null,
  // The chat's persona (extensions.mjs) as a system-prompt block, appended to its project's planner and task runs.
  convoPersona: (cid) => ext.personaPrompt(findConvo(cid)?.persona),
  refreshUsage: () => refreshUsage().catch((e) => console.error('[usage] refresh failed', e)),
  onCommit: (dir) => syncGit(dir).catch((e) => console.error('[github] sync failed', dir, e)),
  projectReady: (dir) => gh.status().linked && !!convos.find((c) => c.cwd === dir)?.repo,
  disabled: NO_ORCH,
  reap: () => resources.reap({ reason: 'low memory' }),
});
if (orch && !NO_ORCH) setInterval(() => autoRestartCheck().catch((e) => console.error('[restart] auto check failed', e)), Number(process.env.AGENT_ORCH_RESTART_POLL_MS) || 60e3);

// ---------- GitHub protocol ----------
// Every project is a private GitHub repo; every finished task and chat reply is pushed.
// A push that origin's diverged main stopped (github.mjs never forces) needs the owner: it buzzes the phone.
const gh = createGitHub({ env: CLAUDE_ENV, log: (m) => console.log(`[github] ${m}`),
  alert: (dir, error) => notify({ title: 'Push to GitHub stopped', body: `${path.basename(dir)}: ${error}`, tag: 'push-diverged', url: '/' }) });
// ---------- Sign-in connections (agent CLIs + GitHub), driven from the web UI ----------
// Each agent's models, discovered from its CLI (models.mjs); clients refetch /api/agents on {t:'models'}.
const modelStore = createModelStore({ file: path.join(DATA, 'models.json'), log: (m) => console.log(`[models] ${m}`),
  // New lists can change a connection's state too.
  onChange: () => { const list = connList(); for (const ws of allClients) { send(ws, { t: 'models' }); send(ws, { t: 'connections', connections: list }); } } });
modelStore.start().catch((e) => console.error('[models] discovery failed', e));
// A sign-in or sign-out re-checks the login and rediscovers that agent's models (in the background).
const signInChanged = (id) => () => { clearLoginCache(); modelStore.refresh([id]).catch(() => {}); };
// health: the compact status each Connections row shows (health.mjs), from the cached model and limit checks.
const agentEntry = (a, extra = {}) => ({ id: a.id, label: a.label, installed: () => a.available(), signedIn: () => a.loggedIn(), envFilter: a.envFilter, afterChange: signInChanged(a.id),
  health: (st) => healthRow(a.id, { ...st, version: st.installed ? agentVersion(a.id) : null, models: modelCatalog(a.id), limits: limitStore.get(a.id) }), ...extra });
// The head's Claude and Codex sign-ins, shared with its worker machines so none of them signs in (agent-share.mjs); set
// once the cluster hub exists. Codex needs nothing extra; Claude needs one long-lived token, made here once.
let agentShare = null;
const connections = createConnections({
  // Its own tmux socket: a test server on this machine must never clear the live server's sign-in in progress.
  tmux: tmuxRunnerFor(loginSocketFor(DATA, path.join(ROOT, 'data'))),
  log: (m) => console.log(`[connections] ${m}`),
  entries: [
    agentEntry(AGENTS.claude, { spec: SPECS.claude, account: () => AGENTS.claude.account() }),
    { id: 'claude-machines', label: 'Claude for your machines', installed: () => !!agentShare && AGENTS.claude.available(),
      signedIn: () => !!agentShare?.hasClaude(), envFilter: AGENTS.claude.envFilter,
      spec: { ...SPECS.claudeShare, logoutWarning: 'Your worker machines stop running Claude until you share it again. Codex stays shared.' },
      onCapture: (token) => { const r = agentShare.setClaudeToken(token); if (r.error) throw new Error(r.error); },
      logout: async () => agentShare.setClaudeToken(null),
      ui: { on: 'Shared with your machines', off: 'Not shared with your machines yet',
        connect: 'Share with machines', disconnect: 'Stop sharing' } },
    agentEntry(AGENTS.codex, { spec: SPECS.codex, account: () => codexAccount() }),
    { id: 'github', label: 'GitHub', installed: () => onPath('gh'), signedIn: () => gh.status().linked, account: () => gh.status().login,
      spec: SPECS.github, afterChange: () => gh.refresh() },
  ],
  onChange: () => { const list = connList(); for (const ws of allClients) send(ws, { t: 'connections', connections: list }); },
});
// Remote sign-in on worker machines (remote-login.mjs); set once the cluster hub exists. The controller's own rows carry
// `sharedWith`: the other machines signed in to the same account (they share one set of limits).
let remoteLogins = null;
const connList = () => (remoteLogins ? remoteLogins.annotate(connections.list()) : connections.list());

// Resource analyzer + reaper (resources.mjs). AGENT_ORCH_REAPER=on|dry|off; test instances (CW_DATA_DIR) only dry-run.
const resources = createResources({
  dataDir: DATA,
  mode: process.env.AGENT_ORCH_REAPER || (NO_ORCH || !orch ? 'off' : process.env.CW_DATA_DIR ? 'dry' : 'on'),
  isActive: (o) => (o.kind === 'task' ? !!orch?.isRunning(o.id) : runtimes.has(o.id) || agentTurns.has(o.id)),
  loginActive: () => connections.active(),
  log: (message, level = 'info') => { if (orch) orch.logEvent(message, { level }); else console.log(`[resources] ${message}`); },
});
if (orch) resources.start();

// Cluster (cluster.mjs, BRIEF goal 11): node registry in the orchestrator DB + the worker hub at WS_PATH. The controller
// is node 'controller'; its capacity comes from /proc. CW_CLUSTER_HEARTBEAT_MS shortens liveness in tests. Worker health:
// telemetry series in <DATA>/metrics/nodes, and the version check against this checkout's origin/main
// (AGENT_ORCH_OUTDATED_COMMITS: how far behind a worker may fall before it updates itself once idle).
let localCpus = null; // the controller's last /proc/stat reading, for its CPU % per core
const cluster = orch && createCluster({
  dbFile: path.join(DATA, 'orchestrator', 'agent-orch.db'),
  heartbeatMs: Number(process.env.CW_CLUSTER_HEARTBEAT_MS) || undefined,
  metricsDir: path.join(DATA, 'metrics', 'nodes'),
  repoDir: ROOT,
  outdatedAfter: Number(process.env.AGENT_ORCH_OUTDATED_COMMITS) || undefined,
  local: () => {
    const sys = readSystem(), swapUsed = sys.swapTotal ? (sys.swapTotal - (sys.swapFree || 0)) / sys.swapTotal : 0;
    const cpu = localCpus && cpuPercent(localCpus, sys.cpus);
    localCpus = sys.cpus;
    let disk = null;
    try { const f = fs.statfsSync(DATA); disk = { path: DATA, free: f.bavail * f.bsize, total: f.blocks * f.bsize }; } catch {}
    return {
      inventory: { cores: os.cpus().length, mem: os.totalmem(),
        agents: Object.values(AGENTS).map((a) => { const installed = !!a.available(); return { id: a.id, installed, signedIn: installed && !!a.loggedIn() }; }) },
      resources: { memAvailable: sys.memAvailable ?? os.freemem(), load: sys.load, swapUsedPct: Math.round(swapUsed * 1000) / 10, at: Date.now(),
        ...(cpu?.length ? { cpu } : {}), ...(disk ? { disk } : {}) },
    };
  },
  ext, // workers run with this machine's skills, subagents and MCP servers (the extension bundle)
  log: (m) => console.log(`[cluster] ${m}`),
  onChange: (kind) => (kind === 'resources' ? resourcesPush() : clusterPush()),
  // An auto-drain or a worker's self-update: in the event log, and a warning also as a toast in every open app.
  onNotice: ({ node, level, text }) => {
    orch?.logEvent(text, { level: level === 'warn' ? 'warn' : 'info' });
    if (level === 'warn') for (const ws of allClients) send(ws, { t: 'cluster', kind: 'notice', node, text });
  },
});
// 'cluster' pushes: the UI re-reads GET /api/cluster/nodes. A worker's periodic CPU/RAM reading ({kind: 'resources'},
// only the Machines view cares) goes out at most every 5 s.
function clusterPush(kind) { for (const ws of allClients) send(ws, kind ? { t: 'cluster', kind } : { t: 'cluster' }); }
let resourcesTimer = null;
function resourcesPush() { resourcesTimer ??= setTimeout(() => { resourcesTimer = null; clusterPush('resources'); }, 5000); }
// Personas travel in each job's system text; everything else is announced to the workers as it changes.
if (cluster) ext.onChange((kind) => { if (kind !== 'personas') cluster.syncExt(); });
// The scheduler places work on online workers through the hub (orchestrator.mjs `place`/`runRemote`).
if (cluster && !NO_ORCH) orch.attachCluster(cluster);
// Workers clone and push each project through here (GIT_PATH), with their node token; this head then pushes to GitHub.
const clusterGit = cluster && createClusterGit({ node: cluster.tokenNode, repo: orch.gitRepo, pushable: orch.pushableTasks, log: (m) => console.log(`[cluster-git] ${m}`) });
// Workers get the head's Claude token and Codex sign-in when they connect and whenever either changes; a worker whose
// Codex copy refreshed itself sends it back and the head keeps the newest (agent-share.mjs).
if (cluster) {
  agentShare = createAgentShare({ dataDir: DATA, send: (id, frame) => cluster.send(id, frame), targets: shareTargets(cluster),
    log: (m) => console.log(`[share] ${m}`),
    onChange: () => { const list = connList(); for (const ws of allClients) send(ws, { t: 'connections', connections: list }); } });
  wireAgentShare(cluster, agentShare, (m) => console.log(`[share] ${m}`));
}
// The owner's live browser views (Browser sheet, task drawers): profiles on this server or on workers (browser-view.mjs).
const browserViews = createBrowserViews({ cluster: () => cluster || null, tasks: () => orch?.browserTasks() || [], send: (ws, m) => send(ws, m),
  log: (m) => console.log(`[browser] ${m}`) });
orch?.attachBrowserViews(browserViews);
if (cluster) cluster.onMessage((id, msg) => browserViews.onCluster(id, msg));
if (cluster) remoteLogins = createRemoteLogins({ cluster, local: () => connections.list(),
  onChange: (node) => { const list = remoteLogins.list(node); for (const ws of allClients) send(ws, { t: 'connections', node, connections: list }); } });

// convo.repo mirrors the folder's real `origin` (a stale copy survives repo moves); cleared when there is none.
async function refreshRepo(convo) {
  if (!fs.existsSync(convo.cwd)) return false;
  const repo = await gh.remoteOf(convo.cwd);
  if (repo?.full === convo.repo?.full && repo?.url === convo.repo?.url) return false;
  if (repo) convo.repo = repo; else delete convo.repo;
  return true;
}
async function refreshAllRepos() {
  const changed = (await Promise.all(convos.map(refreshRepo))).some(Boolean);
  if (!changed) return;
  saveConvos();
  broadcastConvos();
  orch?.refreshProjects();
}
async function setupRepo(convo) {
  try {
    await refreshRepo(convo);
    convo.repo = await gh.ensureRepo(convo.cwd);
    convo.git = { ...(convo.git || {}), error: null };
  } catch (e) {
    convo.git = { ...(convo.git || {}), error: e.message };
  }
  saveConvos();
  broadcastConvos();
  orch?.refreshProjects();
}
async function syncGit(dir, message) {
  const c = convos.find((x) => x.cwd === dir);
  if (!c || !fs.existsSync(dir)) return;
  const r = message ? await gh.commitAndPush(dir, message) : await gh.push(dir);
  if (r.repo && r.repo.full !== c.repo?.full) { c.repo = r.repo; orch?.refreshProjects(); }
  // error (the chat's sticky 'not pushed') only once pushes have failed for 10 min or origin diverged; the queue retries a race.
  c.git = { pushedAt: r.ok ? Date.now() : c.git?.pushedAt || null, error: r.warn ? r.error : null, unpushed: r.ok ? 0 : await gh.unpushed(dir) };
  saveConvos();
  broadcastConvos();
}
// Anything that couldn't be pushed (offline, GitHub down, not linked yet) is retried.
if (!NO_ORCH) setInterval(async () => {
  try {
    if (!gh.status().linked && !(await gh.refresh()).linked) return;
    for (const c of convos) {
      if (!fs.existsSync(c.cwd)) continue;
      if (!c.repo) await setupRepo(c);
      else if (c.git?.error || (await gh.unpushed(c.cwd)) > 0) await syncGit(c.cwd);
    }
  } catch (e) { console.error('[github] retry failed', e); }
}, 3 * 60e3);
gh.refresh().then((s) => console.log(`[github] ${s.linked ? `linked as ${s.login}` : 'not linked'}`))
  .catch((e) => console.error('[github] refresh failed', e));

// Messages sent while the planner is still replying wait and go together as the next turn,
// so two turns never run on the same planner session at once.
const planQueue = new Map(); // convo id -> [text]
async function orchestratorTurn(convo, text, files = []) {
  emit(convo.id, userEvent(text, files));
  text += attachmentNote(files); // the planner (and the tasks it writes) use the files by path
  if (planning.has(convo.id)) {
    if (!planQueue.has(convo.id)) planQueue.set(convo.id, []);
    planQueue.get(convo.id).push(text);
    return;
  }
  planning.add(convo.id);
  broadcast(convo.id, { t: 'busy', busy: true });
  broadcastConvos();
  try {
    for (let next = text; next;) {
      await orch.planTurn(convo, next);
      if (!findConvo(convo.id)) break; // deleted mid-plan: don't re-plan (and reactivate) its project
      const waiting = planQueue.get(convo.id);
      next = waiting?.length ? waiting.splice(0).join('\n\n') : null;
    }
  } catch (e) {
    emit(convo.id, { t: 'error', text: `Orchestrator error: ${e?.message || e}` });
  } finally {
    planning.delete(convo.id);
    if (findConvo(convo.id)) { convo.updatedAt = Date.now(); saveConvos(); }
    broadcast(convo.id, { t: 'busy', busy: false });
    broadcastConvos();
  }
}

function inputQueue() {
  const queue = [];
  let wake = null;
  return {
    push(msg) { queue.push(msg); wake?.(); },
    async *iterate() {
      for (;;) {
        while (queue.length) yield queue.shift();
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : b.type === 'tool_reference' ? `Loaded tool ${b.tool_name}` : '')).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}
const clip = (s, n = 30000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);

function startRuntime(convo) {
  const input = inputQueue();
  // What the session starts with; a change to either restarts it at the next message (sendUserMessage).
  const rt = { push: input.push, busy: false, pending: new Map(), q: null, persona: personaOf(convo), mcp: ext.mcpRun('claude'), mcpSet: mcpSet() };

  const canUseTool = (toolName, toolInput, { signal, suggestions }) =>
    new Promise((resolve) => {
      const pid = crypto.randomUUID();
      const req = { pid, tool: toolName, input: toolInput, canAlways: !!suggestions?.length };
      // A push only if nobody answers within 15 s: an owner watching the chat gets no duplicate.
      const pushTimer = setTimeout(() => {
        if (rt.pending.has(pid)) notify({ title: 'Claude needs permission', body: `${convo.title}: ${toolName}`, tag: `perm-${convo.id}`, url: `/#${convo.id}` });
      }, PERM_PUSH_MS);
      pushTimer.unref?.();
      rt.pending.set(pid, { req, resolve, toolInput, suggestions, pushTimer });
      broadcast(convo.id, { t: 'perm', ...req });
      signal?.addEventListener('abort', () => {
        if (rt.pending.delete(pid)) broadcast(convo.id, { t: 'perm_done', pid, decision: 'cancelled' });
      });
    });

  rt.q = query({
    prompt: input.iterate(),
    options: {
      cwd: convo.cwd,
      resume: convo.sessionId || undefined,
      model: convo.model || undefined,
      ...(chatEffort(convo) && { effort: chatEffort(convo) }),
      permissionMode: sdkMode(convo.mode),
      // Lets the mode picker switch to "Bypass" later without restarting the session.
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: chatSystemAppend(convo) },
      ...(rt.mcp && { extraArgs: { 'mcp-config': rt.mcp } }),
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      env: withOwner(CLAUDE_ENV, 'chat', convo.id),
      canUseTool,
      stderr: (d) => process.stderr.write(`[claude ${convo.id.slice(0, 8)}] ${d}`),
    },
  });

  // A retired runtime's slot may already hold its replacement, which it must not delete or speak for (AUDIT #3).
  const owned = () => !rt.retired && runtimes.get(convo.id) === rt;
  (async () => {
    try {
      for await (const m of rt.q) if (!rt.retired) handleMessage(convo, rt, m);
      if (owned()) emit(convo.id, { t: 'error', text: 'Claude session ended. Send a message to resume it.' });
    } catch (err) {
      if (owned()) emit(convo.id, { t: 'error', text: String(err?.message || err) });
    } finally {
      for (const [pid, p] of rt.pending) p.resolve({ behavior: 'deny', message: 'Session closed' });
      if (!owned()) return;
      runtimes.delete(convo.id);
      broadcast(convo.id, { t: 'busy', busy: false });
      broadcastConvos();
    }
  })().catch((e) => console.error('[chat] runtime loop failed', convo.id, e));

  runtimes.set(convo.id, rt);
  return rt;
}

function handleMessage(convo, rt, m) {
  const cid = convo.id;
  if (m.session_id && convo.sessionId !== m.session_id) {
    convo.sessionId = m.session_id;
    saveConvos();
  }
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') {
        console.log(`[claude ${cid.slice(0, 8)}] init apiKeySource=${m.apiKeySource} model=${m.model}`);
        if (API_KEY_SOURCES.has(m.apiKeySource)) {
          emit(cid, { t: 'error', text: `Stopped: Claude was about to use an API key (${m.apiKeySource}), which bills API credits. Sign in with your Claude subscription in the Terminal (/login) instead.` });
          rt.q.close();
          break;
        }
        broadcast(cid, { t: 'init', model: m.model, cwd: m.cwd, mode: m.permissionMode });
      }
      break;
    case 'stream_event': {
      const e = m.event;
      if (!m.parent_tool_use_id && e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        broadcast(cid, { t: 'delta', text: e.delta.text });
      }
      break;
    }
    case 'assistant':
      // Context size of the latest model call: what the next call will have to read again.
      if (!m.parent_tool_use_id && m.message?.usage) {
        const u = m.message.usage;
        convo.ctxTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      }
      for (const b of m.message?.content || []) {
        const sub = !!m.parent_tool_use_id;
        if (b.type === 'text' && b.text.trim()) emit(cid, { t: 'text', text: b.text, sub });
        else if (b.type === 'tool_use') emit(cid, { t: 'tool_use', id: b.id, name: b.name, input: b.input, sub });
      }
      if (m.error) emit(cid, { t: 'error', text: authHint(m.error) });
      if (m.error === 'rate_limit') usageLog.limitHit('claude', null);
      break;
    case 'user': {
      const content = m.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result') {
            emit(cid, { t: 'tool_result', id: b.tool_use_id, text: clip(toolResultText(b.content)), isError: !!b.is_error });
            rt.media ||= mediaCollector(DATA, convo.cwd);
            for (const img of toolResultImages(b.content)) { const ev = rt.media.image(img); if (ev) emit(cid, { t: 'image', ...ev, tool: b.tool_use_id }); }
            emitShots(cid, rt.media);
          }
        }
      }
      break;
    }
    case 'result':
      rt.busy = false;
      if (rt.media) emitShots(cid, rt.media);
      usageLog.tokens('claude', m.usage, 'chat', cid);
      if (m.subtype === 'success' && !m.is_error) usageLog.limitCleared('claude');
      emit(cid, {
        t: 'result',
        ok: m.subtype === 'success' && !m.is_error,
        text: m.subtype === 'success' ? '' : m.subtype,
        // total_cost_usd is only an API-price estimate; on a subscription nothing is billed, so it isn't shown.
        ms: m.duration_ms,
        turns: m.num_turns,
      });
      convo.updatedAt = Date.now();
      saveConvos();
      broadcast(cid, { t: 'busy', busy: false });
      broadcastConvos();
      // GitHub protocol: whatever this reply changed is committed and pushed.
      syncGit(convo.cwd, `Chat: ${String(rt.lastUserText || 'update').replace(/\s+/g, ' ').slice(0, 72)}`)
        .catch((e) => console.error('[github] sync failed', convo.cwd, e));
      break;
  }
}

// Screenshots the agent saved under .agent-orch/shots/ since the turn started (or the last check).
function emitShots(cid, media) { for (const img of media.shots()) emit(cid, { t: 'image', ...img }); }

function authHint(code) {
  if (code === 'authentication_failed') {
    return 'Claude Code is not signed in on this server. Switch to Terminal and finish signing in, then try again.';
  }
  if (code === 'rate_limit') {
    return 'You have hit your Claude Pro usage limit. It resets on its own and nothing extra is charged. Run /usage in the Terminal to see when.';
  }
  if (code === 'billing_error') {
    return 'Claude reported a billing problem with your account. Check claude.ai → Settings → Billing.';
  }
  return `Claude returned an error: ${code}`;
}

// ---------- non-Claude chats: one runAgentCli turn per message, its normalised events shown as chat events ----------
const agentQueue = new Map(); // convo id -> [{text, images}] sent while a turn was running
// Queued messages (sent while a turn runs) go together as the next turn: their texts joined, their images all attached.
const takeQueued = (cid) => {
  const q = agentQueue.get(cid)?.splice(0) || [];
  return q.length ? { text: q.map((m) => m.text).join('\n\n'), images: q.flatMap((m) => m.images) } : null;
};
async function agentChatTurn(convo, text, files = []) {
  emit(convo.id, userEvent(text, files));
  const msg = { text: text + attachmentNote(files), images: files.filter((f) => f.image).map((f) => f.path) };
  if (agentTurns.has(convo.id)) {
    if (!agentQueue.has(convo.id)) agentQueue.set(convo.id, []);
    agentQueue.get(convo.id).push(msg);
    return;
  }
  const cid = convo.id;
  broadcast(cid, { t: 'busy', busy: true });
  for (let m = msg; m;) {
    const next = m.text;
    const agent = chatAgent(convo), a = AGENTS[agent], ac = new AbortController();
    // Only this chat's own agent's limit matters (never Claude's): while it's limited, say so and skip the turn.
    const lim = orch.limitResetFor(agent, convo.model);
    if (lim) {
      emit(cid, { t: 'error', until: lim.at, untilKnown: lim.known, text: `Not sent: ${lim.name} is at its usage limit${lim.known ? ' until {until}' : "; the reset time isn't known yet. Try again around {until}"}.` });
      emit(cid, { t: 'result', ok: false, text: 'rate_limited', ms: 0 });
      m = takeQueued(cid);
      continue;
    }
    agentTurns.set(cid, ac);
    broadcastConvos();
    const started = Date.now();
    const media = mediaCollector(DATA, convo.cwd);
    const turn = async (resume) => {
      try {
        return await runAgentCli({
          agent, prompt: resume ? personaSwitch(convo, next) : next, images: m.images, cwd: convo.cwd, resume, model: convo.model || undefined, effort: convo.effort || undefined, signal: ac.signal, env: withOwner(CLAUDE_ENV, 'chat', cid),
          onSpawn: ({ pid, pgid }) => registerPid({ pid, pgid, kind: 'chat', id: cid }),
          systemAppend: resume ? undefined : chatSystemAppend(convo), autonomous: convo.mode === 'bypassPermissions',
          onEvent: (e) => {
            if (e.k === 'text') emit(cid, { t: 'text', text: e.text });
            else if (e.k === 'tool') emit(cid, { t: 'tool_use', id: e.id, name: e.name, input: e.input });
            else if (e.k === 'tool_result') { emit(cid, { t: 'tool_result', id: e.id, text: clip(e.text || ''), isError: !!e.isError }); emitShots(cid, media); }
            else if (e.k === 'image') { const img = media.image(e); if (img) emit(cid, { t: 'image', ...img, tool: e.tool }); }
          },
        });
      } catch (e) {
        return { outcome: 'error', text: String(e?.message || e), stderr: '' };
      }
    };
    // A session id only resumes on the agent that created it.
    const resume = convo.agentSession?.agent === agent ? convo.agentSession.id : null;
    let res = await turn(resume);
    // The session is gone (errorCode 'no_session' or Claude's text): forget it and retry once fresh.
    if (resume && isMissingSession(res)) {
      convo.agentSession = null;
      res = await turn(null);
    }
    if (res.sessionId) convo.agentSession = { agent, id: res.sessionId, persona: personaOf(convo) };
    emitShots(cid, media);
    usageLog.tokens(agent, res.usage, 'chat', cid);
    usageLog.windows(agent, res.windows);
    orch.recordLimit(res, agent, convo.model); // blocks/unblocks only this agent (tasks routed to it follow) and logs usage history
    if (res.outcome === 'auth_error') emit(cid, { t: 'error', text: `${a.label} is not signed in on this server. ${a.login}.` });
    else if (res.outcome === 'rate_limited') emit(cid, { t: 'error', text: `${a.label} hit its ${res.limitType ? windowLabel(res.limitType) : 'usage'} limit${res.resetsAt ? '; it resets {until}' : ''}.`, ...(res.resetsAt && { until: res.resetsAt, untilKnown: true }) });
    else if (res.outcome === 'aborted') emit(cid, { t: 'notice', text: 'Interrupted' });
    else if (res.outcome !== 'ok') emit(cid, { t: 'error', text: `${a.label} failed: ${String(res.text || res.stderr || res.outcome).trim().slice(-600)}` });
    emit(cid, { t: 'result', ok: res.outcome === 'ok', text: res.outcome === 'ok' ? '' : res.outcome, ms: Date.now() - started, turns: res.numTurns });
    agentTurns.delete(cid);
    convo.updatedAt = Date.now();
    saveConvos();
    syncGit(convo.cwd, `Chat: ${String(next).replace(/\s+/g, ' ').slice(0, 72)}`).catch((e) => console.error('[github] sync failed', convo.cwd, e));
    m = res.outcome === 'aborted' ? null : takeQueued(cid);
  }
  agentQueue.delete(cid);
  broadcast(cid, { t: 'busy', busy: false });
  broadcastConvos();
}

// files: attachments already placed in the project (uploads.mjs placeUploads). The log shows them with the owner's text;
// the agent gets the text plus where they are, and sees images directly (Claude: image blocks, Codex: -i).
const userEvent = (text, files) => ({ t: 'user', text, ...(files?.length && { attachments: files.map(attachmentView) }) });
async function sendUserMessage(convo, text, files = []) {
  // A non-Claude chat depends only on its own agent: no Claude sign-in or limit check.
  if (chatAgent(convo) !== 'claude') return convo.mode === 'orchestrator' ? orchestratorTurn(convo, text, files) : agentChatTurn(convo, text, files);
  if (!onSubscription()) await refreshClaudeAuth();
  if (!onSubscription()) {
    emit(convo.id, userEvent(text, files));
    emit(convo.id, {
      t: 'error',
      text: claudeAuth.loggedIn
        ? `Not sent: Claude Code is signed in with "${claudeAuth.authMethod}", not your Claude subscription. Run /login in the Terminal and choose your Claude account.`
        : 'Not sent: Claude Code is not signed in. Open the Terminal and sign in with your Claude account.',
    });
    return;
  }
  if (convo.mode === 'orchestrator') return orchestratorTurn(convo, text, files);
  // Orchestrator-style context control: a session that has grown past the limit is retired, and the next
  // message starts a fresh one carrying the project memory (.agent-orch/) and a recap of the recent chat.
  let prompt = text + attachmentNote(files);
  if (convo.sessionId && (convo.ctxTokens || 0) > CHAT_CONTEXT_LIMIT) {
    retireRuntime(runtimes, convo.id);
    const recap = chatRecap(convo.id);
    convo.sessionId = null;
    convo.ctxTokens = 0;
    emit(convo.id, { t: 'notice', text: 'This chat was getting long, so it continues in a fresh session with the project memory and a recap of the recent conversation. That keeps replies fast and uses less of your plan.' });
    prompt = `[This conversation continues from an earlier session in this project that grew too long. Recent conversation:]\n${recap}\n\n[New message]\n${text}${attachmentNote(files)}`;
  }
  // A persona or MCP servers changed since the session started apply from the next message: a fresh runtime, same session.
  const live = runtimes.get(convo.id);
  if (live && !live.busy && (live.persona !== personaOf(convo) || live.mcpSet !== mcpSet())) retireRuntime(runtimes, convo.id);
  const rt = runtimes.get(convo.id) || startRuntime(convo);
  rt.lastUserText = text;
  if (!rt.busy || !rt.media) rt.media = mediaCollector(DATA, convo.cwd); // a queued message keeps the running turn's snapshot
  convo.updatedAt = Date.now();
  saveConvos();
  emit(convo.id, userEvent(text, files));
  rt.busy = true;
  broadcast(convo.id, { t: 'busy', busy: true });
  broadcastConvos();
  const images = claudeImageBlocks(files);
  rt.push({ type: 'user', message: { role: 'user', content: images.length ? [{ type: 'text', text: prompt }, ...images] : prompt }, parent_tool_use_id: null });
}

const CHAT_CONTEXT_LIMIT = 120000; // tokens of context before a chat rolls over to a fresh session
function chatRecap(cid, budget = 6000) {
  const lines = [];
  let used = 0;
  for (const ev of readLog(cid).reverse()) {
    if (ev.t !== 'user' && !(ev.t === 'text' && !ev.sub)) continue;
    const line = `${ev.t === 'user' ? 'Owner' : 'Claude'}: ${String(ev.text).replace(/\s+/g, ' ').slice(0, 800)}`;
    if (used + line.length > budget) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.join('\n') || '(no earlier messages)';
}
// A resumed non-Claude session got its system text (and persona) only when it started: a persona picked since is
// told to it with the next message.
function personaSwitch(convo, text) {
  const now = personaOf(convo);
  if ((convo.agentSession?.persona ?? null) === now) return text;
  return `${now ? `[The owner switched this chat's persona.]\n${now}` : "[The owner cleared this chat's persona: stop following the earlier one.]"}\n\n[Message]\n${text}`;
}
// Every chat session starts knowing the project's durable memory, shared with the orchestrator, and the chat's persona.
function chatSystemAppend(convo) {
  orch.initMemory(convo.cwd);
  const mem = orch.readMemory(convo.cwd), persona = personaOf(convo);
  return `This project keeps durable memory in .agent-orch/, shared with the project's orchestrator:
- .agent-orch/BRIEF.md: what the project is, its goals and definition of done
- .agent-orch/CONTEXT.md: architecture, conventions, decisions, gotchas
When you learn a durable fact a future session needs, update .agent-orch/CONTEXT.md in a line or two (edit existing lines; it is not a log).
After each of your replies, changes are committed and pushed to the project's GitHub repo automatically, so don't run git commit or git push yourself.
This is the owner's disposable server and you have full access: run any command without asking, and install whatever you need (passwordless sudo, e.g. \`sudo apt-get install -y …\`, plus npm and pip).
${SHOT_HINT}

Current .agent-orch/BRIEF.md:
${mem.brief || '(empty)'}

Current .agent-orch/CONTEXT.md:
${mem.context || '(empty)'}${persona ? `\n\n${persona}` : ''}`;
}

function answerPermission(convo, msg) {
  const rt = runtimes.get(convo.id);
  const p = rt?.pending.get(msg.pid);
  if (!p) return;
  rt.pending.delete(msg.pid);
  clearTimeout(p.pushTimer);
  const { toolInput, suggestions } = p;
  let decision = msg.decision;
  if (decision === 'deny') {
    p.resolve({ behavior: 'deny', message: msg.message || 'The user declined this action.' });
  } else if (p.req.tool === 'AskUserQuestion') {
    p.resolve({ behavior: 'allow', updatedInput: { ...toolInput, answers: msg.answers || {} } });
    decision = 'answered';
  } else {
    const result = { behavior: 'allow', updatedInput: toolInput };
    if (decision === 'always' && suggestions?.length) result.updatedPermissions = suggestions;
    p.resolve(result);
    if (p.req.tool === 'ExitPlanMode') {
      const mode = MODES.includes(msg.nextMode) ? msg.nextMode : 'acceptEdits';
      convo.mode = mode;
      saveConvos();
      rt.q.setPermissionMode(mode).catch(() => {});
      broadcast(convo.id, { t: 'mode', mode });
    }
  }
  emit(convo.id, { t: 'perm_done', pid: msg.pid, tool: p.req.tool, input: p.req.input, decision, answers: msg.answers });
}

// ---------- terminals ----------
const tmux = (args) => new Promise((resolve) => execFile('tmux', args, { timeout: 5000 }, (err, out) => resolve(err ? '' : out)));
async function listTerminals() {
  const out = await tmux(['list-sessions', '-F', '#{session_name}|#{session_created}|#{session_attached}']);
  return out.trim().split('\n').filter(Boolean).map((l) => {
    const [name, created, attached] = l.split('|');
    return { name, created: Number(created), attached: Number(attached) > 0 };
  }).filter((t) => /^[A-Za-z0-9_-]{1,32}$/.test(t.name)).sort((a, b) => a.created - b.created);
}

// ---------- HTTP ----------
const MIME = { '.mp3': 'audio/mpeg', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const VENDOR = {
  '/vendor/marked.js': 'node_modules/marked/lib/marked.umd.js',
  '/vendor/purify.js': 'node_modules/dompurify/dist/purify.min.js',
};

function serveFile(res, file, extraHeaders = {}) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...extraHeaders });
    res.end(buf);
  });
}
function json(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
// Settles on every path: an oversized, malformed or aborted body rejects with an HttpError the server wrapper answers.
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const SOUND_FILE = path.join(DATA, 'sounds', 'task-done.mp3'), MAX_SOUND_BYTES = 2 * 1024 * 1024;
// ID3 tag, or an MPEG audio frame sync (11 set bits).
const isMp3 = (b) => b.length > 3 && (b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0));
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > max) { done = true; req.pause(); reject(new HttpError(413, `File too large (max ${max / 1024 / 1024} MB)`)); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    req.on('data', (c) => {
      if (done) return;
      data += c;
      // Stop reading but keep the socket so the 413 can still go out; the wrapper closes it after.
      if (data.length > 1e6) { req.pause(); fail(new HttpError(413, 'Body too large')); }
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      let v;
      try { v = JSON.parse(data || '{}'); } catch { return reject(new HttpError(400, 'Bad JSON body')); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'Body must be a JSON object'));
      resolve(v);
    });
    req.on('error', () => fail(new HttpError(400, 'Body read failed')));
    req.on('close', () => fail(new HttpError(400, 'Body aborted')));
  });
}

// The sign-in page, the manifest and the app icons (favicons, home-screen icons, the splash mascot) load without a session.
const PUBLIC_PATHS = new Set(['/login', '/login.css', '/manifest.webmanifest', '/favicon.ico', '/favicon-16.png', '/favicon-32.png', '/apple-touch-icon.png',
  '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/logo.png', '/mascot.png']);

// Last-resort guard: a throw in a handler must answer 500, not take the process down.
const server = http.createServer(async (req, res) => {
  try { await handleRequest(req, res); } catch (e) {
    if (e instanceof HttpError) {
      if (res.headersSent || res.destroyed) return res.destroy();
      if (e.status === 413) res.on('finish', () => req.destroy());
      return json(res, e.status, { error: e.message }, e.status === 413 ? { Connection: 'close' } : {});
    }
    console.error('request error', req.method, req.url, e);
    if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); } else res.destroy();
  }
});

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');

  // Caddy asks this before letting a request through to the terminal.
  if (p === '/auth/check') {
    if (isAuthed(req)) { res.writeHead(200); return res.end(); }
    res.writeHead(401); return res.end();
  }

  if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'Bad origin' });

  // The worker install scripts, for the "Add machine" one-liners (`curl … | bash`). Not secret: the pairing code is.
  const inst = INSTALL_SCRIPTS[p];
  if (inst && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(ROOT, 'bin', inst)));
  }
  // Liveness, without a session: a worker's Ping and the owner's one-liner for a disconnected machine test the head with it.
  if (p === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) return json(res, 200, { ok: true });
  // A worker asks whether the head still knows it (its node token is the credential; a wrong one counts as a failure).
  if (p === WHOAMI_PATH && req.method === 'GET') {
    if (!cluster) return json(res, 503, { error: 'cluster unavailable' });
    const ip = clientIp(req), wait = lockedFor(ip);
    if (wait) return json(res, 429, { error: 'locked', retryInSec: Math.ceil(wait / 1000) });
    const r = cluster.whoami(req.headers);
    if (r.status === 401) recordFailure(ip);
    return r.error ? json(res, r.status, { error: r.error }) : json(res, 200, r);
  }
  // A worker trades a one-time pairing code for its node token (no session: the code is the credential).
  if (p === CLAIM_PATH && req.method === 'POST') {
    if (!cluster) return json(res, 503, { error: 'cluster unavailable' });
    const ip = clientIp(req), wait = lockedFor(ip);
    if (wait) return json(res, 429, { error: 'locked', retryInSec: Math.ceil(wait / 1000) });
    const r = cluster.claim(await readBody(req));
    if (r.status === 401) recordFailure(ip);
    return r.error ? json(res, r.status, { error: r.error }) : json(res, 200, r);
  }
  // A worker's git clone, fetch or push of a project (smart HTTP, its node token; no session).
  if (p.startsWith(`${GIT_PATH}/`)) {
    if (!clusterGit) return json(res, 503, { error: 'cluster unavailable' });
    const ip = clientIp(req), wait = lockedFor(ip);
    if (wait) return json(res, 429, { error: 'locked', retryInSec: Math.ceil(wait / 1000) });
    if ((await clusterGit.handle(req, res)) === 401) recordFailure(ip);
    return;
  }
  // A worker fetches the extension bundle with its node token (no session).
  if (p === EXT_PATH && req.method === 'GET') return cluster ? cluster.handleExt(req, res) : json(res, 503, { error: 'cluster unavailable' });
  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const wait = lockedFor(ip);
    if (wait) return json(res, 429, { error: 'locked', retryInSec: Math.ceil(wait / 1000) });
    const body = await readBody(req);
    // Re-check after the await: a parallel burst all passed the first check before any failure was recorded.
    const wait2 = lockedFor(ip);
    if (wait2) return json(res, 429, { error: 'locked', retryInSec: Math.ceil(wait2 / 1000) });
    if (!checkPassword(body.password || '')) {
      const left = recordFailure(ip);
      const w = lockedFor(ip);
      if (w) return json(res, 429, { error: 'locked', retryInSec: Math.ceil(w / 1000) });
      return json(res, 401, { error: 'wrong', attemptsLeft: left });
    }
    attempts.delete(ip);
    const s = newSession(!!body.remember);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, s.token, s.remember ? s.ttl / 1000 : null) });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const t = sessionToken(req);
    if (t) { delete sessions[t]; writeJSON('sessions.json', sessions); }
    // Over HTTPS also expire the pre-#34 Secure `cw_session` so it can't linger.
    const clear = [sessionCookie(req, '', 0)];
    if (isHttps(req)) clear.push(`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return json(res, 200, { ok: true }, { 'Set-Cookie': clear });
  }

  if (p === '/sounds/task-done.mp3') {
    return serveFile(res, path.join(PUBLIC, p), { 'Cache-Control': 'public, max-age=31536000, immutable' });
  }

  if (PUBLIC_PATHS.has(p)) {
    if (p === '/login') {
      if (isAuthed(req)) { res.writeHead(302, { Location: '/' }); return res.end(); }
      return serveFile(res, path.join(PUBLIC, 'login.html'));
    }
    return serveFile(res, path.join(PUBLIC, p));
  }

  if (!isAuthed(req)) {
    if (p.startsWith('/api/')) return json(res, 401, { error: 'Not signed in' });
    res.writeHead(302, { Location: '/login' }); return res.end();
  }

  if (VENDOR[p]) return serveFile(res, path.join(ROOT, VENDOR[p]));
  if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC, 'index.html'));
  if (p === '/app.js' || p === '/app.css' || p === '/files.js' || p === '/files.css' || p === '/ext.js' || p === '/ext.css' || p === '/stats.js' || p === '/stats.css' || p === '/browser.js' || p === '/browser.css') return serveFile(res, path.join(PUBLIC, p));
  // The Files view: listing, preview, and copy/move/zip/unzip inside one chat's project folder (files.mjs).
  if (handleFiles(req, res, url, { rootFor: (cid) => findConvo(cid)?.cwd || null, json, readBody })) return;

  if (p === '/api/status') {
    if (!onSubscription() && Date.now() - claudeAuth.checkedAt > 5000) await refreshClaudeAuth();
    return json(res, 200, {
      claudeSignedIn: onSubscription(), claudeAuth, host: DEVICE_NAME, workspace: WORKSPACE,
      restartPending, commitsSinceBoot: commitsSinceBoot(),
    });
  }
  // Stop claiming tasks, then exit once the running ones and every chat reply/planner turn finish; systemd
  // (Restart=always) brings the app back. `{cancel:true}` stops the drain and task claiming resumes.
  if (p === '/api/restart-when-idle' && req.method === 'POST') {
    if ((await readBody(req)).cancel) {
      if (restartPending) {
        restartPending = false; restartGen++;
        autoRestartSkipHead = await git(['rev-parse', 'HEAD']);
        orch.undrain();
        console.log('[restart] cancelled');
      }
      for (const ws of allClients) send(ws, { t: 'status', restartPending });
      return json(res, 200, { draining: false });
    }
    startRestartDrain('draining');
    return json(res, 202, { draining: true });
  }
  if (p === '/api/metrics/history') {
    return json(res, 200, historyFor(url.searchParams.get('range') || '1h'));
  }
  // The Stats sheet: everything you and the orchestrator did, raw; the browser slices and summarises it (stats.mjs).
  if (p === '/api/stats' && req.method === 'GET') return json(res, 200, await stats.collect({ fresh: url.searchParams.has('fresh') }));
  if (p === '/api/usage/history') {
    const range = url.searchParams.get('range') || '24h';
    if (!USAGE_RANGES[range]) return json(res, 400, { error: 'range must be 6h, 24h, 7d or 30d' });
    return json(res, 200, usageLog.history(range, Object.keys(AGENTS))); // removed agents' old readings stay out
  }
  if (p === '/api/metrics') {
    return json(res, 200, await metrics(Number(url.searchParams.get('since')) || 0));
  }
  if (p === '/api/convos' && req.method === 'GET') {
    // ?q= searches titles and messages (search.mjs); without it, the plain list.
    const q = url.searchParams.get('q');
    if (q?.trim()) return json(res, 200, await searchConvos({ logsDir: LOGS, convos, q: q.slice(0, 200), limit: 20 }));
    return json(res, 200, convos.map(publicConvo));
  }
  if (p === '/api/convos' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      // A new project gets its own folder under ~/workspace, named by the user or from the first message.
      const cwd = body.newProject
        ? uniqueProjectDir(slugify(body.newProject.name) || slugify(body.newProject.fromText, true) || 'project')
        : safeCwd(body.folder);
      const existing = convos.find((c) => c.cwd === cwd);
      if (existing) { // one chat per project
        if (await refreshRepo(existing)) { saveConvos(); broadcastConvos(); orch?.refreshProjects(); }
        return json(res, 200, existing);
      }
      // Mandatory protocol: every project lives in a GitHub repo, so GitHub must be linked first.
      if (!gh.status().linked && !(await gh.refresh()).linked) {
        return json(res, 409, { error: 'Link GitHub first: every project gets its own GitHub repo.', github: false });
      }
      fs.mkdirSync(cwd, { recursive: true });
      const c = { id: crypto.randomUUID(), title: path.basename(cwd), cwd, mode: MODES.includes(body.mode) ? body.mode : 'bypassPermissions', model: '', createdAt: Date.now(), updatedAt: Date.now() };
      convos.unshift(c);
      saveConvos();
      broadcastConvos();
      setupRepo(c).catch((e) => console.error('[github] setup failed', c.cwd, e));
      return json(res, 200, c);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  const m = p.match(/^\/api\/convos\/([\w-]+)$/);
  if (m) {
    const c = findConvo(m[1]);
    if (!c) return json(res, 404, { error: 'No such chat' });
    if (req.method === 'DELETE') {
      retireRuntime(runtimes, c.id);
      agentQueue.delete(c.id);
      agentTurns.get(c.id)?.abort();
      planQueue.delete(c.id);
      orch.abortPlan(c.id);
      orch.detachConvo(c.id); // its project's background work pauses; the folder and tasks are kept
      convos = convos.filter((x) => x.id !== c.id);
      saveConvos();
      fs.rmSync(logPath(c.id), { force: true });
      broadcastConvos();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (typeof body.title === 'string' && body.title.trim()) { c.title = body.title.trim().slice(0, 80); c.renamed = true; }
      saveConvos();
      broadcastConvos();
      return json(res, 200, c);
    }
  }
  // Browser profiles per machine, a profile's signed-in sites (cookie domains, never values) and clearing one.
  if (p === '/api/browser/task' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) return json(res, 400, { error: 'prompt is required' });
    try {
      const profile = await browserViews.profile(body.node, body.identity);
      const r = orch.createBrowserTask({ prompt: body.prompt, ...profile });
      return json(res, r.error ? 400 : 201, r);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/browser/tasks' && req.method === 'GET') {
    return json(res, 200, orch.listBrowserTasks({ identity: url.searchParams.get('identity') || '', node: url.searchParams.get('node') || '' }));
  }
  const browserStop = p.match(/^\/api\/browser\/task\/(\d+)\/stop$/);
  if (browserStop && req.method === 'POST') {
    const r = orch.stopBrowserTask(Number(browserStop[1]));
    return json(res, r.error ? r.status || 400 : 200, r);
  }
  if (p === '/api/browser' && req.method === 'GET') return json(res, 200, { nodes: await browserViews.list() });
  if ((p === '/api/browser/sites' && req.method === 'GET') || (p === '/api/browser/clear' && req.method === 'POST')) {
    const q = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://x').searchParams) : await readBody(req);
    try {
      return json(res, 200, p.endsWith('/sites') ? { sites: await browserViews.sites(String(q.node || BV_LOCAL), q.identity) } : { ok: await browserViews.clear(String(q.node || BV_LOCAL), q.identity) });
    } catch (e) { return json(res, 409, { error: e.message }); }
  }
  if (p.startsWith('/api/cluster/') && !cluster) return json(res, 503, { error: 'cluster unavailable' });
  if (p === '/api/cluster/nodes' && req.method === 'GET') return json(res, 200, { nodes: orch.machines(cluster.listNodes()) });
  // "Add machine": a pairing code, {uses: N} for one code that pairs N machines (valid 1 h); DELETE revokes a code.
  if (p === PAIR_PATH && req.method === 'POST') { const r = cluster.createPairing(await readBody(req)); return r.error ? json(res, r.status, { error: r.error }) : json(res, 200, r); }
  const pcode = p.match(/^\/api\/cluster\/pair\/([\w-]{1,20})$/);
  if (pcode && req.method === 'GET') return json(res, 200, cluster.pairing(pcode[1]));
  if (pcode && req.method === 'DELETE') { const r = cluster.revokePairing(pcode[1]); return r.error ? json(res, r.status, { error: r.error }) : json(res, 200, r); }
  const cnode = p.match(/^\/api\/cluster\/nodes\/([\w-]+)$/);
  if (cnode && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const r = req.method === 'PATCH' ? cluster.update(cnode[1], await readBody(req)) : cluster.revoke(cnode[1]);
    return r.error ? json(res, r.status, { error: r.error }) : json(res, 200, r);
  }
  // A node's health: its telemetry series (?range=15m|1h|6h|24h), its log tail fetched over the socket (?tail=200),
  // the owner's "Update" (the worker pulls and restarts once idle) and "Ping" (a round trip and the worker's network
  // self-check; a disconnected node: its last seen and a command to test the head from it).
  const nsub = p.match(/^\/api\/cluster\/nodes\/([\w-]+)\/(metrics|logs|update|ping)$/);
  if (nsub) {
    const [, id, what] = nsub;
    let r = null;
    if (what === 'metrics' && req.method === 'GET') r = cluster.metrics(id, url.searchParams.get('range') || '1h');
    else if (what === 'logs' && req.method === 'GET') r = await cluster.logsTail(id, Number(url.searchParams.get('tail')) || 200);
    else if (what === 'update' && req.method === 'POST') r = cluster.requestUpdate(id);
    else if (what === 'ping' && req.method === 'POST') r = await cluster.ping(id, { headUrl: `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}` });
    if (r) return r.error ? json(res, r.status, { error: r.error }) : json(res, 200, r);
  }
  if (p === '/api/resources' && req.method === 'GET') return json(res, 200, resources.summary());
  if (p === '/api/resources/kill' && req.method === 'POST') {
    const pid = Number((await readBody(req)).pid);
    if (!Number.isInteger(pid) || pid <= 1) return json(res, 400, { error: 'pid required' });
    const r = resources.killPid(pid);
    return json(res, r.error ? r.status : 200, r);
  }
  // Settings → This project: its reflection model {model: {agent, model} | null} and/or fallbacks {fallbacks: [...] | null}.
  const rs = p.match(/^\/api\/orch\/projects\/(\d+)\/reflect-settings$/);
  if (rs && req.method === 'PUT') {
    const body = await readBody(req), v = {};
    if ('model' in body) {
      if (body.model == null) v.model = null;
      else {
        const { list, error } = checkFallbacks([body.model]);
        if (error) return json(res, 400, { error });
        v.model = list[0];
      }
    }
    if ('fallbacks' in body) {
      const { list, error } = checkFallbacks(body.fallbacks);
      if (error) return json(res, 400, { error });
      v.fallbacks = list;
    }
    if (!Object.keys(v).length) return json(res, 400, { error: 'Expected model and/or fallbacks' });
    const r = orch.setReflectSettings(Number(rs[1]), v);
    return json(res, r.error ? r.status : 200, r.error ? { error: r.error } : r);
  }
  // The task-finished sound: an owner-uploaded MP3 (<DATA>/sounds/task-done.mp3) replaces /sounds/task-done.mp3.
  if (p === '/api/settings') {
    const st = fs.statSync(SOUND_FILE, { throwIfNoEntry: false });
    return json(res, 200, { sound: { custom: !!st, at: st ? Math.floor(st.mtimeMs) : null } });
  }
  if (p === '/api/settings/sound' && req.method === 'GET') {
    return fs.readFile(SOUND_FILE, (err, buf) => {
      if (err) return json(res, 404, { error: 'No custom sound' });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'private, no-cache',
        'Content-Security-Policy': "default-src 'none'; sandbox" });
      res.end(buf);
    });
  }
  // Composer attachments (uploads.mjs): POST the raw bytes (X-File-Name: the URI-encoded name) → {id, name, size, type,
  // image?}; the message then names them by id. GET serves one back: images inline, anything else as a download.
  if (p === '/api/uploads' && req.method === 'POST') {
    const buf = await readRaw(req, MAX_UPLOAD_BYTES); // a 413 goes out through the handler's HttpError path
    let name = 'file';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch {}
    const r = saveUpload(DATA, buf, { name, type: req.headers['content-type'] });
    return json(res, r.error ? r.status : 200, r.error ? { error: r.error } : attachmentView(r));
  }
  const up = p.match(/^\/api\/uploads\/([a-f0-9]{24})$/);
  if (up && req.method === 'GET') {
    const u = readUpload(DATA, up[1]);
    if (!u) return json(res, 404, { error: 'Not found' });
    return fs.readFile(u.file, (err, buf) => {
      if (err) return json(res, 404, { error: 'Not found' });
      // Only sniffed images render in the page; everything else downloads and is never interpreted by the browser.
      res.writeHead(200, { 'Content-Type': u.image ? u.type : 'application/octet-stream', 'Content-Length': buf.length,
        'Content-Disposition': `${u.image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(u.name)}`,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'; sandbox" });
      res.end(buf);
    });
  }
  if (p === '/api/settings/sound' && req.method === 'POST') {
    const buf = await readRaw(req, MAX_SOUND_BYTES); // a 413 goes out through the handler's HttpError path
    if (!isMp3(buf)) return json(res, 400, { error: 'Not an MP3 file' });
    fs.mkdirSync(path.dirname(SOUND_FILE), { recursive: true });
    fs.writeFileSync(SOUND_FILE + '.tmp', buf);
    fs.renameSync(SOUND_FILE + '.tmp', SOUND_FILE);
    return json(res, 200, { ok: true, sound: { custom: true, at: Date.now() } });
  }
  if (p === '/api/settings/sound' && req.method === 'DELETE') {
    fs.rmSync(SOUND_FILE, { force: true });
    return json(res, 200, { ok: true, sound: { custom: false, at: null } });
  }
  // Web Push: the VAPID key for the browser's applicationServerKey; POST a PushSubscription JSON, DELETE {endpoint}.
  if (p === '/api/push/key' && req.method === 'GET') return json(res, 200, { key: push.publicKey(), subscribed: push.count() });
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const body = await readBody(req);
    const error = checkSub(body);
    if (error) return json(res, 400, { error });
    return json(res, 200, { ok: true, subscribed: push.subscribe({ ...body, ua: req.headers['user-agent'] }) });
  }
  if (p === '/api/push/subscribe' && req.method === 'DELETE') {
    const { endpoint } = await readBody(req);
    if (typeof endpoint !== 'string' || !endpoint) return json(res, 400, { error: 'Expected endpoint' });
    return json(res, 200, { ok: true, removed: push.unsubscribe(endpoint), subscribed: push.count() });
  }
  if (p === '/api/orch/parallel' && req.method === 'PUT') {
    const result = orch.setParallelSettings(await readBody(req));
    return json(res, result.error ? 400 : 200, result);
  }
  // The approval gate (gate.mjs): held outbound calls, the owner's answer {decision: approve | always | deny, reason?},
  // a task's Actions timeline (its audit log + approvals), and the settings {patterns, ttlHours}.
  if (p === '/api/orch/approvals' && req.method === 'GET') return json(res, 200, { approvals: orch.pendingApprovals() });
  const oap = p.match(/^\/api\/orch\/approvals\/([\w-]{6,64})$/);
  if (oap && req.method === 'POST') {
    const r = orch.decideApproval(oap[1], await readBody(req));
    return json(res, r.error ? r.status || 400 : 200, r);
  }
  const oac = p.match(/^\/api\/orch\/tasks\/(\d+)\/actions$/);
  if (oac && req.method === 'GET') {
    const r = orch.taskActions(Number(oac[1]));
    return r ? json(res, 200, r) : json(res, 404, { error: 'No such task' });
  }
  if (p === '/api/orch/gate' && req.method === 'GET') return json(res, 200, orch.gateSettings());
  if (p === '/api/orch/gate' && req.method === 'PUT') {
    const r = orch.setGateSettings(await readBody(req));
    return json(res, r.error ? 400 : 200, r);
  }
  const tf = p.match(/^\/api\/orch\/tasks\/(\d+)\/fallbacks$/);
  if (tf && req.method === 'PATCH') {
    const { list, error } = checkFallbacks((await readBody(req)).fallbacks);
    if (error) return json(res, 400, { error });
    const r = orch.setTaskFallbacks(Number(tf[1]), list);
    return json(res, r.error ? r.status : 200, r.error ? { error: r.error } : r);
  }
  // Pin a queued work task to one machine: {node: '<node id>' | 'controller' | null (any machine)}.
  const tro = p.match(/^\/api\/orch\/tasks\/(\d+)\/run-on$/);
  if (tro && req.method === 'PATCH') {
    const node = (await readBody(req)).node;
    if (node != null && typeof node !== 'string') return json(res, 400, { error: 'node must be a machine id or null' });
    const r = orch.setTaskRunOn(Number(tro[1]), node || null);
    return json(res, r.error ? r.status : 200, r.error ? { error: r.error } : r);
  }
  // Reflection fallbacks for a project's reflection-queued tasks: {fallbacks: [{agent, model}] | null}, same rules as a chat's.
  const rf = p.match(/^\/api\/orch\/projects\/(\d+)\/reflect-fallbacks$/);
  if (rf && req.method === 'PUT') {
    const { list, error } = checkFallbacks((await readBody(req)).fallbacks);
    if (error) return json(res, 400, { error });
    const r = orch.setReflectFallbacks(Number(rf[1]), list);
    return json(res, r.error ? r.status : 200, r.error ? { error: r.error } : r);
  }
  // A chat's fallbacks: {fallbacks: [{agent, model}] | null}, in order; its queued tasks snapshot the list and move down
  // it when their model is limited (null or [] = they wait). Every entry must be a discovered model of a known agent.
  const cf = p.match(/^\/api\/convos\/([\w-]+)\/fallbacks$/);
  if (cf && req.method === 'PUT') {
    const c = findConvo(cf[1]);
    if (!c) return json(res, 404, { error: 'No such chat' });
    const body = await readBody(req);
    const { list, error } = checkFallbacks(body.fallbacks);
    if (error) return json(res, 400, { error });
    c.fallbacks = list;
    saveConvos();
    broadcastConvos();
    return json(res, 200, publicConvo(c));
  }
  // A chat's reasoning effort: {effort: level | null}. null = the agent's default; a level must be one the chat's agent
  // declares (Claude and Codex only). Chat turns and the project's tasks read it live (at their next session boundary).
  const ce = p.match(/^\/api\/convos\/([\w-]+)\/effort$/);
  if (ce && req.method === 'PUT') {
    const c = findConvo(ce[1]);
    if (!c) return json(res, 404, { error: 'No such chat' });
    const { effort = null } = await readBody(req);
    const levels = agentEfforts(chatAgent(c));
    if (effort !== null && !levels.includes(effort)) {
      return json(res, 400, { error: levels.length ? `effort must be one of ${levels.join(', ')} or null` : `${chatAgent(c)} has no effort levels` });
    }
    c.effort = effort;
    saveConvos();
    applyChatEffort(c);
    broadcastConvos();
    return json(res, 200, publicConvo(c));
  }
  // A chat's persona: {persona: id | null}. Claude chats switch at their next message; its project's planner and tasks
  // take it at their next session start.
  const cpers = p.match(/^\/api\/convos\/([\w-]+)\/persona$/);
  if (cpers && req.method === 'PUT') {
    const c = findConvo(cpers[1]);
    if (!c) return json(res, 404, { error: 'No such chat' });
    const { persona = null } = await readBody(req);
    if (persona !== null && !ext.persona(persona)) return json(res, 400, { error: 'No such persona' });
    c.persona = persona;
    saveConvos();
    broadcastConvos();
    return json(res, 200, publicConvo(c));
  }
  // Skills, MCP servers, subagents and personas (extensions.mjs). GET /api/ext lists all four (/api/ext/<kind> one); POST /api/ext/<kind>
  // saves one (body.prev = the name/id being edited), DELETE /api/ext/<kind>/<name> removes it, PATCH
  // /api/ext/mcp/<name> {enabled} switches a server, POST /api/ext/import {url, agents, replace} adds a skill from GitHub.
  // Every write answers with the new lists; a rejected one is a 400 with the reason.
  if (p === '/api/ext' && req.method === 'GET') return json(res, 200, ext.list());
  const exm = p.match(/^\/api\/ext\/(skills|agents|mcp|personas|import)(?:\/([\w.-]{1,100}))?$/);
  if (exm) {
    const [, kind, name] = exm;
    if (req.method === 'GET' && !name && kind !== 'import') return json(res, 200, ext.list(kind)); // e.g. the persona chip's list
    try {
      let item;
      if (kind === 'import' && !name && req.method === 'POST') item = await ext.importSkill(await readBody(req));
      else if (kind !== 'import' && !name && req.method === 'POST') {
        item = ({ skills: ext.saveSkill, agents: ext.saveAgent, mcp: ext.saveMcp, personas: ext.savePersona })[kind](await readBody(req));
      } else if (kind === 'mcp' && name && req.method === 'PATCH') item = ext.setMcpEnabled(name, (await readBody(req)).enabled);
      else if (kind !== 'import' && name && req.method === 'DELETE') {
        ({ skills: ext.removeSkill, agents: ext.removeAgent, mcp: ext.removeMcp, personas: ext.removePersona })[kind](name);
        if (kind === 'personas') { // chats that used it go back to no persona
          const using = convos.filter((c) => c.persona === name);
          for (const c of using) c.persona = null;
          if (using.length) { saveConvos(); broadcastConvos(); }
        }
      } else return json(res, 405, { error: 'Method not allowed' });
      return json(res, 200, { item: item ?? null, ...ext.list() });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return json(res, 400, { error: e.message, ...(e.exists && { exists: e.exists }) });
    }
  }
  if (p === '/api/github' && req.method === 'GET') {
    const s = Date.now() - gh.status().checkedAt > 15000 ? await gh.refresh() : gh.status();
    return json(res, 200, s);
  }
  // Opens a terminal with GitHub's sign-in already started; the owner finishes it in their browser.
  if (p === '/api/github/link' && req.method === 'POST') {
    await tmux(['kill-session', '-t', '=github']);
    await tmux(['new-session', '-d', '-s', 'github', '-c', WORKSPACE, 'bash -l']);
    await tmux(['send-keys', '-t', '=github:', 'gh auth login --hostname github.com --git-protocol https --web && gh auth setup-git && echo && echo "GitHub is linked. You can close this terminal."', 'Enter']);
    return json(res, 200, { terminal: 'github' });
  }
  if (p === '/api/away' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since')) || 0;
    return json(res, 200, { tasks: orch.finishedSince(since / 1000).filter((t) => fs.existsSync(t.path)), repos: Object.fromEntries(convos.filter((c) => c.repo).map((c) => [c.cwd, c.repo.url])) });
  }
  // Terminals: each is a tmux session running bash; ttyd attaches a browser tab to one by name.
  if (p === '/api/terminals' && req.method === 'GET') return json(res, 200, { terminals: await listTerminals() });
  if (p === '/api/terminals' && req.method === 'POST') {
    const names = new Set((await listTerminals()).map((t) => t.name));
    let n = 1;
    while (names.has(`term-${n}`)) n++;
    const name = `term-${n}`;
    await tmux(['new-session', '-d', '-s', name, '-c', WORKSPACE, 'bash -l']);
    return json(res, 200, { name });
  }
  const tm = p.match(/^\/api\/terminals\/([A-Za-z0-9_-]{1,32})$/);
  if (tm && req.method === 'DELETE') {
    await tmux(['kill-session', '-t', `=${tm[1]}`]);
    return json(res, 200, { ok: true });
  }
  const ot = p.match(/^\/api\/orch\/task\/(\d+)(\/action)?$/);
  if (ot) {
    const id = Number(ot[1]);
    if (ot[2] && req.method === 'POST') {
      const body = await readBody(req);
      const r = orch.taskAction(id, String(body.action || ''), body.value);
      return json(res, r.error ? 400 : 200, r);
    }
    const d = orch.taskDetail(id);
    return d ? json(res, 200, d) : json(res, 404, { error: 'No such task' });
  }
  // Manual delegation: GET lists the options (every connected model + usage status), POST {agent, model} reassigns a queued task.
  const od = p.match(/^\/api\/orch\/tasks\/(\d+)\/delegate$/);
  if (od) {
    const id = Number(od[1]);
    if (req.method === 'GET') {
      const v = orch.delegateOptions(id);
      return v ? json(res, 200, v) : json(res, 404, { error: 'No such task' });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const r = orch.delegateTask(id, { agent: String(body.agent || ''), model: body.model || null });
      return json(res, r.error ? r.status || 400 : 200, r.error ? { error: r.error } : r);
    }
  }
  // Owner controls on a running task: pause (stop the session, keep worktree + session; the scheduler skips 'paused'),
  // resume (same session, same agent) and handoff {agent, model, account?} (a fresh session on another agent in the same
  // worktree). Pause and handoff answer once the run has stopped (pending: true if it hasn't yet; it still applies).
  const octl = p.match(/^\/api\/orch\/tasks\/(\d+)\/(pause|resume|handoff)$/);
  if (octl && req.method === 'POST') {
    const id = Number(octl[1]), body = octl[2] === 'handoff' ? await readBody(req) : null;
    const r = octl[2] === 'pause' ? await orch.pauseTask(id) : octl[2] === 'resume' ? orch.resumeTask(id)
      : await orch.handoffTask(id, { agent: String(body.agent || ''), model: body.model || null, account: body.account || null });
    return json(res, r.error ? r.status || 400 : 200, r.error ? { error: r.error } : r);
  }
  // Queue reorder: POST {before: id|null, after: id|null} moves a queued task with its dependent subtree (409 if it
  // would go ahead of a prerequisite, or the task isn't queued).
  const omv = p.match(/^\/api\/orch\/tasks\/(\d+)\/move$/);
  if (omv && req.method === 'POST') {
    const body = await readBody(req);
    const r = orch.moveTask(Number(omv[1]), { before: body.before ?? null, after: body.after ?? null });
    return json(res, r.error ? r.status : 200, r.error ? { error: r.error } : r);
  }
  // Review checkpoints: POST checkpoint inserts one after task :id (its dependents wait for it), approve releases what
  // waits for an awaiting checkpoint, request-changes {note} queues a fix task first and re-arms the checkpoint after it.
  const ock = p.match(/^\/api\/orch\/tasks\/(\d+)\/(checkpoint|approve|request-changes)$/);
  if (ock && req.method === 'POST') {
    const id = Number(ock[1]), body = await readBody(req);
    const r = ock[2] === 'checkpoint' ? orch.insertCheckpoint(id) : ock[2] === 'approve' ? orch.approveCheckpoint(id) : await orch.requestChanges(id, body.note);
    return json(res, r.error ? r.status || 400 : 200, r.error ? { error: r.error } : r);
  }
  // A saved chat message (orchestrator deferMessage): PATCH {text} edits it, DELETE retracts it; 409 once a plan task took it.
  const om = p.match(/^\/api\/orch\/messages\/(\d+)$/);
  if (om && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const body = req.method === 'PATCH' ? await readBody(req) : null;
    if (body && typeof body.text !== 'string') return json(res, 400, { error: 'text is required' });
    const r = orch.changeMessage(Number(om[1]), body ? body.text : null);
    return json(res, r.error ? r.status : 200, r.error ? { error: r.error } : r);
  }
  // Sidebar drag order: POST {ids: [project id, …]}, top (highest priority) first. Sets positions and derives each
  // project's priority from its place (90 → 10); every client gets the new order ('oprojects').
  if (p === '/api/orch/projects/reorder' && req.method === 'POST') {
    const r = orch.reorderProjects((await readBody(req)).ids);
    return json(res, r.error ? r.status : 200, r.error ? { error: r.error } : r);
  }
  const op = p.match(/^\/api\/orch\/project\/(\d+)$/);
  if (op && req.method === 'POST') {
    const r = orch.projectAction(Number(op[1]), await readBody(req));
    return json(res, r.error ? 400 : 200, r);
  }
  // ?node=<id>: a worker machine's rows (remote-login.mjs), from its inventory; sign-ins are proxied over the hub.
  const rnode = url.searchParams.get('node');
  if (rnode && rnode !== 'controller' && p.startsWith('/api/connections')) {
    if (!remoteLogins) return json(res, 503, { error: 'cluster unavailable' });
    let r;
    const rc = p.match(/^\/api\/connections\/([\w-]+)\/(start|code|cancel|logout)$/);
    if (p === '/api/connections' && req.method === 'GET') {
      const list = remoteLogins.list(rnode);
      r = list ? { status: 200, connections: list } : { status: 404, error: 'No such machine' };
    } else if (p === '/api/connections/refresh' && req.method === 'POST') r = remoteLogins.refresh(rnode);
    else if (rc && req.method === 'POST') {
      const [, id, action] = rc, body = await readBody(req);
      r = action === 'start' ? remoteLogins.start(rnode, id) : action === 'code' ? remoteLogins.submitCode(rnode, id, body.code)
        : action === 'cancel' ? remoteLogins.cancel(rnode, id) : await remoteLogins.logout(rnode, id, body);
    } else r = { status: 404, error: 'Not found' };
    const { status, ...body } = r;
    return json(res, status, body);
  }
  if (p === '/api/connections' && req.method === 'GET') {
    if (Date.now() - gh.status().checkedAt > 15000) await gh.refresh();
    return json(res, 200, { connections: connList() });
  }
  // The Connections modal's Refresh: re-checks every sign-in and version, then answers with the rows. Model lists refresh
  // once a day (models.mjs) and limits from the usage card, so neither is fetched here.
  if (p === '/api/connections/refresh' && req.method === 'POST') {
    clearLoginCache();
    await Promise.all([gh.refresh(), ...Object.keys(AGENTS).map(readVersion)].map((x) => x.catch(() => {})));
    return json(res, 200, { connections: connList() });
  }
  // The usage card's refresh for one agent: its only limit check (at most one per agent per minute).
  const lr = p.match(/^\/api\/limits\/([\w-]+)\/refresh$/);
  if (lr && req.method === 'POST') {
    if (!isAgent(lr[1])) return json(res, 404, { error: 'No such agent' });
    await limitStore.refresh([lr[1]]).catch(() => {});
    return json(res, 200, { limits: limitStore.get(lr[1]) });
  }
  const cn = p.match(/^\/api\/connections\/([\w-]+)\/(start|code|cancel|logout)$/);
  if (cn && req.method === 'POST') {
    const [, id, action] = cn;
    const r = action === 'start' ? await connections.start(id, await readBody(req))
      : action === 'code' ? await connections.submitCode(id, (await readBody(req)).code)
      : action === 'cancel' ? await connections.cancel(id) : await connections.logout(id, await readBody(req));
    const { status, ...body } = r;
    return json(res, status, body);
  }
  if (p.startsWith('/api/media/') && req.method === 'GET') {
    const id = p.slice('/api/media/'.length);
    if (!MEDIA_ID_RE.test(id)) return json(res, 400, { error: 'Bad media id' });
    return fs.readFile(path.join(DATA, 'media', id), (err, buf) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': MEDIA_TYPES[id.split('.')[1]], 'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'; sandbox" });
      res.end(buf);
    });
  }
  if (p === '/api/agents') {
    // models: [{id, label, description?, default?}] from the CLI; empty with modelsError ('not signed in', 'loading', or why discovery failed).
    return json(res, 200, { agents: Object.values(AGENTS).map((a) => {
      const { models, error, at } = modelCatalog(a.id);
      return { id: a.id, label: a.label, efforts: agentEfforts(a.id), available: !!a.available(), loggedIn: !!a.available() && a.loggedIn(), models, modelsError: error || null, modelsAt: at, login: a.login };
    }) });
  }
  if (p === '/api/projects') {
    const list = listFolders(WORKSPACE).map((f) => {
      const chats = convos.filter((c) => c.cwd === f.path);
      return { ...f, chats: chats.length, lastUsed: Math.max(f.mtime, ...chats.map((c) => c.updatedAt)) };
    });
    list.sort((a, b) => b.lastUsed - a.lastUsed);
    return json(res, 200, { root: WORKSPACE, projects: list });
  }
  if (p === '/api/folders') {
    try {
      const dir = safeCwd(url.searchParams.get('path') || WORKSPACE);
      const crumbs = [];
      for (let d = dir; ; d = path.dirname(d)) {
        crumbs.unshift({ name: d === HOME ? '~' : path.basename(d), path: d });
        if (d === HOME) break;
      }
      return json(res, 200, { path: dir, home: HOME, workspace: WORKSPACE, crumbs, folders: listFolders(dir) });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  res.writeHead(404); res.end('Not found');
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  try { handleUpgrade(req, socket, head); } catch (e) {
    console.error('upgrade error', req.url, e);
    socket.destroy();
  }
});
function handleUpgrade(req, socket, head) {
  const p = new URL(req.url, 'http://x').pathname;
  // Caddy's forward_auth copies the terminal's WebSocket upgrade headers onto its auth check,
  // so the check arrives here instead of the normal request handler.
  if (p === '/auth/check') {
    const ok = isAuthed(req) && sameOrigin(req);
    socket.end(`HTTP/1.1 ${ok ? '200 OK' : '401 Unauthorized'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    return;
  }
  if (p === WS_PATH) { if (cluster) return cluster.handleUpgrade(req, socket, head); socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return socket.destroy(); }
  if (p !== '/ws' || !isAuthed(req) || !sameOrigin(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

wss.on('connection', (ws, req) => {
  allClients.add(ws);
  let current = null;
  const token = sessionToken(req);
  const alive = setInterval(() => {
    syncSessions();
    const s = sessions[token];
    if (!s || s.exp < Date.now()) ws.close(4001, 'signed out');
    else if (ws.readyState === 1) ws.ping();
  }, Number(process.env.CW_WS_KEEPALIVE_MS) || 30e3);

  send(ws, { t: 'convos', convos: convos.map(publicConvo) });
  if (history.length) send(ws, { t: 'mtick', s: history[history.length - 1], sampleMs: SAMPLE_MS });
  send(ws, { t: 'usage', usage });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    // A sync throw in a 'message' listener is uncaught and would exit the process.
    try { handleMessage(msg); } catch (e) {
      console.error('[ws] message handler failed', e);
      send(ws, { t: 'error', text: 'bad request' });
    }
  });

  function handleMessage(msg) {
    if (browserViews.handle(ws, msg)) return;
    if (msg.t === 'metrics_sub') {
      ws.metricsSub = !!msg.on;
      if (ws.metricsSub) metrics(Infinity).then((d) => send(ws, { t: 'mdetail', d })).catch(() => {});
      return;
    }
    if (msg.t === 'usage_refresh') {
      refreshUsage().catch((e) => console.error('[usage] refresh failed', e));
      return;
    }
    const convo = msg.cid && findConvo(msg.cid);
    if (msg.t === 'open') {
      if (current) subscribers.get(current)?.delete(ws);
      current = convo ? convo.id : null;
      if (!convo) return;
      if (!subscribers.has(convo.id)) subscribers.set(convo.id, new Set());
      subscribers.get(convo.id).add(ws);
      const rt = runtimes.get(convo.id);
      send(ws, {
        t: 'history', cid: convo.id, events: readLog(convo.id), busy: !!rt?.busy || planning.has(convo.id) || agentTurns.has(convo.id),
        pending: rt ? [...rt.pending.values()].map((x) => x.req) : [],
        mode: convo.mode, agent: chatAgent(convo), model: convo.model, cwd: convo.cwd,
        orch: orch.convoSnapshot(convo),
      });
      return;
    }
    if (msg.t === 'owatch') {
      orch.watchTask(ws, Number(msg.taskId) || null, !!msg.on);
      return;
    }
    if (!convo) return;
    switch (msg.t) {
      case 'send': {
        // attachments: upload ids (POST /api/uploads), copied into the project before the turn; a message may be only files.
        const text = typeof msg.text === 'string' ? msg.text : '';
        const ids = Array.isArray(msg.attachments) ? msg.attachments.filter((x) => typeof x === 'string').slice(0, MAX_ATTACHMENTS) : [];
        if (!text.trim() && !ids.length) break;
        let files = [];
        try { files = ids.length ? placeUploads(DATA, ids, convo.cwd) : []; }
        catch (e) { emit(convo.id, { t: 'error', text: `Couldn't attach the files: ${e?.message || e}` }); break; }
        if (!text.trim() && !files.length) break;
        sendUserMessage(convo, text, files).catch((e) => emit(convo.id, { t: 'error', text: String(e?.message || e) }));
        break;
      }
      case 'perm_reply':
        answerPermission(convo, msg);
        break;
      case 'interrupt': {
        const rt = runtimes.get(convo.id);
        if (planning.has(convo.id)) { planQueue.delete(convo.id); orch.abortPlan(convo.id); }
        else if (agentTurns.has(convo.id)) { agentQueue.delete(convo.id); agentTurns.get(convo.id).abort(); }
        else if (rt) {
          for (const [pid, p] of rt.pending) {
            p.resolve({ behavior: 'deny', message: 'Interrupted by user', interrupt: true });
            broadcast(convo.id, { t: 'perm_done', pid, decision: 'cancelled' });
          }
          rt.pending.clear();
          rt.q.interrupt().catch(() => {});
          emit(convo.id, { t: 'notice', text: 'Interrupted' });
        }
        break;
      }
      case 'set_mode':
        if (MODES.includes(msg.mode)) {
          const was = convo.mode;
          convo.mode = msg.mode;
          saveConvos();
          if (msg.mode !== 'orchestrator') runtimes.get(convo.id)?.q.setPermissionMode(msg.mode).catch(() => {});
          broadcast(convo.id, { t: 'mode', mode: msg.mode });
          if (msg.mode === 'orchestrator' && was !== 'orchestrator') {
            orch.setConvoMode(convo, 'orchestrator');
            broadcast(convo.id, { t: 'osnapshot', orch: orch.convoSnapshot(convo) });
          } else if (was === 'orchestrator' && msg.mode !== 'orchestrator') {
            orch.setConvoMode(convo, msg.mode);
            emit(convo.id, { t: 'notice', text: 'Orchestrator paused. Switch back to Orchestrator Mode to resume its work.' });
          }
        }
        break;
      case 'set_model': {
        // No agent = Claude; an unknown one is refused and the chat keeps its agent.
        if (msg.agent != null && !isAgent(msg.agent)) { send(ws, { cid: convo.id, t: 'error', text: `Unknown agent: ${String(msg.agent)}` }); break; }
        const agent = msg.agent ?? 'claude';
        convo.model = typeof msg.model === 'string' ? msg.model : '';
        convo.agent = agent;
        // A new chat's draft effort rides along (one message, so it is checked against the agent it was picked for);
        // otherwise switching agents clamps the chat's effort to the nearest level the new one takes.
        const was = convo.effort ?? null;
        if (msg.effort === null || agentEfforts(agent).includes(msg.effort)) convo.effort = msg.effort;
        else if (convo.effort && agentEfforts(agent).length) convo.effort = clampEffort(agent, convo.effort);
        saveConvos();
        orch?.syncConvoModel(convo);
        if ((convo.effort ?? null) !== was) broadcastConvos();
        // The Claude runtime is only kept while the chat is on Claude.
        if (agent === 'claude') runtimes.get(convo.id)?.q.setModel(convo.model || undefined).then(() => applyChatEffort(convo), () => {});
        else if (runtimes.has(convo.id)) { retireRuntime(runtimes, convo.id); broadcastConvos(); }
        broadcast(convo.id, { t: 'model', agent, model: convo.model });
        break;
      }
    }
  }

  ws.on('close', () => {
    clearInterval(alive);
    allClients.delete(ws);
    orch?.unwatch(ws);
    browserViews.drop(ws);
    if (current) subscribers.get(current)?.delete(ws);
  });
});

if (process.argv[2] === 'set-password') {
  const pw = process.argv[3];
  if (!pw || pw.length < 8) { console.error('Usage: node server.mjs set-password <new password, 8+ chars>'); process.exit(1); }
  writeJSON('auth.json', hashPassword(pw));
  writeJSON('sessions.json', {});
  console.log('Password updated. Everyone has been signed out.');
  process.exit(0);
} else {
  // Repo links are refreshed from each folder's git origin before serving, so the API never returns a stale one.
  refreshAllRepos().catch((e) => console.error('[github] repo refresh failed', e))
    .finally(() => server.listen(PORT, '127.0.0.1', () => console.log(`agent-orch on 127.0.0.1:${PORT}`)));
}
