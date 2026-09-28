// The owner's live browser views (AGENTIC.md → Browser; the UI is public/app.js `BV`): each open view of a profile on a
// node is one session here, fanned out to every viewer on the app's /ws. The profile's node runs it (browser-live.mjs):
// the controller in-process, a worker through screen.* cluster frames. Exactly one viewer controls a session. While a
// task uses the profile the owner watches, or takes over (the node's take-over flag holds the task's browser actions)
// until they hand back; closing the view hands back too. The page is laid out for a full viewer's canvas (bv_size, and
// size on bv_open): the controller's, else the latest one's; thumbnails never size it.
//   UI → server: bv_open {node, identity, url? (followed only when this socket may drive), thumb?, size?}, bv_close, bv_input {events},
//   bv_nav {action, url?}, bv_take, bv_handback, bv_size {size: {width, height, dpr}}
//   server → UI: bv_frame {node, identity, n, data, w, h}, bv_state {node, identity, url, title, active, takeover, reconnecting, agentTab (the view
//   follows the task's own tab), role, task, closed?, error?, note?}
// Profiles live on a Mac worker by default (GET /api/browser marks the least-loaded online Mac `default`); the controller
// is the default only while no Mac is online, and is marked `slow` (a 1-core VPS can't stream a browser well).
import os from 'node:os';
import { MSG } from './cluster-protocol.mjs';
import { createLiveBrowsers, screenOp, activeRun, takenOver, viewSize } from './browser-live.mjs';
import { findBrowser, normIdentity, IDENTITY_RE } from './browser.mjs';

export const LOCAL = 'controller';
// The machine a profile lives on by default: the least-loaded online Mac that can show a browser, else the controller.
export function defaultNode(nodes) {
  const macs = nodes.filter((n) => n.mac && n.online && n.capable).sort((a, b) => (a.load ?? 99) - (b.load ?? 99));
  return macs[0] || nodes.find((n) => n.local && n.capable) || nodes.find((n) => n.online && n.capable) || null;
}
const BACKLOG = 1024 * 1024; // a viewer this far behind skips frames
const THUMB_MS = 1000; // task-drawer thumbnails get a frame a second

