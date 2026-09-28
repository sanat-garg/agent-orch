// The live browser view (AGENTIC.md → Browser → One-time sign-in): on the node that holds a profile, exactly one Chromium
// per profile with a DevTools port on 127.0.0.1, owned by the profile's supervisor (superviseBrowser, below: it restarts
// Chromium when it dies) and attached to by both the owner's view here and a browser task's MCP (bin/browser-mcp.mjs, with
// --cdp-endpoint). A view starts with a screenshot, then streams CDP Page.startScreencast JPEG frames (acked at once, sent
// on at most FPS times a second, newest first) and replays the owner's input with
// Input.dispatch*. The page is laid out for the viewer's screen (its canvas size and devicePixelRatio; a phone layout
// below MOBILE_MAX px), else for a desktop VIEWPORT (no viewer's size yet); while a task uses the profile, never re-laid out. A profile opens on
// homeUrl(). Take-over is a flag file the shim checks before each MCP tools/call, so it works the same on every node.
// Worker-safe: node built-ins, ws and browser.mjs only (test/compute-only.test.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { browserRoot, profileDir, normIdentity, findBrowser, hasDisplay, IDENTITY_RE, DEFAULT_IDENTITY } from './browser.mjs';

export const FPS = 8;
export const VIEWPORT = { width: 1280, height: 800 };
export const MOBILE_MAX = 768;
const MAX_SCALE = 2; // frames are at most 2× the page's CSS size (bandwidth) …
const MAX_PIXELS = 2560 * 1600; // … and at most this many pixels
const MAX_FRAME_B64 = 900 * 1024; // a frame must fit the cluster's MAX_FRAME with room to spare
const STALE_MS = 5000; // a view without a frame this long gets a fresh screenshot and screencast
// Where a profile's browser opens, and where an empty tab goes: AGENT_ORCH_BROWSER_HOME_URL (tests), else Google.
export const homeUrl = () => normUrl(process.env.AGENT_ORCH_BROWSER_HOME_URL) || 'https://www.google.com/';
export const isBlank = (u) => !u || u === 'about:blank' || /^chrome:\/\/(newtab|new-tab-page)\/?$/i.test(u) || /^chrome-search:/i.test(u);
// A viewer's {width, height} (its canvas's CSS px) and dpr → a sane copy, or null.
export function viewSize(z) {
  if (!z || typeof z !== 'object') return null;
  const width = Math.round(num(z.width)), height = Math.round(num(z.height));
  if (width < 120 || height < 120) return null;
  return { width: Math.min(width, 3840), height: Math.min(height, 2400), dpr: Math.round(Math.min(Math.max(num(z.dpr, 1), 1), 4) * 100) / 100 };
}
// A viewer's size → the page's device metrics (Emulation.setDeviceMetricsOverride); no size → the desktop VIEWPORT.
export function viewMetrics(z) {
  z = viewSize(z) || { ...VIEWPORT, dpr: 1 };
  return { width: z.width, height: z.height, deviceScaleFactor: Math.min(z.dpr, MAX_SCALE), mobile: z.width < MOBILE_MAX };
}
const metricsOverride = (m) => ({ width: m.width, height: m.height, deviceScaleFactor: m.deviceScaleFactor, mobile: m.mobile, screenWidth: m.width, screenHeight: m.height });
// The screencast's maxWidth/maxHeight for those metrics: the size × its scale, within MAX_PIXELS.
export function castSize(m) {
  const k = Math.min(m.deviceScaleFactor, Math.sqrt(MAX_PIXELS / (m.width * m.height)));
  return { maxWidth: Math.round(m.width * k), maxHeight: Math.round(m.height * k) };
}
// The user agent for the view: headless Chromium's without "HeadlessChrome" (sites treat it as a bot), or a phone's.
export function userAgent(base, mobile) {
  const desktop = String(base || '').replace(/HeadlessChrome/g, 'Chrome');
  if (!mobile) return desktop;
  const v = desktop.match(/Chrome\/(\d+)/)?.[1] || '140';
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Mobile Safari/537.36`;
}
// The browser home: the profiles' parent (tests point it at a temp dir).
export const liveHome = () => process.env.AGENT_ORCH_BROWSER_HOME || os.homedir();
const controlDir = (home) => path.join(browserRoot(home), 'control');
export const takeoverFile = (identity, home = liveHome()) => path.join(controlDir(home), `${normIdentity(identity)}.takeover`);
export const activeFile = (identity, home = liveHome()) => path.join(controlDir(home), `${normIdentity(identity)}.active`);
// When the profile's MCP shim last finished its MCP handshake: {pid, startedAt, readyAt} (epoch ms; agents.mjs reads it
// to log each browser run's MCP startup time).
export const mcpReadyFile = (identity, home = liveHome()) => path.join(controlDir(home), `${normIdentity(identity)}.mcp.json`);
export function readMcpReady(identity, home = liveHome()) {
  try { const m = JSON.parse(fs.readFileSync(mcpReadyFile(identity, home), 'utf8')); return Number.isFinite(m.readyAt) ? m : null; } catch { return null; }
}
export const takenOver = (identity, home = liveHome()) => fs.existsSync(takeoverFile(identity, home));
export function setTakeover(identity, on, home = liveHome()) {
  const f = takeoverFile(identity, home);
  if (on) { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, String(Date.now())); }
  else fs.rmSync(f, { force: true });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// The task run using this profile right now (the shim's marker, while its process lives), or null.
export function activeRun(identity, home = liveHome()) {
  try {
    const m = JSON.parse(fs.readFileSync(activeFile(identity, home), 'utf8'));
    if (Number.isSafeInteger(m.pid) && alive(m.pid)) return m;
  } catch {}
  return null;
}
export function markActive(identity, home = liveHome()) {
  const f = activeFile(identity, home);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, since: Date.now() }));
  return () => { try { if (JSON.parse(fs.readFileSync(f, 'utf8')).pid === process.pid) fs.rmSync(f, { force: true }); } catch {} };
}

// ---- Chromium with a DevTools port
async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? (await r.json()).webSocketDebuggerUrl || null : null;
  } catch { return null; }
}
// The Chromium that wrote this profile's DevToolsActivePort ({port, ws}) while it answers, else null.
export async function endpointFor(identity, home = liveHome()) {
  const port = devtoolsPort(profileDir(identity, home));
  const ws = port > 0 ? await probe(port) : null;
  return ws ? { port, ws } : null;
}
function devtoolsPort(profile) {
  try { return Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || 0; } catch { return 0; }
}
// Headless Chromium screencasts at its screen's scale whatever the emulated deviceScaleFactor, so its screen is MAX_SCALE×
// (frames of a 1× view are scaled down to castSize) and VIEWPORT-sized in CSS px.
const screenInfo = `--screen-info={${VIEWPORT.width * MAX_SCALE}x${VIEWPORT.height * MAX_SCALE} devicePixelRatio=${MAX_SCALE}}`;
// Starts Chromium on the profile, on homeUrl(), with its DevTools on port (0: any free one). The flags match Playwright's
// (basic password store, mock keychain) so cookies saved by either stay readable by the other.
export async function launchChrome({ identity, home = liveHome(), executable = findBrowser(), headless = !hasDisplay(), port = 0, timeoutMs = 45_000 } = {}) {
  if (!executable) throw new Error('no Chromium or Chrome on this machine');
  const profile = profileDir(identity, home);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const portFile = path.join(profile, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--use-mock-keychain', '--mute-audio',
    '--disable-features=Translate,MediaRouter', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, ...(headless ? ['--headless=new', screenInfo] : []),
    ...(process.platform === 'linux' && process.env.AGENT_ORCH_BROWSER_SANDBOX !== '1' ? ['--no-sandbox'] : []), homeUrl()];
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', exited = null;
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  child.once('exit', (code) => { exited = code ?? -1; });
  child.once('error', (e) => { exited = -1; stderr += e.message; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited != null) throw new Error(`Chromium exited (${exited}) before it was ready${/SingletonLock|ProcessSingleton|in use/i.test(stderr) ? ': the profile is in use by another browser' : `: ${stderr.trim().split('\n').pop() || ''}`}`);
    let ep = await endpointFor(identity, home);
    // Given a fixed port, some Chromium builds never write DevToolsActivePort: record it for endpointFor from its answer.
    if (!ep && port > 0) {
      const ws = await probe(port);
      if (ws) { try { fs.writeFileSync(portFile, `${port}\n${new URL(ws).pathname}\n`); } catch {} ep = { port, ws }; }
    }
    if (ep) return { ...ep, child, pid: child.pid };
    await sleep(150);
  }
  child.kill('SIGKILL');
  throw new Error('Chromium did not start in time');
}
// Closes Chromium gracefully (so it writes its cookies out), then kills it. A Chromium this process didn't start (no
// child) is waited for by its pid.
export async function closeChrome(chrome, ms = 8000) {
  const { child, pid } = chrome;
  if (child ? child.exitCode != null || child.signalCode : !pid || !alive(pid)) return;
  const gone = child ? new Promise((r) => child.once('exit', r)) : until(() => !alive(pid), ms + 2000);
  try { const c = await cdpConnect(chrome.ws); c.send('Browser.close').catch(() => {}); } catch { kill(pid, 'SIGTERM'); }
  const t = setTimeout(() => kill(pid, 'SIGKILL'), ms);
  await gone;
  clearTimeout(t);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A CDP call's result, or {} when it fails or takes longer than ms (a busy page must not stall the view).
const within = (p, ms = 3000) => Promise.race([p.catch(() => ({})), sleep(ms).then(() => ({}))]);
// A CDP call's result, or an error when it takes longer than ms.
const must = (p, ms = 10_000) => Promise.race([p, sleep(ms).then(() => { throw new Error('the browser did not answer'); })]);
const kill = (pid, sig) => { try { process.kill(pid, sig); } catch {} };
async function until(ok, ms, step = 100) { const end = Date.now() + ms; while (!(await ok()) && Date.now() < end) await sleep(step); }

// ---- the profile's supervisor: exactly one Chromium per profile on this node
// One detached process per profile (`node browser-live.mjs supervise …`, started by whoever needs the browser first: a
// live view or a task's MCP shim) owns its Chromium: it takes the profile's lock file, launches Chromium on a DevTools
// port that stays the same across restarts (so an MCP attached with --cdp-endpoint reconnects on its next call), records
// the endpoint in control/<identity>.browser.json, checks it every HEALTH_MS via /json/version, restarts it when it
// exits or stops answering, and kills a stray Chromium that holds the profile without answering. It stops Chromium and
// exits once no process has held the profile (holdBrowser, or a running task's marker) for IDLE_MS.
export const HEALTH_MS = 5000;
export const IDLE_MS = Number(process.env.AGENT_ORCH_BROWSER_IDLE_MS) || 120_000;
const SELF = fileURLToPath(import.meta.url);
const stateFile = (identity, home) => path.join(controlDir(home), `${normIdentity(identity)}.browser.json`);
const lockFile = (identity, home) => path.join(controlDir(home), `${normIdentity(identity)}.supervisor`);
const agentTabFile = (identity, home) => path.join(controlDir(home), `${normIdentity(identity)}.agent-tab`);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(`${f}.${process.pid}`, JSON.stringify(v)); fs.renameSync(`${f}.${process.pid}`, f); };
// The supervisor's record: {pid, port, ws, chromePid, restarts, failures, error, …}.
export const browserState = (identity, home = liveHome()) => readJson(stateFile(identity, home));
// The profile's running supervisor's pid, or 0.
export function supervisorPid(identity, home = liveHome()) {
  const pid = Number(readJson(lockFile(identity, home)));
  return pid > 0 && alive(pid) ? pid : 0;
}
// The tab a running task's agent works in (bin/browser-mcp.mjs records it), or null.
export function agentTab(identity, home = liveHome()) {
  const t = readJson(agentTabFile(identity, home));
  return t && Number.isSafeInteger(t.pid) && alive(t.pid) ? t.target : null;
}
export const setAgentTab = (identity, target, home = liveHome()) => writeJson(agentTabFile(identity, home), { pid: process.pid, target });
export const lastAgentTab = (identity, home = liveHome()) => readJson(agentTabFile(identity, home))?.target || null;
// The pid of the Chromium holding the profile (its SingletonLock), 0 for a stale lock, null for none.
function profileHolder(profile) {
  let link;
  try { link = fs.readlinkSync(path.join(profile, 'SingletonLock')); } catch { return null; }
  const m = /^(.*)-(\d+)$/.exec(link);
  return m && m[1] === os.hostname() && alive(Number(m[2])) ? Number(m[2]) : 0;
}
// This process holds the profile's browser until the returned function runs (the supervisor keeps it running meanwhile).
const holds = new Map(); // hold file → count in this process
const holdFile = (identity, home, pid = process.pid) => path.join(controlDir(home), `${normIdentity(identity)}.hold.${pid}`);
export function holdBrowser(identity, home = liveHome()) {
  const f = holdFile(identity, home);
  if (!holds.get(f)) { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, ''); }
  holds.set(f, (holds.get(f) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = holds.get(f) - 1;
    if (n > 0) holds.set(f, n); else { holds.delete(f); fs.rmSync(f, { force: true }); }
  };
}
process.once('exit', () => { for (const f of holds.keys()) try { fs.rmSync(f, { force: true }); } catch {} });
function held(identity, home) {
  const pre = `${normIdentity(identity)}.hold.`;
  let files = [];
  try { files = fs.readdirSync(controlDir(home)).filter((f) => f.startsWith(pre)); } catch {}
  return !!activeRun(identity, home) || files.some((f) => { const pid = Number(f.slice(pre.length)); return pid > 0 && alive(pid); });
}
function takeLock(f) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 3; i++) {
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); return true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const pid = Number(readJson(f));
    if (pid > 0 && pid !== process.pid && alive(pid)) return false;
    try { fs.renameSync(f, `${f}.stale.${process.pid}`); fs.rmSync(`${f}.stale.${process.pid}`, { force: true }); } catch {} // only one taker wins the rename
  }
  return false;
}
const freePort = (port = 0) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(0));
  s.listen(port, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// Runs the supervisor in this process until it stops (idle, stop(), or its home is deleted). False: another one runs.
export async function superviseBrowser({ identity, home = liveHome(), executable = findBrowser(), headless = !hasDisplay(), idleMs = IDLE_MS, healthMs = HEALTH_MS,
  log = (s) => console.log(`${new Date().toISOString()} [${identity}] ${s}`) } = {}) {
  identity = normIdentity(identity);
  const lock = lockFile(identity, home), profile = profileDir(identity, home);
  if (!takeLock(lock)) return false;
  const st = { pid: process.pid, identity, port: browserState(identity, home)?.port || null, ws: null, chromePid: null, since: Date.now(),
    restarts: 0, failures: 0, error: null, fatal: false, executable, headless };
  const save = () => { try { writeJson(stateFile(identity, home), st); } catch {} };
  let chrome = null, stopping = false, pending = null, retry = null, misses = 0, idleSince = Date.now(), ticking = false, finished;
  const done = new Promise((r) => { finished = r; });
  const lost = (c, why) => {
    if (chrome !== c || stopping) return;
    log(`Chromium ${c.pid ?? ''} ${why}: restarting`);
    chrome = null; misses = 0; st.restarts++;
    Object.assign(st, { ws: null, chromePid: null });
    save();
    bring();
  };
  // Launches Chromium, or adopts one that already holds the profile and answers (an older agent-orch started it).
  async function up() {
    const holder = profileHolder(profile);
    if (holder) {
      const port = devtoolsPort(profile), ws = port && await probe(port);
      if (ws) return { pid: holder, port, ws, child: null };
      log(`Chromium ${holder} holds the profile but does not answer: stopping it`);
      kill(holder, 'SIGTERM');
      await until(() => !alive(holder), 3000);
      kill(holder, 'SIGKILL');
      await until(() => !alive(holder), 2000);
    }
    if (holder !== null) for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(profile, f), { force: true });
    const port = (st.port && await freePort(st.port)) || await freePort();
    return launchChrome({ identity, home, executable, headless, port });
  }
  function bring() {
    if (stopping || chrome || pending) return pending;
    clearTimeout(retry);
    pending = (async () => {
      let c;
      try { c = await up(); } catch (e) {
        Object.assign(st, { failures: st.failures + 1, error: e.message, fatal: !executable });
        log(`could not start Chromium: ${e.message}`);
        if (!st.fatal) retry = setTimeout(bring, Math.min(10_000, 500 * 2 ** (st.failures - 1)));
        return save();
      }
      if (stopping) return closeChrome(c).catch(() => {});
      chrome = c;
      Object.assign(st, { port: c.port, ws: c.ws, chromePid: c.pid, failures: 0, error: null, startedAt: Date.now() });
      save();
      log(`${c.child ? 'started' : 'adopted'} Chromium ${c.pid} on port ${c.port}`);
      c.child?.once('exit', (code, sig) => lost(c, `exited (${sig || code})`));
    })().finally(() => { pending = null; });
    return pending;
  }
  async function check() {
    if (stopping || ticking) return;
    ticking = true;
    try {
      if (!fs.existsSync(controlDir(home))) return stop('its folder is gone');
      if (held(identity, home)) idleSince = Date.now();
      else if (Date.now() - idleSince >= idleMs) return stop('idle');
      const c = chrome;
      if (!c) return void bring();
      if (!alive(c.pid)) return lost(c, 'is gone');
      if (await probe(c.port)) { misses = 0; return; }
      if (++misses < 2) return;
      kill(c.pid, 'SIGKILL');
      lost(c, 'stopped answering');
    } finally { ticking = false; }
  }
  async function stop(why = 'stopped') {
    if (stopping) return done;
    stopping = true;
    clearInterval(timer); clearTimeout(retry);
    log(`stopping (${why})`);
    await pending;
    if (chrome) await closeChrome(chrome).catch(() => {});
    chrome = null;
    fs.rmSync(stateFile(identity, home), { force: true });
    if (Number(readJson(lock)) === process.pid) fs.rmSync(lock, { force: true });
    finished();
    return done;
  }
  const timer = setInterval(check, healthMs);
  save();
  await bring();
  return { stop, done, state: () => ({ ...st }) };
}
function spawnSupervisor(identity, home, { executable, headless }) {
  const dir = controlDir(home), log = path.join(dir, `${normIdentity(identity)}.log`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { if (fs.statSync(log).size > 1024 * 1024) fs.rmSync(log); } catch {}
  const fd = fs.openSync(log, 'a', 0o600);
  const c = spawn(process.execPath, [SELF, 'supervise', '--identity', normIdentity(identity), '--home', home, '--headless', headless ? '1' : '0',
    ...(executable ? ['--executable', executable] : [])], { detached: true, stdio: ['ignore', fd, fd] });
  c.unref();
  fs.closeSync(fd);
}
// The profile's supervised Chromium ({port, ws, pid}), started (with its supervisor) when none runs. Throws with the
// supervisor's reason when Chromium can't start.
export async function startBrowser(identity, { home = liveHome(), executable = findBrowser(), headless = !hasDisplay(), timeoutMs = 45_000 } = {}) {
  identity = normIdentity(identity);
  const deadline = Date.now() + timeoutMs;
  let spawnedAt = 0;
  for (;;) {
    const sup = supervisorPid(identity, home), st = browserState(identity, home), mine = sup && st?.pid === sup;
    if (mine && st.port && st.chromePid) { const ws = await probe(st.port); if (ws) return { port: st.port, ws, pid: st.chromePid }; }
    if (mine && st.error && (st.fatal || st.failures >= 3)) throw new Error(st.error);
    if (!sup && Date.now() - spawnedAt > 5000) {
      if (!executable) throw new Error('no Chromium or Chrome on this machine');
      spawnSupervisor(identity, home, { executable, headless });
      spawnedAt = Date.now();
    }
    if (Date.now() > deadline) throw new Error(mine && st.error ? st.error : 'the browser did not start in time');
    await sleep(150);
  }
}
// The supervised Chromium's {port, ws} while it answers, else null (starts nothing).
export async function browserEndpoint(identity, home = liveHome()) {
  const sup = supervisorPid(identity, home), st = browserState(identity, home);
  const ws = sup && st?.pid === sup && st.port && st.chromePid ? await probe(st.port) : null;
  return ws ? { port: st.port, ws, pid: st.chromePid } : null;
}
// Stops the profile's supervisor and its Chromium (a clear, a node shutting down). False when none ran.
export async function stopBrowser(identity, home = liveHome(), ms = 12_000) {
  const pid = supervisorPid(identity, home);
  if (!pid) return false;
  const chromePid = browserState(identity, home)?.chromePid;
  kill(pid, 'SIGTERM');
  await until(() => !alive(pid), ms);
  if (alive(pid)) { kill(pid, 'SIGKILL'); if (chromePid) kill(chromePid, 'SIGKILL'); }
  return true;
}
// Pre-warm (agents.mjs, before a browser run's agent starts): the profile's supervised Chromium runs and its DevTools
// endpoint answers /json/version, so the run's MCP only has to attach. restart stops it first (a retry after the MCP
// failed to connect), so a fresh one starts. The supervisor owns it: nobody closes it after the run. → {port, ws, pid, ms}.
export async function warmBrowser({ identity, home = liveHome(), executable, headless, restart = false, timeoutMs } = {}) {
  const t0 = Date.now();
  if (restart) await closeProfile(identity, home);
  const ep = await startBrowser(identity, { home, ...(executable && { executable }), ...(headless != null && { headless }), ...(timeoutMs && { timeoutMs }) });
  return { ...ep, ms: Date.now() - t0 };
}
// Closes whichever Chromium has the profile open (the supervised one with its supervisor, or one another process started)
// and waits until it's gone.
export async function closeProfile(identity, home = liveHome(), ms = 15_000) {
  if (await stopBrowser(identity, home, ms)) return true;
  const ep = await endpointFor(identity, home);
  if (!ep) return false;
  try { const c = await cdpConnect(ep.ws); await Promise.race([c.send('Browser.close').catch(() => {}), c.closed]); c.close(); } catch {}
  const lock = path.join(profileDir(identity, home), 'SingletonLock'), deadline = Date.now() + ms;
  const held = () => { try { fs.lstatSync(lock); return true; } catch { return false; } };
  while (Date.now() < deadline && (await probe(ep.port) || held())) await sleep(200);
  return true;
}

// ---- a minimal CDP client (flattened sessions)
export function cdpConnect(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024, handshakeTimeout: 10_000 });
    let id = 0;
    const waits = new Map(), listeners = new Set();
    const closed = new Promise((r) => sock.once('close', r));
    sock.once('error', reject);
    sock.once('open', () => {
      sock.on('error', () => {});
      resolve({
        send(method, params = {}, sessionId) {
          if (sock.readyState !== 1) return Promise.reject(new Error('browser connection closed'));
          const n = ++id;
          sock.send(JSON.stringify({ id: n, method, params, ...(sessionId && { sessionId }) }));
          return new Promise((res, rej) => waits.set(n, { res, rej, method }));
        },
        on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        close() { try { sock.close(); } catch {} },
        closed,
      });
    });
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.id != null) {
        const w = waits.get(m.id); waits.delete(m.id);
        if (w) m.error ? w.rej(new Error(`${w.method}: ${m.error.message}`)) : w.res(m.result);
      } else for (const fn of listeners) { try { fn(m); } catch {} }
    });
    sock.once('close', () => { for (const w of waits.values()) w.rej(new Error('browser connection closed')); waits.clear(); });
  });
}

// Owner-typed URL → a URL to open: http(s) only (a bare host gets https://), or null.
export function normUrl(s) {
  s = String(s ?? '').trim();
  if (!s) return null;
  if (s === 'about:blank') return s;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^(about|javascript|data|blob|view-source|chrome|mailto|file):/i.test(s)) s = `${/^(localhost|127\.|\[?::1)/.test(s) ? 'http' : 'https'}://${s}`;
  try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
}

const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const mods = (e) => Object.entries(MODS).reduce((n, [k, b]) => n | (e[k] ? b : 0), 0);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const BUTTONS = { left: 1, right: 2, middle: 4 };
// One owner input event (from the viewer) → the CDP calls that replay it.
export function inputCalls(e) {
  if (!e || typeof e !== 'object') return [];
  const x = num(e.x), y = num(e.y), modifiers = mods(e);
  if (e.type === 'mouse') {
    const button = ['left', 'right', 'middle'].includes(e.button) ? e.button : 'left';
    const type = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved', wheel: 'mouseWheel' }[e.action];
    if (!type) return [];
    if (type === 'mouseWheel') return [['Input.dispatchMouseEvent', { type, x, y, deltaX: num(e.dx), deltaY: num(e.dy), modifiers }]];
    return [['Input.dispatchMouseEvent', { type, x, y, modifiers, button: type === 'mouseMoved' ? (e.buttons ? button : 'none') : button,
      buttons: type === 'mouseReleased' ? 0 : type === 'mousePressed' || e.buttons ? BUTTONS[button] : 0, clickCount: type === 'mouseMoved' ? 0 : Math.max(1, Math.min(3, num(e.clickCount, 1))) }]];
  }
  if (e.type === 'click') {
    const b = { x, y, modifiers, button: 'left', clickCount: 1 };
    return [['Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers }], ['Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...b }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...b }]];
  }
  if (e.type === 'text') return typeof e.text === 'string' && e.text ? [['Input.insertText', { text: e.text.slice(0, 10_000) }]] : [];
  if (e.type === 'key') {
    const key = String(e.key || '').slice(0, 32), code = String(e.code || '').slice(0, 32);
    if (!key) return [];
    const text = key.length === 1 && !(modifiers & (MODS.ctrl | MODS.meta)) ? key : key === 'Enter' ? '\r' : '';
    const kc = num(e.keyCode, KEYCODES[key] || CODES[code] || (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0));
    const base = { key, code, modifiers, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc };
    if (e.action === 'up') return [['Input.dispatchKeyEvent', { type: 'keyUp', ...base }]];
    const down = ['Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text && { text, unmodifiedText: text }) }];
    return e.action === 'down' ? [down] : [down, ['Input.dispatchKeyEvent', { type: 'keyUp', ...base }]];
  }
  return [];
}
const KEYCODES = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Shift: 16, Control: 17, Alt: 18, Meta: 91 };
// Punctuation by its physical key (a '.' must not become 46, Delete's code).
const CODES = { Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220,
  BracketRight: 221, Quote: 222, ...Object.fromEntries([...'0123456789'].map((d) => [`Digit${d}`, 48 + Number(d)])) };

