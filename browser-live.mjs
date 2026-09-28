// The live browser view (AGENTIC.md → Browser → One-time sign-in): on the node that holds a profile, one Chromium per
// profile with a DevTools port on 127.0.0.1, started by whoever needs it first (a viewer here, or a browser task's MCP
// shim, bin/browser-mcp.mjs) and attached to by the other. A view streams CDP Page.startScreencast JPEG frames (acked at
// most FPS times a second, so a slow viewer slows Chromium down instead of queueing) and replays the owner's input with
// Input.dispatch*. The page is laid out for the viewer's screen (its canvas size and devicePixelRatio; a phone layout
// below MOBILE_MAX px), else for a desktop VIEWPORT (no viewer's size yet, or a task nobody watches). A profile opens on
// homeUrl(). Take-over is a flag file the shim checks before each MCP tools/call, so it works the same on every node.
// Worker-safe: node built-ins, ws and browser.mjs only (test/compute-only.test.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { browserRoot, profileDir, normIdentity, findBrowser, hasDisplay, IDENTITY_RE, DEFAULT_IDENTITY } from './browser.mjs';

export const FPS = 8;
export const VIEWPORT = { width: 1280, height: 800 };
export const MOBILE_MAX = 768;
const MAX_SCALE = 2; // frames are at most 2× the page's CSS size (bandwidth) …
const MAX_PIXELS = 2560 * 1600; // … and at most this many pixels
const MAX_FRAME_B64 = 900 * 1024; // a frame must fit the cluster's MAX_FRAME with room to spare
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
// The running Chromium on this profile ({port, ws}), or null. Chromium writes DevToolsActivePort into the profile.
export async function endpointFor(identity, home = liveHome()) {
  let port;
  try { port = Number(fs.readFileSync(path.join(profileDir(identity, home), 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { return null; }
  const ws = port > 0 ? await probe(port) : null;
  return ws ? { port, ws } : null;
}
// Headless Chromium screencasts at its screen's scale whatever the emulated deviceScaleFactor, so its screen is MAX_SCALE×
// (frames of a 1× view are scaled down to castSize) and VIEWPORT-sized in CSS px.
const screenInfo = `--screen-info={${VIEWPORT.width * MAX_SCALE}x${VIEWPORT.height * MAX_SCALE} devicePixelRatio=${MAX_SCALE}}`;
// Starts Chromium on the profile, on homeUrl(). The flags match Playwright's (basic password store, mock keychain) so
// cookies saved by either stay readable by the other.
export async function launchChrome({ identity, home = liveHome(), executable = findBrowser(), headless = !hasDisplay(), timeoutMs = 45_000 } = {}) {
  if (!executable) throw new Error('no Chromium or Chrome on this machine');
  const profile = profileDir(identity, home);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const portFile = path.join(profile, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
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
    const ep = await endpointFor(identity, home);
    if (ep) return { ...ep, child };
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill('SIGKILL');
  throw new Error('Chromium did not start in time');
}
// Closes Chromium gracefully (so it writes its cookies out), then kills it.
export async function closeChrome(chrome, ms = 8000) {
  const { child } = chrome;
  if (!child || child.exitCode != null || child.signalCode) return;
  const gone = new Promise((r) => child.once('exit', r));
  try { const c = await cdpConnect(chrome.ws); c.send('Browser.close').catch(() => {}); } catch { child.kill('SIGTERM'); }
  const t = setTimeout(() => child.kill('SIGKILL'), ms);
  await gone;
  clearTimeout(t);
}

// ---- a minimal CDP client (flattened sessions)
export function cdpConnect(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
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
// {url, size, onFrame, onState}) → the view, input/nav/resize/stop by identity. A Chromium the manager started itself is
// closed once no view and no task has used it for idleMs. The last viewer size of a profile is kept for its next view,
// except that a view opened while a task uses the profile (a task drawer's thumbnail) stays desktop.
export function createLiveBrowsers({ home = liveHome(), executable, headless, fps = FPS, idleMs = 60_000, log = () => {} } = {}) {
  const views = new Map(), chromes = new Map(), idle = new Map(), sizes = new Map(), phone = new Map(); // phone: the page was last laid out for a phone
  // Nothing may be taken over at boot: the viewer that set a flag is gone.
  try { for (const f of fs.readdirSync(controlDir(home))) if (f.endsWith('.takeover')) fs.rmSync(path.join(controlDir(home), f), { force: true }); } catch {}

  async function chromeFor(identity) {
    clearTimeout(idle.get(identity)); idle.delete(identity);
    const ep = await endpointFor(identity, home);
    if (ep) return ep;
    const own = chromes.get(identity);
    if (own?.child.exitCode == null && own?.child.signalCode == null && own) return own;
    const c = await launchChrome({ identity, home, executable: executable || findBrowser(), headless: headless ?? !hasDisplay() });
    chromes.set(identity, c);
    c.child.once('exit', () => { if (chromes.get(identity) === c) chromes.delete(identity); });
    log(`browser: started Chromium for profile ${identity}`);
    return c;
  }
  // Closes an own Chromium that nothing uses any more (a task's shim may have attached to it meanwhile).
  function idleCheck(identity) {
    clearTimeout(idle.get(identity));
    if (!chromes.has(identity)) return;
    const t = setTimeout(() => {
      idle.delete(identity);
      const c = chromes.get(identity);
      if (!c || views.has(identity)) return;
      if (activeRun(identity, home)) return idleCheck(identity);
      chromes.delete(identity);
      closeChrome(c).catch(() => {});
    }, idleMs);
    t.unref?.();
    idle.set(identity, t);
  }

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
    v = { identity, onFrame, onState, seq: 0, url: '', title: '', session: null, target: null, cdp: null, closed: false, lastAck: 0, metrics, quality: 60, ua: '' };
    views.set(identity, v);
    v.emitState = (extra = {}) => v.onState?.({ identity, url: v.url, title: v.title, active: !!activeRun(identity, home), takeover: takenOver(identity, home), ...extra });
    v.public = { identity, input: (evs) => input(identity, evs), nav: (a) => nav(identity, a), resize: (z) => resize(identity, z), stop: () => stop(identity) };
    v.ready = (async () => {
      const ep = await chromeFor(identity);
      v.cdp = await cdpConnect(ep.ws);
      v.cdp.closed.then(() => { if (!v.closed) { stop(identity); v.onState?.({ identity, closed: true, error: 'the browser closed' }); } });
      v.cdp.on((m) => onEvent(v, m));
      v.ua = (await v.cdp.send('Browser.getVersion').catch(() => ({}))).userAgent || '';
      await v.cdp.send('Target.setDiscoverTargets', { discover: true });
      const { targetInfos } = await v.cdp.send('Target.getTargets');
      const pages = targetInfos.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
      const target = pages.at(-1)?.targetId || (await v.cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
      await attach(v, target, { blank: !url });
    })();
    try { await v.ready; } catch (e) { stop(identity); throw e; }
    if (url) await nav(identity, { action: 'go', url });
    v.emitState();
    return v.public;
  }
  // blank: an empty page (about:blank, a new tab) goes to homeUrl(), unless a task is using the profile.
  async function attach(v, targetId, { blank = false } = {}) {
    const old = v.session;
    v.target = targetId;
    const { sessionId } = await v.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    v.session = sessionId;
    v.applied = null; v.casting = false;
    if (old) v.cdp.send('Target.detachFromTarget', { sessionId: old }).catch(() => {});
    const s = (m, p) => v.cdp.send(m, p, sessionId);
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
      await s('Emulation.setDeviceMetricsOverride', { width: m.width, height: m.height, deviceScaleFactor: m.deviceScaleFactor, mobile: m.mobile,
        screenWidth: m.width, screenHeight: m.height }).catch(() => {});
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
  // (Re)starts the screencast at the metrics' size. A page that doesn't repaint sends no frame, so without one soon the
  // viewer gets a screenshot instead.
  async function cast(v, session) {
    const s = (method, p) => v.cdp.send(method, p, session);
    if (v.casting) await s('Page.stopScreencast').catch(() => {});
    await s('Page.startScreencast', { format: 'jpeg', quality: v.quality, ...castSize(v.metrics) });
    v.casting = true;
    const seq = v.seq, m = v.metrics;
    setTimeout(async () => {
      if (v.closed || v.session !== session || v.seq !== seq) return;
      const { data } = await s('Page.captureScreenshot', { format: 'jpeg', quality: v.quality }).catch(() => ({}));
      if (data && data.length <= MAX_FRAME_B64 && !v.closed && v.session === session && v.seq === seq) v.onFrame?.({ identity: v.identity, n: ++v.seq, data, w: m.width, h: m.height });
    }, 800).unref?.();
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
      if (data.length <= MAX_FRAME_B64) v.onFrame?.({ identity: v.identity, n: ++v.seq, data, w: Math.round(metadata.deviceWidth), h: Math.round(metadata.deviceHeight) });
      else if (v.quality > 30) { v.quality -= 15; v.mq = (v.mq || Promise.resolve()).then(() => cast(v, session)).catch(() => {}); } // too big for the wire: a coarser JPEG
      // The ack asks Chromium for the next frame: at most fps a second.
      const wait = Math.max(0, v.lastAck + 1000 / fps - Date.now());
      setTimeout(() => { v.lastAck = Date.now(); if (!v.closed && v.session === session) v.cdp.send('Page.screencastFrameAck', { sessionId: frameId }, session).catch(() => {}); }, wait);
    } else if (m.method === 'Page.frameNavigated' && m.sessionId === v.session && !m.params.frame.parentId) {
      v.url = m.params.frame.url;
      v.emitState();
    } else if (m.method === 'Target.targetInfoChanged' && m.params.targetInfo.targetId === v.target) {
      Object.assign(v, { url: m.params.targetInfo.url, title: m.params.targetInfo.title });
      v.emitState();
    } else if (m.method === 'Target.targetCreated' && m.params.targetInfo.type === 'page' && v.session) {
      // A new tab (the task's or a pop-up): follow it. An empty tab the owner opened goes to the home page.
      attach(v, m.params.targetInfo.targetId, { blank: !m.params.targetInfo.openerId }).catch(() => {});
    } else if (m.method === 'Target.targetDestroyed' && m.params.targetId === v.target) {
      v.session = null;
      v.cdp.send('Target.getTargets').then(({ targetInfos }) => {
        const next = targetInfos.filter((t) => t.type === 'page').at(-1);
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
    if (v.session) v.cdp?.send('Page.stopScreencast', {}, v.session).catch(() => {}).finally(() => v.cdp?.close());
    else v.cdp?.close();
    idleCheck(identity);
    return true;
  }
  // Cookie domains in the profile (names of sites only, never values), newest Chromium state.
  async function sites(identity) {
    identity = normIdentity(identity);
    const ep = await chromeFor(identity);
    const c = await cdpConnect(ep.ws);
    try {
      const { cookies } = await c.send('Storage.getCookies');
      const by = new Map();
      for (const k of cookies) { const d = String(k.domain).replace(/^\./, ''); by.set(d, (by.get(d) || 0) + 1); }
      return [...by].map(([domain, count]) => ({ domain, count })).sort((a, b) => a.domain.localeCompare(b.domain));
    } finally { c.close(); if (!views.has(identity)) idleCheck(identity); }
  }
  // Signs the profile out of everything: its folder is deleted. Refused while a task uses it.
  async function clear(identity) {
    identity = normIdentity(identity);
    if (activeRun(identity, home)) throw new Error('a task is using this profile; wait for it to finish');
    stop(identity);
    const own = chromes.get(identity);
    if (own) { chromes.delete(identity); await closeChrome(own); }
    else if (await endpointFor(identity, home)) throw new Error('another browser has this profile open');
    const dir = profileDir(identity, home);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return true;
  }
  async function profiles() {
    return Promise.all(listProfiles(home).map(async (identity) => ({
      identity, open: views.has(identity), running: chromes.has(identity) || !!(await endpointFor(identity, home)),
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
  async function close() {
    release();
    for (const t of idle.values()) clearTimeout(t);
    idle.clear();
    await Promise.all([...chromes.values()].map((c) => closeChrome(c).catch(() => {})));
    chromes.clear();
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
