// agent-orch: login + chat UI for Claude Code, with the ttyd terminal proxied by Caddy at /shell/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createOrchestrator, parseJsonl, SHOT_HINT } from './orchestrator.mjs';
import { createGitHub } from './github.mjs';
import { retireRuntime, chatIdle, whenIdle } from './runtimes.mjs';
import { AGENTS, runAgentCli, clearLoginCache, isMissingSession, modelCatalog, codexLatestSnapshot, windowLabel, AGY_GROUPS, agyGroup } from './agents.mjs';
import { createModelStore } from './models.mjs';
import { createConnections, SPECS, codexAccount, agyAccount, onPath } from './connections.mjs';
import { mediaCollector, MEDIA_ID_RE, MEDIA_TYPES, toolResultImages } from './media.mjs';
import { createUsageLog, RANGES as USAGE_RANGES } from './usage.mjs';

// Backstop: a stray rejected promise is logged instead of killing the server (uncaught exceptions still exit).
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CW_DATA_DIR ? path.resolve(process.env.CW_DATA_DIR) : path.join(ROOT, 'data');
const LOGS = path.join(DATA, 'logs');
const PUBLIC = path.join(ROOT, 'public');
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
    if (typeof agent !== 'string' || !AGENTS[agent]) return { error: `Unknown agent: ${agent}` };
    if (typeof model !== 'string' || !(modelCatalog(agent).models || []).some((m) => m.id === model)) return { error: `Unknown ${agent} model: ${model}` };
    if (!list.some((x) => x.agent === agent && x.model === model)) list.push({ agent, model });
  }
  return { list };
}
function publicConvo(c) {
  const rt = runtimes.get(c.id);
  return { ...c, fallbacks: c.fallbacks ?? null, busy: !!rt?.busy || planning.has(c.id) || agentTurns.has(c.id) };
}
const planning = new Set(); // convo ids with an orchestrator planner turn in progress
const agentTurns = new Map(); // convo id -> AbortController of a running non-Claude chat turn
const chatAgent = (c) => (c.agent && c.agent !== 'claude' && AGENTS[c.agent] ? c.agent : 'claude');
const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'orchestrator'];
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
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ['auth', 'status'], { env: CLAUDE_ENV, timeout: 15000 }, (err, stdout) => {
      try {
        const s = JSON.parse(stdout);
        claudeAuth = { loggedIn: !!s.loggedIn, authMethod: s.authMethod || null, plan: s.subscriptionType || null, checkedAt: Date.now() };
      } catch {
        claudeAuth = { loggedIn: false, authMethod: null, plan: null, checkedAt: Date.now() };
      }
      resolve(claudeAuth);
    });
  });
}
const onSubscription = () => claudeAuth.loggedIn && claudeAuth.authMethod === 'claude.ai';
setInterval(() => refreshClaudeAuth().catch((e) => console.error('[auth] refresh failed', e)), 5 * 60e3);

// ---------- self-restart ----------
// The boot commit tells the UI how far HEAD has moved since this process started (a restart is due).
const git = (args) => new Promise((resolve) => execFile('git', args, { cwd: ROOT, timeout: 5000 }, (err, out) => resolve(err ? '' : out.trim())));
let bootCommit = '', restartPending = false, restartGen = 0, sinceBoot = { at: 0, count: 0, busy: false };
git(['rev-parse', 'HEAD']).then((c) => { bootCommit = c; });
function commitsSinceBoot() {
  if (bootCommit && !sinceBoot.busy && Date.now() - sinceBoot.at > 30e3) {
    sinceBoot.busy = true;
    git(['rev-list', '--count', `${bootCommit}..HEAD`]).then((n) => { sinceBoot = { at: Date.now(), count: Number(n) || 0, busy: false }; });
  }
  return sinceBoot.count;
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
let usageBusy = false;
let usageTimer = null;
async function refreshUsage(liveQuery) {
  if (usageBusy) return; // the check already running will broadcast its answer
  if (!onSubscription()) {
    usage = { available: false, updatedAt: Date.now() };
    for (const ws of allClients) send(ws, { t: 'usage', usage });
    return;
  }
  usageBusy = true;
  let probe = null;
  try {
    let q = liveQuery;
    if (!q) {
      probe = query({
        prompt: (async function* idle() { await new Promise(() => {}); })(),
        options: { pathToClaudeCodeExecutable: CLAUDE_BIN, env: CLAUDE_ENV, cwd: WORKSPACE },
      });
      q = probe;
    }
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
    };
    const rec = (name, w) => w && usageLog.window('claude', name, w.pct, w.resetsAt);
    rec('five_hour', usage.session); rec('seven_day', usage.weekly);
    rec('seven_day_opus', usage.weeklyOpus); rec('seven_day_sonnet', usage.weeklySonnet);
    for (const m of usage.models) if (m.name) rec(m.name, m);
  } catch (e) {
    usage = { ...usage, error: String(e?.message || e), updatedAt: Date.now() };
  } finally {
    probe?.close();
    usageBusy = false;
  }
  for (const ws of allClients) send(ws, { t: 'usage', usage });
}
function refreshUsageSoon(liveQuery) {
  clearTimeout(usageTimer);
  usageTimer = setTimeout(() => refreshUsage(liveQuery).catch((e) => console.error('[usage] refresh failed', e)), 1500);
}
refreshClaudeAuth().then(() => refreshUsage()).catch((e) => console.error('[usage] refresh failed', e));
setInterval(() => refreshUsage().catch((e) => console.error('[usage] refresh failed', e)), 3 * 60e3);