// Profiles on this node: the folders under profiles/ plus the default one.
export function listProfiles(home = liveHome()) {
  let names = [];
  try { names = fs.readdirSync(path.join(browserRoot(home), 'profiles')).filter((n) => IDENTITY_RE.test(n)); } catch {}
  return [...new Set([DEFAULT_IDENTITY, ...names])].sort((a, b) => (a !== DEFAULT_IDENTITY) - (b !== DEFAULT_IDENTITY) || a.localeCompare(b));
}

// One node's live views. Each profile has at most one view (the head fans it out to every viewer): start(identity,
// {url, size, onFrame, onState}) → the view, input/nav/resize/stop by identity. The browser is the profile's supervised
// Chromium (startBrowser; browser(identity) in tests), held while a view is open. When it restarts the view says
// `reconnecting` and attaches again (with a fresh frame), or reports why it couldn't within restartMs. While a task uses
// the profile the view follows the agent's tab (`agentTab`) and leaves its page's layout alone. The last viewer size of
// a profile is kept for its next view, except that a view opened while a task uses the profile stays desktop.
export function createLiveBrowsers({ home = liveHome(), executable, headless, fps = FPS, restartMs = 60_000, log = () => {}, browser } = {}) {
  const own = !browser; // the supervised Chromium (not a test's): close() stops the ones this manager used
  browser ||= (identity, { timeoutMs } = {}) => startBrowser(identity, { home, executable: executable || findBrowser(), headless: headless ?? !hasDisplay(), timeoutMs });
  const views = new Map(), used = new Set(), sizes = new Map(), phone = new Map(); // phone: the page was last laid out for a phone
  // Nothing may be taken over at boot: the viewer that set a flag is gone.
  try { for (const f of fs.readdirSync(controlDir(home))) if (f.endsWith('.takeover')) fs.rmSync(path.join(controlDir(home), f), { force: true }); } catch {}
  const isAgent = (v, id) => !!activeRun(v.identity, home) && (v.agentTargets.has(id) || agentTab(v.identity, home) === id);

  async function start(identity, { url, size, onFrame, onState } = {}) {
    identity = normIdentity(identity);
    let v = views.get(identity);
    if (v) {
      Object.assign(v, { onFrame: onFrame || v.onFrame, onState: onState || v.onState });
      await v.ready;
      if (viewSize(size)) await resize(identity, size);
      if (url) await nav(identity, { action: 'go', url });
      v.emitState();
      return v.public;
    }
    const metrics = viewSize(size) ? viewMetrics(size) : !activeRun(identity, home) && sizes.get(identity) || viewMetrics(null);
    if (viewSize(size)) sizes.set(identity, metrics);
    v = { identity, onFrame, onState, seq: 0, url: '', title: '', session: null, target: null, cdp: null, closed: false, lastSent: 0, metrics, quality: 60, ua: '',
      agentTargets: new Set(), urls: new Map(), reconnecting: false, framed: 0, castAt: 0, release: holdBrowser(identity, home) };
    views.set(identity, v);
    v.emitState = (extra = {}) => v.onState?.({ identity, url: v.url, title: v.title, active: !!activeRun(identity, home), takeover: takenOver(identity, home),
      reconnecting: v.reconnecting, agentTab: !!v.target && isAgent(v, v.target), ...extra });
    v.public = { identity, input: (evs) => input(identity, evs), nav: (a) => nav(identity, a), resize: (z) => resize(identity, z), stop: () => stop(identity) };
    v.ready = connect(v, { blank: !url });
    try { await v.ready; } catch (e) { stop(identity); throw new Error(`The browser could not start: ${e.message}`); }
    if (url) await nav(identity, { action: 'go', url });
    v.emitState();
    return v.public;
  }
  // Attaches the view to the profile's browser: the agent's tab while a task runs, else the newest tab (or a new one).
  async function connect(v, { blank = true, timeoutMs } = {}) {
    const ep = await browser(v.identity, { timeoutMs });
    if (own) used.add(v.identity);
    const cdp = await cdpConnect(ep.ws);
    if (v.closed) return cdp.close();
    Object.assign(v, { cdp, session: null, casting: false, applied: null });
    cdp.closed.then(() => { if (!v.closed && v.cdp === cdp) reconnect(v); });
    cdp.on((m) => onEvent(v, m));
    v.ua = (await within(cdp.send('Browser.getVersion'))).userAgent || '';
    const fail = (e) => { if (v.cdp === cdp) v.cdp = null; cdp.close(); throw e; }; // a browser that doesn't answer: try again
    await must(cdp.send('Target.setDiscoverTargets', { discover: true })).catch(fail);
    const { targetInfos } = await must(cdp.send('Target.getTargets')).catch(fail);
    const pages = targetInfos.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
    const target = pages.find((t) => isAgent(v, t.targetId))?.targetId || pages.at(-1)?.targetId || (await must(cdp.send('Target.createTarget', { url: 'about:blank' })).catch(fail)).targetId;
    await must(attach(v, target, { blank }), 20_000).catch(fail);
  }
  // The browser went away (a crash, the supervisor restarting it): the viewer sees `reconnecting` until the view is
  // attached to the new one, or the reason it couldn't be.
  function reconnect(v) {
    if (v.closed || v.reconnecting) return;
    // The agent's tab died with the browser: the next page that navigates while its run goes on is its new tab.
    Object.assign(v, { reconnecting: true, session: null, casting: false, lostAgent: !!activeRun(v.identity, home) });
    log(`browser: profile ${v.identity}'s browser went away; reconnecting`);
    v.emitState({ note: 'The browser restarted: reconnecting…' });
    const end = Date.now() + restartMs;
    v.ready = (async () => {
      let err = null;
      while (!v.closed && Date.now() < end) {
        try { await connect(v, { timeoutMs: Math.max(1000, end - Date.now()) }); v.reconnecting = false; v.emitState(); return; }
        catch (e) { err = e; await sleep(1000); }
      }
      if (v.closed) return;
      stop(v.identity);
      v.onState?.({ identity: v.identity, closed: true, error: `The browser could not restart: ${err?.message || 'it did not come back'}` });
    })();
  }
  // blank: an empty page (about:blank, a new tab) goes to homeUrl(), unless a task is using the profile.
  async function attach(v, targetId, { blank = false } = {}) {
    const old = v.session, cdp = v.cdp;
    v.target = targetId;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    if (v.cdp !== cdp || v.target !== targetId) return cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    v.session = sessionId;
    v.applied = null; v.casting = false;
    if (old) cdp.send('Target.detachFromTarget', { sessionId: old }).catch(() => {});
    const s = (m, p) => cdp.send(m, p, sessionId);
    await s('Page.enable');
    // A background headless page never has focus, so typed keys would go nowhere.
    await s('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    const { entries, currentIndex } = await s('Page.getNavigationHistory').catch(() => ({ entries: [] }));
    const cur = entries?.[currentIndex];
    if (cur) Object.assign(v, { url: cur.url, title: cur.title });
    const goHome = blank && isBlank(v.url) && !activeRun(v.identity, home);
    await applyMetrics(v, { reload: !goHome });
    if (goHome) { v.url = homeUrl(); await s('Page.navigate', { url: v.url }).catch(() => {}); }
    v.emitState();
  }
  // The view's metrics on its page: the viewport (headless Chromium has no window to size it, so frames and clicks agree
  // only through this), touch and the user agent for a phone, and a screencast sized to match. Serialised per view. A
  // page that switches between phone and desktop reloads (sites pick their layout from the user agent) unless a task
  // uses the profile.
  function applyMetrics(v, { reload = true } = {}) {
    v.mq = (v.mq || Promise.resolve()).then(async () => {
      const session = v.session, m = v.metrics;
      if (!session || v.closed) return;
      const s = (method, p) => v.cdp.send(method, p, session);
      // While a task uses the profile its page keeps its own layout: a new one would move what the agent is clicking.
      // (watch() applies the view's metrics once the task is done.)
      if (activeRun(v.identity, home)) { v.applied = null; return cast(v, session); }
      await s('Emulation.setDeviceMetricsOverride', metricsOverride(m)).catch(() => {});
      await s('Emulation.setTouchEmulationEnabled', m.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }).catch(() => {});
      if (v.ua) await s('Emulation.setUserAgentOverride', { userAgent: userAgent(v.ua, m.mobile), ...(m.mobile && { platform: 'Linux armv8l' }) }).catch(() => {});
      const flipped = (v.applied?.mobile ?? phone.get(v.identity) ?? false) !== m.mobile;
      v.applied = m;
      phone.set(v.identity, m.mobile);
      await cast(v, session);
      if (reload && flipped && /^https?:/.test(v.url) && !activeRun(v.identity, home)) await s('Page.reload').catch(() => {});
    }).catch(() => {});
    return v.mq;
  }
  // (Re)starts the screencast at the page's size (the view's metrics, else the page's own), after a screenshot as its
  // first frame: the viewer gets the page at once, even one that never repaints (and so never sends a screencast frame).
  async function cast(v, session) {
    const s = (method, p) => within(v.cdp.send(method, p, session)), seq = v.seq;
    if (v.casting) await s('Page.stopScreencast');
    let m = v.applied;
    if (!m) {
      const r = await s('Page.getLayoutMetrics'), z = r.cssVisualViewport || r.visualViewport;
      m = { ...(z?.clientWidth > 0 ? { width: Math.round(z.clientWidth), height: Math.round(z.clientHeight) } : VIEWPORT), deviceScaleFactor: MAX_SCALE };
    }
    const shot = await s('Page.captureScreenshot', { format: 'jpeg', quality: v.quality });
    // Headless Chromium's screenshot leaves input scaled by its screen's factor instead of the emulated one: re-apply it.
    if (v.applied) await s('Emulation.setDeviceMetricsOverride', metricsOverride(m));
    if (shot.data && shot.data.length <= MAX_FRAME_B64 && !v.closed && v.session === session && v.seq === seq) { v.framed = Date.now(); emit(v, { data: shot.data, w: m.width, h: m.height }); }
    await s('Page.startScreencast', { format: 'jpeg', quality: v.quality, ...castSize(m) });
    Object.assign(v, { casting: true, castAt: Date.now() });
  }

  // Every 2 s: a view whose task finished gets the viewer's metrics again, and one without a frame for STALE_MS restarts
  // its screencast with a fresh screenshot (Chromium sometimes never casts a tab that another client, the agent's MCP,
  // is still setting up; a page that doesn't repaint just gets a screenshot now and then).
  const watch = setInterval(() => {
    for (const v of views.values()) {
      if (!v.session || v.reconnecting) continue;
      if (!v.applied && !activeRun(v.identity, home)) applyMetrics(v);
      else if (v.casting && Date.now() - Math.max(v.framed, v.castAt) > STALE_MS) {
        const session = v.session;
        v.castAt = Date.now();
        v.mq = (v.mq || Promise.resolve()).then(() => cast(v, session)).catch(() => {});
      }
    }
  }, 2000);
  watch.unref?.();
  // A frame to the viewer: at most fps a second; one arriving sooner waits, and a newer one replaces it.
  function emit(v, f) {
    v.latest = f;
    if (v.flush) return;
    const wait = v.lastSent + 1000 / fps - Date.now();
    const send = () => {
      v.flush = null;
      const x = v.latest;
      v.latest = null;
      if (!x || v.closed) return;
      v.lastSent = Date.now();
      v.onFrame?.({ identity: v.identity, n: ++v.seq, ...x });
    };
    if (wait <= 0) send(); else v.flush = setTimeout(send, wait);
  }
  // A viewer's new size (its canvas, CSS px, and dpr). Kept for the profile's next view.
  async function resize(identity, size) {
    identity = normIdentity(identity);
    if (!viewSize(size)) return false;
    const m = viewMetrics(size);
    sizes.set(identity, m);
    const v = views.get(identity);
    if (!v) return false;
    await v.ready;
    if (['width', 'height', 'deviceScaleFactor', 'mobile'].every((k) => v.metrics[k] === m[k])) return true;
    v.metrics = m;
    await applyMetrics(v);
    return true;
  }
  function onEvent(v, m) {
    if (m.method === 'Page.screencastFrame' && m.sessionId === v.session) {
      const { data, metadata, sessionId: frameId } = m.params, session = v.session;
      // Acked at once: Chromium sends the next frame only after the ack.
      v.cdp.send('Page.screencastFrameAck', { sessionId: frameId }, session).catch(() => {});
      v.framed = Date.now();
      if (data.length <= MAX_FRAME_B64) emit(v, { data, w: Math.round(metadata.deviceWidth), h: Math.round(metadata.deviceHeight) });
      else if (v.quality > 30) { v.quality -= 15; v.mq = (v.mq || Promise.resolve()).then(() => cast(v, session)).catch(() => {}); } // too big for the wire: a coarser JPEG
    } else if (m.method === 'Page.frameNavigated' && m.sessionId === v.session && !m.params.frame.parentId) {
      v.url = m.params.frame.url;
      v.emitState();
    } else if (m.method === 'Target.targetInfoChanged') {
      const t = m.params.targetInfo, before = v.urls.get(t.targetId);
      v.urls.set(t.targetId, t.url);
      const found = v.lostAgent && before !== undefined && before !== t.url && !isBlank(t.url) && !!activeRun(v.identity, home);
      if (found) { v.lostAgent = false; v.agentTargets.add(t.targetId); }
      if (t.targetId === v.target) {
        Object.assign(v, { url: t.url, title: t.title });
        v.emitState();
      } else if (t.type === 'page' && v.session && before !== undefined && before !== t.url && !isBlank(t.url) && isAgent(v, t.targetId)) {
        attach(v, t.targetId).catch(() => {}); // the agent went on in another of its tabs: follow it
      }
    } else if (m.method === 'Target.targetCreated' && m.params.targetInfo.type === 'page') {
      // A new tab (the agent's or a pop-up): follow it. An empty tab the owner opened goes to the home page.
      const t = m.params.targetInfo;
      v.urls.set(t.targetId, t.url);
      if (!v.session) return; // the tabs that were already open, listed as the view attaches
      if (activeRun(v.identity, home)) v.agentTargets.add(t.targetId);
      attach(v, t.targetId, { blank: !t.openerId }).catch(() => {});
    } else if (m.method === 'Target.targetDestroyed' && m.params.targetId === v.target) {
      v.session = null;
      v.agentTargets.delete(m.params.targetId);
      v.cdp.send('Target.getTargets').then(({ targetInfos }) => {
        const pages = targetInfos.filter((t) => t.type === 'page'), next = pages.find((t) => isAgent(v, t.targetId)) || pages.at(-1);
        if (next) return attach(v, next.targetId);
        if (v.closed) return;
        // The last tab closed: a new one on the home page, unless a task is using the profile.
        if (!activeRun(v.identity, home)) return v.cdp.send('Target.createTarget', { url: 'about:blank' }).then(({ targetId }) => attach(v, targetId, { blank: true }));
        v.onState?.({ identity: v.identity, url: '', title: '', note: 'no open page' });
      }).catch(() => {});
    }
  }
  function input(identity, events) {
    const v = views.get(normIdentity(identity));
    if (!v?.session || !Array.isArray(events)) return false;
    // In order, across calls too: a click's press must land before its release, a key's down before its up.
    for (const e of events.slice(0, 200)) for (const [m, params] of inputCalls(e)) v.chain = (v.chain || Promise.resolve()).then(() => v.session && v.cdp.send(m, params, v.session)).catch(() => {});
    return v.chain.then(() => true);
  }
  async function nav(identity, { action, url } = {}) {
    const v = views.get(normIdentity(identity));
    if (!v) throw new Error('no live view of that profile');
    await v.ready;
    if (!v.session) throw new Error('the browser is reconnecting; try again in a moment');
    const s = (m, p) => v.cdp.send(m, p, v.session);
    if (action === 'go') {
      const u = normUrl(url);
      if (!u) throw new Error('enter an http or https address');
      await s('Page.navigate', { url: u });
    } else if (action === 'back' || action === 'forward') {
      const { entries, currentIndex } = await s('Page.getNavigationHistory');
      const e = entries[currentIndex + (action === 'back' ? -1 : 1)];
      if (e) await s('Page.navigateToHistoryEntry', { entryId: e.id });
    } else if (action === 'reload') await s('Page.reload');
    else throw new Error('unknown navigation');
    return true;
  }
  function stop(identity) {
    identity = normIdentity(identity);
    const v = views.get(identity);
    if (!v) return false;
    views.delete(identity);
    v.closed = true;
    clearTimeout(v.flush);
    v.release();
    if (v.session) v.cdp?.send('Page.stopScreencast', {}, v.session).catch(() => {}).finally(() => v.cdp?.close());
    else v.cdp?.close();
    return true;
  }
  // Cookie domains in the profile (names of sites only, never values), newest Chromium state.
  async function sites(identity) {
    identity = normIdentity(identity);
    const release = holdBrowser(identity, home);
    let c = null;
    try {
      c = await cdpConnect((await browser(identity)).ws);
      if (own) used.add(identity);
      const { cookies } = await c.send('Storage.getCookies');
      const by = new Map();
      for (const k of cookies) { const d = String(k.domain).replace(/^\./, ''); by.set(d, (by.get(d) || 0) + 1); }
      return [...by].map(([domain, count]) => ({ domain, count })).sort((a, b) => a.domain.localeCompare(b.domain));
    } finally { c?.close(); release(); }
  }
  // Signs the profile out of everything: its browser stops and its folder is deleted. Refused while a task uses it.
  async function clear(identity) {
    identity = normIdentity(identity);
    if (activeRun(identity, home)) throw new Error('a task is using this profile; wait for it to finish');
    stop(identity);
    await stopBrowser(identity, home);
    const dir = profileDir(identity, home);
    if (profileHolder(dir)) throw new Error('another browser has this profile open');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return true;
  }
  async function profiles() {
    return Promise.all(listProfiles(home).map(async (identity) => ({
      identity, open: views.has(identity), running: !!(await browserEndpoint(identity, home)),
      active: !!activeRun(identity, home), takeover: takenOver(identity, home),
    })));
  }
  function takeover(identity, on) {
    setTakeover(identity, !!on, home);
    views.get(normIdentity(identity))?.emitState();
    return !!on;
  }
  // Every view stops and every take-over ends (the viewers are gone: the head's connection dropped).
  function release() {
    for (const id of [...views.keys()]) stop(id);
    for (const id of listProfiles(home)) if (takenOver(id, home)) setTakeover(id, false, home);
  }
  // The node shuts down: the browsers it used stop too, unless a task still uses one.
  async function close() {
    clearInterval(watch);
    release();
    await Promise.all([...used].filter((id) => !activeRun(id, home)).map((id) => stopBrowser(id, home).catch(() => {})));
    used.clear();
  }
  return { start, stop, input, nav, resize, sites, clear, profiles, takeover, release, close, has: (id) => views.has(normIdentity(id)), home };
}