// cluster(): the hub or null; tasks(): running browser tasks [{id, title, node, identity}]; send(ws, msg).
export function createBrowserViews({ cluster = () => null, tasks = () => [], send, log = () => {}, local = null, timeoutMs = 60_000 } = {}) {
  let mgr = local;
  const localMgr = () => (mgr ??= createLiveBrowsers({ log }));
  const sessions = new Map(); // `${node}/${identity}` → session
  const keyOf = (node, identity) => `${node}/${identity}`;

  const nodeOf = (id) => cluster()?.listNodes().find((n) => n.id === id) || null;
  const screenable = (n) => !!n && (n.local ? !!findBrowser() : n.connected && n.inventory?.browser?.capable === true && !!n.features?.includes('screen'));
  // One screen op on a node → its result (throws with the node's error).
  async function op(node, fields, out) {
    if (node === LOCAL) return screenOp(localMgr(), fields, out);
    const hub = cluster(), n = nodeOf(node);
    if (!hub || !n) throw new Error('no such machine');
    if (!n.connected) throw new Error(`${n.name} is offline`);
    if (!n.features?.includes('screen')) throw new Error(`${n.name} runs a worker too old for the live browser view; update it`);
    const m = await hub.request(node, MSG.SCREEN_REQ, fields, fields.op === 'open' || fields.op === 'sites' || fields.op === 'clear' ? timeoutMs : 15_000);
    if (m === undefined) throw new Error(`${n.name} is not connected`);
    if (!m) throw new Error(`${n.name} did not answer`);
    if (m.error) throw new Error(m.error);
    return m.result || {};
  }

  const taskFor = (s) => tasks().find((t) => (t.node || LOCAL) === s.node && normIdentity(t.identity) === s.identity) || null;
  function stateFor(s, ws) {
    const task = taskFor(s), active = !!(s.state.active || task);
    return { t: 'bv_state', node: s.node, identity: s.identity, url: s.state.url || '', title: s.state.title || '', active, takeover: !!s.state.takeover,
      reconnecting: !!s.state.reconnecting, agentTab: !!(active && s.state.agentTab), role: s.controller === ws && (!active || s.state.takeover) ? 'control' : 'watch', task: task && { id: task.id, title: task.title },
      ...(s.closed && { closed: true }), ...(s.error && { error: s.error }), ...(s.note && { note: s.note }) };
  }
  const pushState = (s) => { for (const ws of s.viewers.keys()) send(ws, stateFor(s, ws)); };
  // Without a task on the profile, the first full viewer drives.
  function assign(s) {
    const active = s.state.active || !!taskFor(s);
    if (s.controller && !s.viewers.has(s.controller)) s.controller = null;
    if (!s.controller && !active) s.controller = [...s.viewers].find(([, v]) => !v.thumb)?.[0] || null;
    fit(s);
  }
  // The page follows the controller's canvas, else the one sized last; with none the node keeps the size it had.
  function fit(s) {
    const c = s.viewers.get(s.controller), z = c?.size || [...s.viewers.values()].filter((v) => v.size).sort((a, b) => b.sizedAt - a.sizedAt)[0]?.size;
    const key = z && JSON.stringify(z);
    if (!z || key === s.sized) return;
    s.sized = key;
    s.ready.then(() => op(s.node, { op: 'size', identity: s.identity, size: z })).catch(() => {});
  }
  const sizeViewer = (v, size) => { const z = !v.thumb && viewSize(size); if (z) Object.assign(v, { size: z, sizedAt: Date.now() }); return !!z; };

  function onFrame(s, f) {
    s.frame = f;
    const now = Date.now();
    for (const [ws, v] of s.viewers) {
      if ((ws.bufferedAmount || 0) > BACKLOG) continue;
      if (v.thumb && now - (v.last || 0) < THUMB_MS) continue;
      v.last = now;
      send(ws, { t: 'bv_frame', node: s.node, identity: s.identity, n: f.n, data: f.data, w: f.w, h: f.h });
    }
  }
  function onState(s, st) {
    if (sessions.get(s.key) !== s) return;
    if (st.closed) { s.closed = true; s.error = st.error || 'the browser closed'; pushState(s); return end(s); }
    s.state = { ...s.state, ...Object.fromEntries(Object.entries(st).filter(([k]) => ['url', 'title', 'active', 'takeover', 'reconnecting', 'agentTab'].includes(k))) };
    s.note = st.note || null;
    assign(s);
    pushState(s);
  }
  function end(s) {
    if (sessions.get(s.key) !== s) return;
    sessions.delete(s.key);
    if (!s.closed) op(s.node, { op: 'stop', identity: s.identity }).catch(() => {});
    if (s.state.takeover && !s.closed) op(s.node, { op: 'takeover', identity: s.identity, on: false }).catch(() => {});
  }

  async function open(ws, { node, identity, url, thumb, size }) {
    node = typeof node === 'string' && node ? node : LOCAL;
    identity = normIdentity(identity);
    const key = keyOf(node, identity);
    let s = sessions.get(key);
    if (!s) {
      s = { key, node, identity, viewers: new Map(), controller: null, state: {}, frame: null, closed: false, error: null, note: null, sized: null };
      sessions.set(key, s);
      const v = { thumb: !!thumb };
      if (sizeViewer(v, size)) s.sized = JSON.stringify(v.size);
      s.viewers.set(ws, v);
      // No url here: a worker's task state is known only once the view is open, so the url waits for canDrive below.
      s.ready = op(node, { op: 'open', identity, ...(v.size && { size: v.size }) }, { onFrame: (f) => onFrame(s, f), onState: (st) => onState(s, st) });
    } else {
      const v = { ...s.viewers.get(ws), thumb: !!thumb };
      sizeViewer(v, size);
      s.viewers.set(ws, v);
      if (s.frame) send(ws, { t: 'bv_frame', node, identity, n: s.frame.n, data: s.frame.data, w: s.frame.w, h: s.frame.h });
    }
    try { await s.ready; } catch (e) {
      s.closed = true; s.error = e.message;
      pushState(s);
      sessions.delete(key);
      return;
    }
    assign(s);
    pushState(s);
    // A url is followed only by a socket that may drive now, like bv_nav: never past a task without take-over.
    if (!url || thumb || !s.viewers.has(ws)) return;
    if (canDrive(s, ws)) await op(node, { op: 'nav', identity, action: 'go', url });
    else send(ws, { ...stateFor(s, ws), note: s.state.active || taskFor(s) ? 'A task is using this profile: take over to navigate' : 'Another viewer is driving: take control to navigate' });
  }
  function close(ws, s) {
    if (!s?.viewers.delete(ws)) return;
    if (s.controller === ws) {
      s.controller = null;
      if (s.state.takeover) { s.state.takeover = false; op(s.node, { op: 'takeover', identity: s.identity, on: false }).catch(() => {}); }
    }
    if (!s.viewers.size) return end(s);
    assign(s);
    pushState(s);
  }
  const canDrive = (s, ws) => s && s.controller === ws && (!(s.state.active || taskFor(s)) || s.state.takeover);

  // A bv_* message from a signed-in /ws client. True when it was one.
  function handle(ws, msg) {
    if (typeof msg.t !== 'string' || !msg.t.startsWith('bv_')) return false;
    const node = typeof msg.node === 'string' && msg.node ? msg.node : LOCAL, s = sessions.get(keyOf(node, normIdentity(msg.identity)));
    const fail = (e) => send(ws, { t: 'bv_error', node, identity: normIdentity(msg.identity), text: String(e?.message || e) });
    switch (msg.t) {
      case 'bv_open': open(ws, msg).catch(fail); break;
      case 'bv_close': close(ws, s); break;
      case 'bv_input':
        if (canDrive(s, ws) && Array.isArray(msg.events)) {
          if (node === LOCAL) localMgr().input(s.identity, msg.events);
          else cluster()?.send(node, { t: MSG.SCREEN_INPUT, identity: s.identity, events: msg.events.slice(0, 200) });
        }
        break;
      case 'bv_nav':
        if (canDrive(s, ws)) op(node, { op: 'nav', identity: s.identity, action: String(msg.action || ''), ...(typeof msg.url === 'string' && { url: msg.url }) }).catch(fail);
        break;
      case 'bv_take': // take control from another viewer, or take over from the task
        if (!s?.viewers.has(ws)) break;
        s.controller = ws;
        if (s.state.active || taskFor(s)) {
          s.state.takeover = true;
          op(node, { op: 'takeover', identity: s.identity, on: true }).catch(fail);
        }
        fit(s);
        pushState(s);
        break;
      case 'bv_size':
        if (s?.viewers.has(ws) && sizeViewer(s.viewers.get(ws), msg.size)) fit(s);
        break;
      case 'bv_handback':
        if (!s?.viewers.has(ws) || !s.state.takeover) break;
        s.state.takeover = false;
        s.controller = null;
        op(node, { op: 'takeover', identity: s.identity, on: false }).catch(fail);
        assign(s);
        pushState(s);
        break;
      default: return false;
    }
    return true;
  }
  // A socket closed: it leaves every view.
  function drop(ws) { for (const s of [...sessions.values()]) close(ws, s); }

  // Frames and state from workers (cluster onMessage).
  function onCluster(nodeId, msg) {
    const s = msg.identity != null && sessions.get(keyOf(nodeId, normIdentity(msg.identity)));
    if (!s) return;
    if (msg.t === MSG.SCREEN_FRAME) onFrame(s, { n: msg.n, data: msg.data, w: msg.w, h: msg.h });
    else if (msg.t === MSG.SCREEN_STATE) onState(s, msg);
  }
  // Tasks start and end, machines drop: re-check every open view now and then.
  const tick = setInterval(() => {
    for (const s of [...sessions.values()]) {
      if (s.node !== LOCAL && !nodeOf(s.node)?.connected) { s.closed = true; s.error = 'the machine went offline'; pushState(s); sessions.delete(s.key); continue; }
      const before = JSON.stringify([...s.viewers.keys()].map((ws) => stateFor(s, ws)));
      if (s.node === LOCAL) s.state.active = !!activeRun(s.identity, localMgr().home);
      assign(s);
      if (JSON.stringify([...s.viewers.keys()].map((ws) => stateFor(s, ws))) !== before) pushState(s);
    }
  }, 2000);
  tick.unref?.();

  // Machines that can show a browser, with their profiles (GET /api/browser). mac, load (1-min load per core), default:
  // the machine the Browser tab opens on (the least-loaded online Mac, else the controller), slow: the controller isn't a Mac.
  async function list() {
    const nodes = cluster()?.listNodes() || [{ id: LOCAL, name: 'This server', local: true, connected: true, os: process.platform }];
    const running = tasks();
    const out = await Promise.all(nodes.filter((n) => n.local || n.inventory?.browser).map(async (n) => {
      const mac = (n.local ? n.os || process.platform : n.os) === 'darwin', cores = n.local ? os.cpus().length : n.inventory?.cores;
      const load1 = n.local ? os.loadavg()[0] : n.resources?.load?.[0];
      const base = { id: n.id, name: n.local ? n.name || 'This server' : n.name, local: !!n.local, online: !!n.connected, capable: screenable(n), mac,
        load: Number.isFinite(load1) && cores > 0 ? Math.round((load1 / cores) * 100) / 100 : null, ...(n.local && !mac && { slow: true }) };
      if (!base.capable) return { ...base, profiles: [], note: n.local ? 'no Chromium or Chrome here' : !n.connected ? 'offline' : !n.features?.includes('screen') ? 'update its worker for the live view' : n.inventory?.browser?.error || 'no browser' };
      try {
        const { profiles } = await op(n.id, { op: 'profiles' });
        return { ...base, profiles: profiles.map((p) => ({ ...p, task: running.find((t) => (t.node || LOCAL) === n.id && normIdentity(t.identity) === p.identity) || null })) };
      } catch (e) { return { ...base, profiles: [], note: e.message }; }
    }));
    const pick = defaultNode(out);
    return out.map((n) => (n === pick ? { ...n, default: true } : n));
  }
  async function profile(node, identity) {
    if (typeof identity !== 'string' || !IDENTITY_RE.test(identity)) throw new Error('Unknown browser identity');
    if (typeof node !== 'string' || (node !== LOCAL && !nodeOf(node))) throw new Error('Unknown browser node');
    const { profiles } = await op(node, { op: 'profiles' });
    if (!profiles?.some((p) => p.identity === identity)) throw new Error('Unknown browser identity');
    return { node, identity };
  }
  const isTakenOver = (node, identity) => !!sessions.get(keyOf(node, identity))?.state.takeover
    || (node === LOCAL && takenOver(identity, localMgr().home));
  const sites = async (node, identity) => (await op(node || LOCAL, { op: 'sites', identity: normIdentity(identity) })).sites || [];
  async function clear(node, identity) {
    node ||= LOCAL; identity = normIdentity(identity);
    const s = sessions.get(keyOf(node, identity));
    if (s) { s.closed = true; s.error = 'the profile was cleared'; pushState(s); sessions.delete(s.key); }
    await op(node, { op: 'clear', identity });
    return true;
  }
  async function closeAll() { clearInterval(tick); sessions.clear(); await mgr?.close(); }

  return { handle, drop, onCluster, list, profile, isTakenOver, sites, clear, close: closeAll, sessions };
}