// Codex plan windows while codex is idle (its runs and chat turns record their own): the newest rollout snapshot,
// every 5 min, recorded only when it changed; `at` keeps the snapshot's time so an old one reads as stale.
let codexSnapAt = 0;
function pollCodexUsage() {
  const busy = [...agentTurns.keys()].some((cid) => findConvo(cid)?.agent === 'codex') || orch?.stateView().activeUsage.some((a) => a.agent === 'codex');
  if (busy) return;
  const s = codexLatestSnapshot();
  if (!s?.windows || s.t <= codexSnapAt) return;
  codexSnapAt = s.t;
  for (const w of s.windows) usageLog.window('codex', w.window, w.pct, w.resetsAt, s.t);
}
setTimeout(() => { try { pollCodexUsage(); } catch (e) { console.error('[usage] codex poll failed', e); } }, 2000);
setInterval(() => { try { pollCodexUsage(); } catch (e) { console.error('[usage] codex poll failed', e); } }, 5 * 60e3);

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
  query,
  claudeBin: CLAUDE_BIN,
  claudeEnv: CLAUDE_ENV,
  dataDir: DATA,
  // The usage card's /usage reading, in the shape pacing expects (fractions, epoch seconds).
  usageLog,
  getLimits: () => {
    if (!usage.available) return [];
    const observed = usage.updatedAt / 1000;
    const row = (type, w) => w && { limit_type: type, status: w.pct >= 100 ? 'rejected' : 'allowed', utilization: w.pct / 100,
      resets_at: w.resetsAt ? Date.parse(w.resetsAt) / 1000 : null, observed_at: observed };
    return [row('five_hour', usage.session), row('seven_day', usage.weekly)].filter(Boolean);
  },
  onSubscription: () => onSubscription(),
  emitChat: (cid, ev, { persist = true } = {}) => (persist ? emit(cid, ev) : broadcast(cid, ev)),
  broadcast: (msg) => { for (const ws of allClients) send(ws, msg); },
  convoExists: (cid) => !!findConvo(cid),
  convoFallbacks: (cid) => findConvo(cid)?.fallbacks ?? null,
  refreshUsage: () => refreshUsage().catch((e) => console.error('[usage] refresh failed', e)),
  onCommit: (dir) => syncGit(dir).catch((e) => console.error('[github] sync failed', dir, e)),
  projectReady: (dir) => gh.status().linked && !!convos.find((c) => c.cwd === dir)?.repo,
  disabled: NO_ORCH,
});

// ---------- GitHub protocol ----------
// Every project is a private GitHub repo; every finished task and chat reply is pushed.
const gh = createGitHub({ env: CLAUDE_ENV, log: (m) => console.log(`[github] ${m}`) });
// ---------- Sign-in connections (agent CLIs + GitHub), driven from the web UI ----------
// Each agent's models, discovered from its CLI (models.mjs); clients refetch /api/agents on {t:'models'}.
const modelStore = createModelStore({ file: path.join(DATA, 'models.json'), log: (m) => console.log(`[models] ${m}`),
  onChange: () => { for (const ws of allClients) send(ws, { t: 'models' }); } });