// One screen.req (cluster-protocol.mjs) against a node's manager → its result object. The head runs the same ops on its
// own manager, so a profile on the controller and one on a worker behave alike.
export async function screenOp(m, { op, identity, url, action, on, size }, { onFrame, onState } = {}) {
  switch (op) {
    case 'profiles': return { profiles: await m.profiles() };
    case 'open': await m.start(identity, { url: url || undefined, size, onFrame, onState }); return { ok: true };
    case 'size': return { ok: await m.resize(identity, size) };
    case 'stop': return { ok: m.stop(identity) };
    case 'nav': return { ok: await m.nav(identity, { action, url }) };
    case 'takeover': return { takeover: m.takeover(identity, on) };
    case 'sites': return { sites: await m.sites(identity) };
    case 'clear': return { ok: await m.clear(identity) };
    default: throw new Error(`unknown screen op ${op}`);
  }
}

// `node browser-live.mjs supervise --identity <id> --home <dir> [--executable <path>] [--headless 1|0]`: the profile's
// supervisor process (spawned detached by startBrowser).
if (process.argv[2] === 'supervise' && process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const s = await superviseBrowser({ identity: arg('--identity'), home: arg('--home') || liveHome(), executable: arg('--executable') || findBrowser(),
    headless: arg('--headless') != null ? arg('--headless') === '1' : !hasDisplay() });
  if (!s) process.exit(0); // another supervisor has the profile
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => s.stop(sig));
  await s.done;
  process.exit(0);
}