modelStore.start().catch((e) => console.error('[models] discovery failed', e));
// A sign-in or sign-out re-checks the login and rediscovers that agent's models (in the background).
const signInChanged = (id) => () => { clearLoginCache(); modelStore.refresh([id]).catch(() => {}); };
const agentEntry = (a, extra = {}) => ({ id: a.id, label: a.label, installed: () => a.available(), signedIn: () => a.loggedIn(), envFilter: a.envFilter, afterChange: signInChanged(a.id), ...extra });
const connections = createConnections({
  entries: [
    agentEntry(AGENTS.claude, { spec: SPECS.claude, account: () => AGENTS.claude.account() }),
    agentEntry(AGENTS.codex, { spec: SPECS.codex, account: () => codexAccount() }),
    agentEntry(AGENTS.antigravity, { spec: SPECS.antigravity, account: () => agyAccount(), probe: () => AGENTS.antigravity.probe() }),
    agentEntry(AGENTS.opencode, { spec: SPECS.opencode, account: () => AGENTS.opencode.account() }),
    agentEntry(AGENTS.kiro, { spec: SPECS.kiro, account: () => AGENTS.kiro.account() }),
    agentEntry(AGENTS.copilot, { spec: SPECS.copilot, account: () => AGENTS.copilot.account(), afterChange: () => { gh.refresh(); signInChanged('copilot')(); } }),
    { id: 'github', label: 'GitHub', installed: () => onPath('gh'), signedIn: () => gh.status().linked, account: () => gh.status().login,
      spec: SPECS.github, afterChange: () => gh.refresh() },
  ],
  onChange: (list) => { for (const ws of allClients) send(ws, { t: 'connections', connections: list }); },
});

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
  c.git = { pushedAt: r.ok ? Date.now() : c.git?.pushedAt || null, error: r.ok ? null : r.error, unpushed: r.ok ? 0 : await gh.unpushed(dir) };
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
async function orchestratorTurn(convo, text) {
  emit(convo.id, { t: 'user', text });
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
    refreshUsageSoon();
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
    return content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}
const clip = (s, n = 30000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);

function startRuntime(convo) {
  const input = inputQueue();
  const rt = { push: input.push, busy: false, pending: new Map(), q: null };

  const canUseTool = (toolName, toolInput, { signal, suggestions }) =>
    new Promise((resolve) => {
      const pid = crypto.randomUUID();
      const req = { pid, tool: toolName, input: toolInput, canAlways: !!suggestions?.length };
      rt.pending.set(pid, { req, resolve, toolInput, suggestions });
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
      permissionMode: sdkMode(convo.mode),
      // Lets the mode picker switch to "Bypass" later without restarting the session.
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: chatSystemAppend(convo) },
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      env: CLAUDE_ENV,
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
    case 'rate_limit_event':
      refreshUsageSoon(rt.q);
      break;
    case 'result':
      rt.busy = false;
      if (rt.media) emitShots(cid, rt.media);
      refreshUsageSoon(rt.q);
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
const agentQueue = new Map(); // convo id -> [text] sent while a turn was running
async function agentChatTurn(convo, text) {
  emit(convo.id, { t: 'user', text });
  if (agentTurns.has(convo.id)) {
    if (!agentQueue.has(convo.id)) agentQueue.set(convo.id, []);
    agentQueue.get(convo.id).push(text);
    return;
  }
  const cid = convo.id;
  broadcast(cid, { t: 'busy', busy: true });
  for (let next = text; next;) {
    const agent = chatAgent(convo), a = AGENTS[agent], ac = new AbortController();
    // Only this chat's own agent's limit matters (never Claude's): while it's limited, say so and skip the turn.
    const lim = orch.limitResetFor(agent, convo.model);
    if (lim) {
      emit(cid, { t: 'error', until: lim.at, untilKnown: lim.known, text: `Not sent: ${lim.name} is at its ${agent === 'antigravity' ? lim.reason : 'usage limit'}${lim.known ? ' until {until}' : "; the reset time isn't known yet. Try again around {until}"}.` });
      emit(cid, { t: 'result', ok: false, text: 'rate_limited', ms: 0 });
      next = agentQueue.get(cid)?.splice(0).join('\n\n') || null;
      continue;
    }
    agentTurns.set(cid, ac);
    broadcastConvos();
    const started = Date.now();
    const media = mediaCollector(DATA, convo.cwd);
    const turn = async (resume) => {
      try {
        return await runAgentCli({
          agent, prompt: next, cwd: convo.cwd, resume, model: convo.model || undefined, signal: ac.signal, env: CLAUDE_ENV,
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
    if (res.sessionId) convo.agentSession = { agent, id: res.sessionId };
    emitShots(cid, media);
    usageLog.tokens(agent, res.usage, 'chat', cid);
    usageLog.windows(agent, res.windows);
    orch.recordLimit(res, agent, convo.model); // blocks/unblocks only this agent (antigravity: its model group; tasks routed to it follow) and logs usage history
    if (res.outcome === 'auth_error') emit(cid, { t: 'error', text: `${a.label} is not signed in on this server. ${a.login}.` });
    else if (res.outcome === 'rate_limited') emit(cid, { t: 'error', text: `${a.label} hit its ${res.limitType ? windowLabel(res.limitType) : agent === 'antigravity' ? AGY_GROUPS[agyGroup(convo.model)] : 'usage'} limit${res.resetsAt ? '; it resets {until}' : ''}.`, ...(res.resetsAt && { until: res.resetsAt, untilKnown: true }) });
    else if (res.outcome === 'aborted') emit(cid, { t: 'notice', text: 'Interrupted' });
    else if (res.outcome !== 'ok') emit(cid, { t: 'error', text: `${a.label} failed: ${String(res.text || res.stderr || res.outcome).trim().slice(-600)}` });
    emit(cid, { t: 'result', ok: res.outcome === 'ok', text: res.outcome === 'ok' ? '' : res.outcome, ms: Date.now() - started, turns: res.numTurns });
    agentTurns.delete(cid);
    convo.updatedAt = Date.now();
    saveConvos();
    syncGit(convo.cwd, `Chat: ${String(next).replace(/\s+/g, ' ').slice(0, 72)}`).catch((e) => console.error('[github] sync failed', convo.cwd, e));
    const waiting = res.outcome === 'aborted' ? null : agentQueue.get(cid);
    next = waiting?.length ? waiting.splice(0).join('\n\n') : null;
  }
  agentQueue.delete(cid);
  broadcast(cid, { t: 'busy', busy: false });
  broadcastConvos();
}

async function sendUserMessage(convo, text) {
  // A non-Claude chat depends only on its own agent: no Claude sign-in or limit check.
  if (chatAgent(convo) !== 'claude') return convo.mode === 'orchestrator' ? orchestratorTurn(convo, text) : agentChatTurn(convo, text);
  if (!onSubscription()) await refreshClaudeAuth();
  if (!onSubscription()) {
    emit(convo.id, { t: 'user', text });
    emit(convo.id, {
      t: 'error',
      text: claudeAuth.loggedIn
        ? `Not sent: Claude Code is signed in with "${claudeAuth.authMethod}", not your Claude subscription. Run /login in the Terminal and choose your Claude account.`
        : 'Not sent: Claude Code is not signed in. Open the Terminal and sign in with your Claude account.',
    });
    return;
  }
  if (convo.mode === 'orchestrator') return orchestratorTurn(convo, text);
  // Orchestrator-style context control: a session that has grown past the limit is retired, and the next
  // message starts a fresh one carrying the project memory (.agent-orch/) and a recap of the recent chat.
  let prompt = text;
  if (convo.sessionId && (convo.ctxTokens || 0) > CHAT_CONTEXT_LIMIT) {
    retireRuntime(runtimes, convo.id);
    const recap = chatRecap(convo.id);
    convo.sessionId = null;
    convo.ctxTokens = 0;
    emit(convo.id, { t: 'notice', text: 'This chat was getting long, so it continues in a fresh session with the project memory and a recap of the recent conversation. That keeps replies fast and uses less of your plan.' });
    prompt = `[This conversation continues from an earlier session in this project that grew too long. Recent conversation:]\n${recap}\n\n[New message]\n${text}`;
  }
  const rt = runtimes.get(convo.id) || startRuntime(convo);
  rt.lastUserText = text;
  if (!rt.busy || !rt.media) rt.media = mediaCollector(DATA, convo.cwd); // a queued message keeps the running turn's snapshot
  convo.updatedAt = Date.now();
  saveConvos();
  emit(convo.id, { t: 'user', text });
  rt.busy = true;
  broadcast(convo.id, { t: 'busy', busy: true });
  broadcastConvos();
  rt.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
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
// Every chat session starts knowing the project's durable memory, shared with the orchestrator.
function chatSystemAppend(convo) {
  orch.initMemory(convo.cwd);
  const mem = orch.readMemory(convo.cwd);
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
${mem.context || '(empty)'}`;
}

function answerPermission(convo, msg) {
  const rt = runtimes.get(convo.id);
  const p = rt?.pending.get(msg.pid);
  if (!p) return;
  rt.pending.delete(msg.pid);
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
      const mode = msg.nextMode || 'acceptEdits';
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

const PUBLIC_PATHS = new Set(['/login', '/login.css', '/icon.svg', '/manifest.webmanifest']);

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
  if (p === '/app.js' || p === '/app.css') return serveFile(res, path.join(PUBLIC, p));

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
        orch.undrain();
        console.log('[restart] cancelled');
      }
      for (const ws of allClients) send(ws, { t: 'status', restartPending });
      return json(res, 200, { draining: false });
    }
    if (!restartPending) {
      restartPending = true;
      const gen = ++restartGen;
      console.log('[restart] draining: waiting for running tasks and chat turns to finish');
      whenIdle({
        drained: orch.drain(), cancelled: () => gen !== restartGen,
        idle: () => chatIdle({ runtimes, agentTurns, planning, chatPlanning: orch.chatPlanning }),
      }).then((ok) => { if (ok) { console.log('[restart] idle; exiting for restart'); process.exit(0); } });
      for (const ws of allClients) send(ws, { t: 'status', restartPending });
    }
    return json(res, 202, { draining: true });
  }
  if (p === '/api/metrics/history') {
    return json(res, 200, historyFor(url.searchParams.get('range') || '1h'));
  }
  if (p === '/api/usage/history') {
    const range = url.searchParams.get('range') || '24h';
    if (!USAGE_RANGES[range]) return json(res, 400, { error: 'range must be 6h, 24h, 7d or 30d' });
    return json(res, 200, usageLog.history(range));
  }
  if (p === '/api/metrics') {
    return json(res, 200, await metrics(Number(url.searchParams.get('since')) || 0));
  }
  if (p === '/api/convos' && req.method === 'GET') return json(res, 200, convos.map(publicConvo));
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
      const c = { id: crypto.randomUUID(), title: path.basename(cwd), cwd, mode: body.mode || 'bypassPermissions', model: '', createdAt: Date.now(), updatedAt: Date.now() };
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
  // Queue reorder: POST {before: id|null, after: id|null} moves a queued task with its dependent subtree (409 if it
  // would go ahead of a prerequisite, or the task isn't queued).
  const omv = p.match(/^\/api\/orch\/tasks\/(\d+)\/move$/);
  if (omv && req.method === 'POST') {
    const body = await readBody(req);
    const r = orch.moveTask(Number(omv[1]), { before: body.before ?? null, after: body.after ?? null });
    return json(res, r.error ? r.status : 200, r.error ? { error: r.error } : r);
  }
  // A saved chat message (orchestrator deferMessage): PATCH {text} edits it, DELETE retracts it; 409 once a plan task took it.
  const om = p.match(/^\/api\/orch\/messages\/(\d+)$/);
  if (om && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const body = req.method === 'PATCH' ? await readBody(req) : null;
    if (body && typeof body.text !== 'string') return json(res, 400, { error: 'text is required' });
    const r = orch.changeMessage(Number(om[1]), body ? body.text : null);
    return json(res, r.error ? r.status : 200, r.error ? { error: r.error } : r);
  }
  const op = p.match(/^\/api\/orch\/project\/(\d+)$/);
  if (op && req.method === 'POST') {
    const r = orch.projectAction(Number(op[1]), await readBody(req));
    return json(res, r.error ? 400 : 200, r);
  }
  if (p === '/api/connections' && req.method === 'GET') {
    if (Date.now() - gh.status().checkedAt > 15000) await gh.refresh();
    return json(res, 200, { connections: connections.list() });
  }
  const cn = p.match(/^\/api\/connections\/([\w-]+)\/(start|code|cancel|logout)$/);
  if (cn && req.method === 'POST') {
    const [, id, action] = cn;
    const r = action === 'start' ? await connections.start(id)
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
      return { id: a.id, label: a.label, available: !!a.available(), loggedIn: !!a.available() && a.loggedIn(), models, modelsError: error || null, modelsAt: at, login: a.login };
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
      case 'send':
        if (typeof msg.text === 'string' && msg.text.trim()) {
          sendUserMessage(convo, msg.text).catch((e) => emit(convo.id, { t: 'error', text: String(e?.message || e) }));
        }
        break;
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
        const agent = AGENTS[msg.agent] ? msg.agent : 'claude';
        convo.model = typeof msg.model === 'string' ? msg.model : '';
        convo.agent = agent;
        saveConvos();
        // The Claude runtime is only kept while the chat is on Claude.
        if (agent === 'claude') runtimes.get(convo.id)?.q.setModel(convo.model || undefined).catch(() => {});
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
