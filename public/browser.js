'use strict';
// ---------- Browser: profiles per machine and the live view (server: browser-view.mjs, /api/browser*, bv_* on /ws) ----------
// The header's Browser tab (#browserView, bx*) shows the live view in place: a profile picker, the URL bar, Back, Reload
// and Take over / Hand back, then the page on a canvas that fits the width (pinch, double-tap or ctrl+wheel zooms it), the owner's mouse, touch, keys and paste sent
// back. The page is laid out for the canvas's area: its CSS size and devicePixelRatio go with bv_open and, debounced, as
// bv_size after a resize or rotation, so on a phone it fills the tab with a phone layout. Below it a prompt box sends an
// agent to work on that profile (POST /api/browser/task) and an activity panel
// follows its running or last task (GET /api/browser/tasks, refreshed on otask/olane): status, steps, screenshots,
// approvals, the result and Stop. The same viewer code also mounts in #bvModal, opened from a task drawer's live
// thumbnail (bvTaskThumb). The toolbar's Profiles button opens the Browser sheet (#browserModal): each machine that can
// run a browser, its profiles, the signed-in sites (cookie domains only) and Clear. While a task uses the profile the
// owner watches, and can take over (the task's browser actions wait) until they hand back. Loaded after app.js and uses
// its helpers ($, el, api, toast, send, store, md, shotGrid, approvalPanel, kbAware, showTask).
const BV = {
  data: null, err: '', loading: false, lastFocus: null, sites: new Map(), // `${node}/${identity}` → {list, err, open}
  view: null, // the open viewer: {node, identity, name, m} (m: the mount it shows in)
  st: null, frame: { w: 0, h: 0 }, decoding: false, pending: null,
  want: new Map(), // key → {node, identity, view, thumb}: what this tab watches (re-sent after a reconnect)
  thumb: null, // {key, el, canvas, node, identity, task}
};
const bvKey = (node, identity) => `${node}/${identity}`;
const BV_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// A viewer mount: the modal's elements (ids bv*) or the Browser tab's (bx*). Only one shows the view at a time.
const bvMount = (p) => ({ root: $(p === 'bv' ? 'bvModal' : 'browserView'), ...Object.fromEntries(
  ['Canvas', 'Wait', 'Status', 'Take', 'Url', 'Bar', 'Back', 'Reload', 'Paste', 'Kbd', 'Keys'].map((n) => [n.toLowerCase(), $(p + n)])) });
const BVM = { modal: bvMount('bv'), tab: bvMount('bx') };
const bvTabOn = () => $('app').dataset.view === 'browser';
// The machine is the controller and not a Mac: a 1-core VPS streams a browser slowly (browser-view.mjs list).
const bvSlow = (node) => !!(BV.data?.nodes || []).find((n) => n.id === node)?.slow;

// ----- which views this tab wants (one server-side viewer per tab and profile)
function bvSync(node, identity) {
  const k = bvKey(node, identity), w = BV.want.get(k);
  if (!w || (!w.view && !w.thumb)) { BV.want.delete(k); return send({ t: 'bv_close', node, identity }); }
  send({ t: 'bv_open', node, identity, thumb: !w.view, ...(w.url && { url: w.url }), ...bvSizeFor(w) });
  delete w.url;
}
// The area the page's canvas may fill in the mount (its stage, less padding and the canvas's border), CSS px, or null.
function bvArea(m) {
  const st = m.canvas.parentElement, cs = getComputedStyle(st);
  const width = Math.floor(st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2);
  const height = Math.floor(st.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 2);
  return width >= 120 && height >= 120 ? { width, height, dpr: Math.round((devicePixelRatio || 1) * 100) / 100 } : null;
}
const bvSizeFor = (w) => { const z = w.view && BV.view && bvKey(BV.view.node, BV.view.identity) === bvKey(w.node, w.identity) && bvArea(BV.view.m); return z ? { size: z } : {}; };
// On a resize or rotation (150 ms after the last), the page follows the canvas's new area.
let bvSizeTimer = 0;
function bvResized() {
  clearTimeout(bvSizeTimer);
  bvSizeTimer = setTimeout(() => {
    const z = BV.view && bvArea(BV.view.m);
    if (!z || JSON.stringify(z) === BV.sized) return;
    BV.sized = JSON.stringify(z);
    bvSay({ t: 'bv_size', size: z });
  }, 150);
}
addEventListener('resize', bvResized);
addEventListener('orientationchange', bvResized);
if (window.ResizeObserver) { const ro = new ResizeObserver(bvResized); ro.observe($('bvStage')); ro.observe($('bxStage')); }
function bvWant(node, identity, part, on, url) {
  const k = bvKey(node, identity), w = BV.want.get(k) || { node, identity, view: false, thumb: false };
  w[part] = on;
  if (url) w.url = url;
  BV.want.set(k, w);
  bvSync(node, identity);
}
function bvResume() { for (const w of BV.want.values()) send({ t: 'bv_open', node: w.node, identity: w.identity, thumb: !w.view, ...bvSizeFor(w) }); }

// ----- server messages
function bvOnServer(msg) {
  const k = bvKey(msg.node, msg.identity), inView = BV.view && bvKey(BV.view.node, BV.view.identity) === k;
  if (msg.t === 'bv_frame') {
    if (inView) bvDraw(msg);
    if (BV.thumb?.key === k) bvThumbDraw(msg);
  } else if (msg.t === 'bv_state') {
    if (inView) { BV.st = msg; bvRenderState(); }
    if (BV.thumb?.key === k) bvThumbState(msg);
  } else if (msg.t === 'bv_error') {
    if (inView) toast(msg.text, { kind: 'warn' });
  }
}

// ----- the Browser sheet
async function bwLoad() {
  BV.loading = true;
  bwRender();
  try { BV.data = await api('/api/browser'); BV.err = ''; } catch (e) { BV.err = e.message; }
  BV.loading = false;
  bwRender();
  bxRenderPicker();
}
function bwOpen() {
  const m = $('browserModal');
  if (m.hidden) BV.lastFocus = document.activeElement;
  m.hidden = false;
  bwLoad();
  m.querySelector('[data-close].icon-btn').focus();
}
function bwClose() {
  $('browserModal').hidden = true;
  (BV.lastFocus?.isConnected ? BV.lastFocus : $('bxManage')).focus?.();
}
function bwRender() {
  const body = $('bwBody');
  if ($('browserModal').hidden) return;
  body.textContent = '';
  if (!BV.data) { body.append(el('div', 'cn-empty', BV.err || 'Loading…')); return; }
  if (BV.err) body.append(el('div', 'cn-err', BV.err));
  const nodes = BV.data.nodes || [];
  if (!nodes.length) body.append(el('div', 'cn-empty', 'No machine here can run a browser yet.'));
  for (const n of nodes) body.append(bwNode(n));
}
function bwNode(n) {
  const sec = el('section', 'bw-node');
  const head = el('div', 'bw-nhead');
  const dot = el('span', `dot ${n.online ? 'on' : 'off'}`);
  head.append(dot, el('h3', '', n.local ? `${n.name} (this server)` : n.name));
  if (n.note) head.append(el('span', 'bw-note', n.note));
  sec.append(head);
  if (!n.capable) return sec;
  const list = el('div', 'cn-list bw-list');
  for (const p of n.profiles) list.append(bwProfile(n, p));
  sec.append(list);
  // A new profile: a name, then Open (Chromium creates it on first use).
  const add = el('form', 'bw-add');
  const inp = el('input');
  Object.assign(inp, { placeholder: 'New profile, e.g. canva', maxLength: 64, autocapitalize: 'off', spellcheck: false });
  inp.setAttribute('aria-label', `New browser profile on ${n.name}`);
  const go = el('button', 'btn small', 'Create and open');
  go.type = 'submit';
  add.append(inp, go);
  add.onsubmit = (e) => {
    e.preventDefault();
    const id = inp.value.trim().toLowerCase();
    if (!BV_ID_RE.test(id)) { toast('Use lowercase letters, digits, - and _ (it is a folder name).', { kind: 'warn' }); return inp.focus(); }
    bwPick(n, id);
  };
  sec.append(add);
  return sec;
}
function bwProfile(n, p) {
  const k = bvKey(n.id, p.identity), row = el('div', 'cn-row bw-row');
  const main = el('div', 'cn-main');
  const info = el('div', 'cn-info');
  info.append(el('span', 'cn-label', p.identity));
  const st = el('span', 'cn-status');
  st.append(el('span', `dot ${p.task ? 'wait' : p.running ? 'on' : ''}`),
    el('span', 'cn-st', p.task ? `Task #${p.task.id} is using it${p.takeover ? ' · taken over' : ''}` : p.open ? 'Open' : p.running ? 'Running' : 'Idle'));
  info.append(st);
  const open = el('button', 'btn small primary cn-btn', p.task ? 'Watch' : 'Open');
  open.onclick = () => bwPick(n, p.identity);
  const sites = el('button', 'btn small cn-btn', 'Signed-in sites');
  sites.setAttribute('aria-expanded', String(!!BV.sites.get(k)?.open));
  sites.onclick = () => bwSites(n.id, p.identity);
  const clear = el('button', 'btn small danger cn-btn', 'Clear…');
  clear.disabled = !!p.task;
  clear.title = p.task ? 'A task is using this profile' : 'Sign this profile out of every site: its cookies, history and storage are deleted';
  clear.onclick = () => bwClear(n, p.identity);
  main.append(info, open, sites, clear);
  row.append(main);
  const s = BV.sites.get(k);
  if (s?.open) {
    const panel = el('div', 'cn-panel bw-sites');
    if (s.err) panel.append(el('p', 'cn-err', s.err));
    else if (!s.list) panel.append(el('span', 'cn-step muted', 'Reading cookies…'));
    else if (!s.list.length) panel.append(el('span', 'cn-step muted', 'Not signed in anywhere yet.'));
    else {
      const ul = el('ul', 'bw-domains');
      for (const d of s.list) { const li = el('li', '', d.domain); li.append(el('span', 'muted', ` · ${d.count}`)); ul.append(li); }
      panel.append(ul, el('span', 'cn-step muted', 'Sites with cookies in this profile (never their values).'));
    }
    row.append(panel);
  }
  return row;
}
async function bwSites(node, identity) {
  const k = bvKey(node, identity), cur = BV.sites.get(k);
  if (cur?.open) { cur.open = false; return bwRender(); }
  BV.sites.set(k, { open: true, list: null, err: '' });
  bwRender();
  try {
    const r = await api(`/api/browser/sites?node=${encodeURIComponent(node)}&identity=${encodeURIComponent(identity)}`);
    BV.sites.set(k, { open: true, list: r.sites, err: '' });
  } catch (e) { BV.sites.set(k, { open: true, list: null, err: e.message }); }
  bwRender();
}
async function bwClear(n, identity) {
  if (!confirm(`Clear the "${identity}" profile on ${n.name}? It is signed out of every site, and its history and saved data are deleted.`)) return;
  try {
    await api('/api/browser/clear', 'POST', { node: n.id, identity });
    BV.sites.delete(bvKey(n.id, identity));
    toast(`Cleared the ${identity} profile`);
  } catch (e) { toast(e.message, { kind: 'warn' }); }
  bwLoad();
}
// Open (or Create and open) shows the profile in the Browser tab.
function bwPick(n, identity) {
  bwClose();
  if (!bvTabOn()) setView('browser');
  bxSelect(n.id, identity, n.name);
}
$('bxManage').addEventListener('click', bwOpen);
$('browserModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) bwClose(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('browserModal').hidden && $('bvModal').hidden) { e.stopImmediatePropagation(); bwClose(); }
}, true);

// ----- the live view, in the modal or the Browser tab
function bvOpen(node, identity, name, { take = false, inline = false } = {}) {
  if (BV.view) bvClose({ keepFocus: true, next: true });
  const m = inline ? BVM.tab : BVM.modal;
  if (!inline) BV.lastViewFocus = document.activeElement;
  BV.view = { node, identity, name: name || node, m };
  BV.st = null;
  BV.frame = { w: 0, h: 0 };
  BV.take = take;
  BV.reconnecting = false;
  m.wait.classList.remove('over');
  bvZoomClear(m);
  if (!inline) $('bvTitle').textContent = identity;
  m.url.value = '';
  m.wait.hidden = false;
  m.wait.textContent = 'Starting the browser…';
  m.canvas.width = 0; m.canvas.height = 0;
  m.root.hidden = false;
  bvRenderState();
  BV.sized = JSON.stringify(bvArea(m));
  bvWant(node, identity, 'view', true);
  if (!inline) m.canvas.focus({ preventScroll: true });
}
// next: another view opens right away (the Browser tab doesn't come back under it).
function bvClose({ keepFocus = false, next = false } = {}) {
  if (!BV.view) return;
  const { node, identity, m } = BV.view;
  BV.view = null;
  BV.st = null;
  bvZoomClear(m);
  m.keys.blur();
  bvWant(node, identity, 'view', false);
  if (m === BVM.tab) { m.wait.hidden = false; m.wait.textContent = ''; m.status.textContent = ''; bxRenderBusy(); return; }
  m.root.hidden = true;
  if (!$('browserModal').hidden) bwLoad();
  if (!keepFocus) (BV.lastViewFocus?.isConnected ? BV.lastViewFocus : $('browserTab')).focus?.();
  if (!next && bvTabOn()) bxOpenSel(); // the tab's view was lent to the modal
}
const bvCanDrive = () => BV.st?.role === 'control' && !BV.st.closed;
function bvRenderState() {
  const s = BV.st, v = BV.view;
  if (!v) return;
  const { m } = v, take = m.take;
  let text = `${v.name}${bvSlow(v.node) ? ' (Running on the VPS (slow))' : ''}${s?.agentTab && !s.closed ? ' · Agent tab' : ''}`;
  take.hidden = true;
  take.classList.remove('primary');
  if (!s) text += ' · connecting…';
  else if (s.closed) text += ` · ${s.error || 'closed'}`;
  else if (s.active && s.takeover && s.role === 'control') {
    text += ` · You have taken over${s.task ? ` from task #${s.task.id}` : ''}: it waits until you hand back`;
    Object.assign(take, { hidden: false, textContent: 'Hand back' });
    take.classList.add('primary');
  } else if (s.active) {
    text += s.takeover ? ' · Taken over in another window' : ` · Watching${s.task ? ` task #${s.task.id}: ${s.task.title}` : ' a task'}`;
    Object.assign(take, { hidden: false, textContent: 'Take over' });
  } else if (s.role === 'control') text += ' · You are in control';
  else {
    text += ' · Watching (another window has control)';
    Object.assign(take, { hidden: false, textContent: 'Take control' });
  }
  m.status.textContent = text;
  m.root.classList.toggle('watching', !bvCanDrive());
  for (const x of [m.back, m.reload, m.paste, m.kbd, m.url]) x.disabled = !bvCanDrive();
  if (s && !s.closed && document.activeElement !== m.url) m.url.value = s.url === 'about:blank' ? '' : s.url || '';
  // Never a silent black canvas: the reason it closed, or 'Reconnecting…' over the last frame while the browser restarts.
  m.wait.classList.toggle('over', !!(s?.reconnecting || s?.closed) && !!m.canvas.width);
  if (s?.closed) { m.wait.hidden = false; m.wait.textContent = s.error || 'The browser closed.'; }
  else if (s?.reconnecting) { m.wait.hidden = false; m.wait.textContent = 'Reconnecting…'; BV.reconnecting = true; }
  else if (BV.reconnecting) { BV.reconnecting = false; m.wait.textContent = 'Reconnected: waiting for the page…'; }
  if (s && BV.take && s.active && !s.takeover && !s.closed) { BV.take = false; bvSay({ t: 'bv_take' }); }
  if (m === BVM.tab) bxRenderBusy();
}
const bvSay = (m) => BV.view && send({ node: BV.view.node, identity: BV.view.identity, ...m });

// Frames: only the newest is decoded; one in flight at a time.
function bvDraw(f) {
  BV.pending = f;
  if (BV.decoding) return;
  BV.decoding = true;
  const img = new Image();
  img.onload = img.onerror = () => {
    const m = BV.view?.m, c = m?.canvas;
    if (img.naturalWidth && c) {
      if (c.width !== img.naturalWidth || c.height !== img.naturalHeight) { c.width = img.naturalWidth; c.height = img.naturalHeight; }
      c.getContext('2d').drawImage(img, 0, 0);
      BV.frame = { w: f.w, h: f.h };
      if (!BV.st?.reconnecting && !BV.st?.closed) { m.wait.hidden = true; m.wait.classList.remove('over'); }
    }
    BV.decoding = false;
    if (BV.pending !== f && BV.pending) bvDraw(BV.pending);
    else BV.pending = null;
  };
  img.src = `data:image/jpeg;base64,${f.data}`;
}

// ----- zoom: each mount keeps m.z = {s, ox, oy} (s 1 = fit-width; ox/oy in CSS px), shown as a transform on the canvas
// inside its stage (which clips while zoomed). Two fingers pinch (1–4×) and pan, a double-tap toggles fit / 2.5×, ctrl or
// ⌘ + wheel zooms. The pan is clamped so the page always covers its fit box.
const BV_ZMAX = 4;
// The canvas's fit box (its untransformed layout box) in client px; the transform's origin is its top left.
function bvFit(m) {
  const r = m.canvas.getBoundingClientRect(), z = m.z;
  return { left: r.left - z.ox, top: r.top - z.oy, width: r.width / z.s, height: r.height / z.s };
}
function bvZoomShow(m) {
  const { s, ox, oy } = m.z, on = s > 1;
  m.canvas.style.transform = on ? `translate(${ox}px, ${oy}px) scale(${s})` : '';
  m.canvas.parentElement.classList.toggle('zoomed', on);
  m.zoom.hidden = !on;
}
function bvZoomSet(m, s, ox, oy) {
  const f = bvFit(m);
  s = Math.min(BV_ZMAX, s < 1.02 ? 1 : s);
  m.z = { s, ox: Math.min(0, Math.max(f.width * (1 - s), ox)), oy: Math.min(0, Math.max(f.height * (1 - s), oy)) };
  bvZoomShow(m);
}
// Zoom to s so the page point under client (x0, y0) at zoom z0 lands at client (x, y).
function bvZoomAt(m, s, x, y, z0 = m.z, x0 = x, y0 = y) {
  const f = bvFit(m), px = (x0 - f.left - z0.ox) / z0.s, py = (y0 - f.top - z0.oy) / z0.s;
  s = Math.min(BV_ZMAX, Math.max(1, s));
  bvZoomSet(m, s, x - f.left - px * s, y - f.top - py * s);
}
function bvZoomReset(m) { m.z = { s: 1, ox: 0, oy: 0 }; m.pinch = null; m.tap = null; bvZoomShow(m); }
const bvZoomClear = (m) => { m.pts.clear(); m.gest = false; bvZoomReset(m); }; // the view closes or shows another profile
// A double-tap: back to fit-width, or 2.5× with the tapped point in the middle.
function bvZoomToggle(m, x, y) {
  if (m.z.s > 1) return bvZoomReset(m);
  const f = bvFit(m);
  bvZoomAt(m, 2.5, f.left + f.width / 2, f.top + f.height / 2, m.z, x, y);
}

// ----- input: canvas pixels → page CSS px (the frame's w×h), through the zoom
function bvPoint(e) {
  const m = BV.view?.m;
  if (!m || !BV.frame.w) return null;
  const f = bvFit(m), { s, ox, oy } = m.z;
  if (!f.width) return null;
  return { x: Math.round(((e.clientX - f.left - ox) / s / f.width) * BV.frame.w), y: Math.round(((e.clientY - f.top - oy) / s / f.height) * BV.frame.h) };
}
const bvMods = (e) => ({ ...(e.altKey && { alt: true }), ...(e.ctrlKey && { ctrl: true }), ...(e.metaKey && { meta: true }), ...(e.shiftKey && { shift: true }) });
const bvInput = (events) => { if (bvCanDrive() && events.length) bvSay({ t: 'bv_input', events }); };
const BV_BTN = ['left', 'middle', 'right'];
let bvTouch = null, bvMoveAt = 0;
async function bvPaste() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { text = prompt('Paste the text to type into the page') || ''; }
  if (text) bvInput([{ type: 'text', text }]);
}
// The same handlers on both mounts; each acts only while its mount shows the view.
function bvWire(m) {
  const on = () => BV.view?.m === m, cv = m.canvas, keys = m.keys;
  // The zoom, the touch pointers down on the canvas (id → {x, y}) and the '1×' chip that resets to fit-width.
  m.pts = new Map();
  m.zoom = el('button', 'bv-zoom', '1×');
  Object.assign(m.zoom, { type: 'button', title: 'Fit the page to the width', hidden: true });
  m.zoom.setAttribute('aria-label', 'Reset zoom');
  m.zoom.addEventListener('click', () => { bvZoomReset(m); cv.focus({ preventScroll: true }); });
  cv.parentElement.append(m.zoom);
  bvZoomReset(m);
  const two = () => {
    const [a, b] = [...m.pts.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const lift = (id) => {
    m.pts.delete(id);
    if (m.pts.size < 2) m.pinch = null;
    if (!m.pts.size) m.gest = false;
  };
  cv.addEventListener('pointerdown', (e) => {
    const p = on() && bvPoint(e);
    if (!p) return;
    cv.focus({ preventScroll: true });
    if (e.pointerType === 'mouse') { e.preventDefault(); cv.setPointerCapture(e.pointerId); bvInput([{ type: 'mouse', action: 'down', button: BV_BTN[e.button] || 'left', clickCount: e.detail || 1, ...p, ...bvMods(e) }]); return; }
    m.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (m.pts.size === 2) { // a second finger: pinch and pan; nothing goes to the page until every finger lifts
      const g = two();
      bvTouch = null;
      m.gest = true;
      m.pinch = { z0: { ...m.z }, d0: g.d, x0: g.x, y0: g.y };
    } else if (m.pts.size === 1) bvTouch = { id: e.pointerId, x: e.clientX, y: e.clientY, at: Date.now(), lastY: e.clientY, lastX: e.clientX, p, moved: false };
  });
  cv.addEventListener('pointermove', (e) => {
    const p = on() && bvPoint(e);
    if (!p) return;
    if (e.pointerType === 'mouse') {
      const now = Date.now();
      if (now - bvMoveAt < 50 && !e.buttons) return;
      bvMoveAt = now;
      return bvInput([{ type: 'mouse', action: 'move', buttons: e.buttons, button: e.buttons & 2 ? 'right' : 'left', ...p }]);
    }
    const q = m.pts.get(e.pointerId);
    if (q) { q.x = e.clientX; q.y = e.clientY; }
    if (m.gest) {
      const z = m.pinch;
      if (z && q && m.pts.size >= 2) { const g = two(); bvZoomAt(m, (z.z0.s * g.d) / z.d0, g.x, g.y, z.z0, z.x0, z.y0); }
      return;
    }
    // Touch: a one-finger drag scrolls the page.
    const t = bvTouch;
    if (!t || t.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8) t.moved = true;
    if (!t.moved) return;
    const r = cv.getBoundingClientRect(), k = BV.frame.w / (r.width || 1);
    bvInput([{ type: 'mouse', action: 'wheel', ...t.p, dx: Math.round((t.lastX - e.clientX) * k), dy: Math.round((t.lastY - e.clientY) * k) }]);
    t.lastX = e.clientX; t.lastY = e.clientY;
  });
  cv.addEventListener('pointerup', (e) => {
    const p = on() && bvPoint(e);
    if (e.pointerType === 'mouse') { if (p) bvInput([{ type: 'mouse', action: 'up', button: BV_BTN[e.button] || 'left', clickCount: e.detail || 1, ...p, ...bvMods(e) }]); return; }
    const t = bvTouch, gest = m.gest;
    bvTouch = null;
    lift(e.pointerId);
    if (gest || !t || t.id !== e.pointerId || t.moved || !p) return;
    // A tap is a click; a second tap within 300 ms and 30px toggles the zoom instead.
    const last = m.tap;
    m.tap = null;
    if (last && Date.now() - last.at < 300 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) return bvZoomToggle(m, e.clientX, e.clientY);
    m.tap = { at: Date.now(), x: e.clientX, y: e.clientY };
    bvInput([{ type: 'click', ...p }]);
  });
  cv.addEventListener('pointercancel', (e) => { bvTouch = null; lift(e.pointerId); });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('wheel', (e) => {
    const p = on() && bvPoint(e);
    if (!p) return;
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); return bvZoomAt(m, m.z.s * Math.exp(-e.deltaY * k * 0.01), e.clientX, e.clientY); } // a trackpad pinch
    if (!bvCanDrive()) return;
    e.preventDefault();
    bvInput([{ type: 'mouse', action: 'wheel', ...p, dx: Math.round(e.deltaX * k), dy: Math.round(e.deltaY * k) }]);
  }, { passive: false });
  // Keys while the canvas has focus go to the page (Escape too; the close button or a click outside closes).
  cv.addEventListener('keydown', (e) => {
    if (!on() || !bvCanDrive()) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); return bvPaste(); }
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    bvInput([{ type: 'key', key: e.key, code: e.code, ...bvMods(e) }]);
  });
  // The on-screen keyboard (iPhone): a hidden field takes what is typed and forwards it; it always stays empty.
  keys.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText' || e.inputType === 'insertFromPaste') { if (e.data) bvInput([{ type: 'text', text: e.data }]); }
    else if (e.inputType === 'deleteContentBackward') bvInput([{ type: 'key', key: 'Backspace', code: 'Backspace' }]);
    else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') bvInput([{ type: 'key', key: 'Enter', code: 'Enter' }]);
  });
  keys.addEventListener('input', () => { keys.value = ''; });
  keys.addEventListener('keydown', (e) => {
    if (['Enter', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key) && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      bvInput([{ type: 'key', key: e.key, code: e.code, ...bvMods(e) }]);
    }
  });
  m.kbd.addEventListener('click', () => { keys.value = ''; keys.focus(); });
  m.paste.addEventListener('click', bvPaste);
  m.back.addEventListener('click', () => on() && bvCanDrive() && bvSay({ t: 'bv_nav', action: 'back' }));
  m.reload.addEventListener('click', () => on() && bvCanDrive() && bvSay({ t: 'bv_nav', action: 'reload' }));
  m.bar.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = m.url.value.trim();
    if (!url || !on() || !bvCanDrive()) return;
    bvSay({ t: 'bv_nav', action: 'go', url });
    cv.focus({ preventScroll: true });
  });
  m.take.addEventListener('click', () => {
    const s = BV.st;
    if (!s || !on()) return;
    bvSay({ t: s.takeover && s.role === 'control' ? 'bv_handback' : 'bv_take' });
  });
}
bvWire(BVM.modal);
bvWire(BVM.tab);
$('bvModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) bvClose(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('bvModal').hidden || e.target === BVM.modal.canvas || e.target === BVM.modal.keys) return;
  e.stopImmediatePropagation();
  bvClose();
}, true);

// ----- the Browser tab: its profile, the prompt box and the agent's activity
const BX = { sel: null, tasks: [], err: '', pin: null, ap: new Map(), sending: false, timer: 0, more: false, rules: null }; // ap: task id → held approvals; more: every earlier prompt shows; rules: Settings → Browser → Don't allow
const bxProfiles = () => (BV.data?.nodes || []).filter((n) => n.capable).flatMap((n) => n.profiles.map((p) => ({ n, p })));
function bxShow() {
  bwLoad(); // fresh profiles; bxRenderPicker opens the chosen one once they are in
  bxOpenSel();
  bxLoadRules();
}
async function bxLoadRules() {
  try { BX.rules = (await api('/api/orch/gate')).rules || []; } catch { return; }
  bxRenderActivity();
}
// The activity panel's line about the owner's "Don't allow" rules: what the agent asks before (everything else it just does).
const bxRulesLine = (rules) => (rules.length ? `Asks before: ${rules.join(', ')}` : "Asks before: nothing (add rules in Settings → Browser → Don't allow)");
function bxHide() { if (BV.view?.m === BVM.tab) bvClose({ keepFocus: true }); }
// The profile to show: the one the owner picked last (while its machine is online), else one a task is using, else the
// default machine's (the least-loaded online Mac; the controller only while no Mac is online).
function bxOpenSel() {
  if (!bvTabOn() || !$('bvModal').hidden) return;
  if (!BX.sel) {
    const all = bxProfiles(), saved = store.get('cw.bxPick');
    const def = all.filter(({ n }) => n.default);
    const hit = all.find(({ n, p }) => bvKey(n.id, p.identity) === saved) || all.find(({ p }) => p.task)
      || def.find(({ p }) => p.identity === 'default') || def[0] || all[0];
    if (!hit) {
      const w = BVM.tab.wait;
      w.hidden = false;
      w.textContent = BV.err || (BV.data ? 'No machine here can run a browser yet.' : 'Loading profiles…');
      return bxRenderActivity();
    }
    return bxSelect(hit.n.id, hit.p.identity, hit.n.name, false);
  }
  const { node, identity, name } = BX.sel;
  if (BV.view?.m === BVM.tab && bvKey(BV.view.node, BV.view.identity) === bvKey(node, identity)) return;
  bvOpen(node, identity, name, { inline: true });
}
// picked: the owner chose it (remembered), rather than the default.
function bxSelect(node, identity, name, picked = true) {
  const same = BX.sel && bvKey(BX.sel.node, BX.sel.identity) === bvKey(node, identity);
  BX.sel = { node, identity, name: name || node };
  if (picked) store.set('cw.bxPick', bvKey(node, identity));
  if (!same) { BX.tasks = []; BX.pin = null; BX.err = ''; BX.more = false; }
  bxRenderActivity(); // first, so the view opens with the stage's final size
  bxRenderPicker();
  bxOpenSel();
  bxLoadTasks();
}
function bxRenderPicker() {
  const sel = $('bxProfile'), nodes = (BV.data?.nodes || []).filter((n) => n.capable), many = nodes.length > 1;
  sel.textContent = '';
  for (const n of nodes) {
    const box = many ? el('optgroup') : sel;
    if (many) { box.label = n.name; sel.append(box); }
    const ids = n.profiles.map((p) => p.identity);
    if (BX.sel?.node === n.id && !ids.includes(BX.sel.identity)) ids.push(BX.sel.identity); // just created
    for (const id of ids) {
      const p = n.profiles.find((x) => x.identity === id);
      const o = el('option', '', `${id}${p?.task ? ' · task running' : ''}`);
      o.value = bvKey(n.id, id);
      box.append(o);
    }
  }
  if (!sel.options.length) sel.append(el('option', '', BV.data ? 'No profiles' : 'Loading…'));
  sel.disabled = !nodes.length;
  if (BX.sel) sel.value = bvKey(BX.sel.node, BX.sel.identity);
  if (bvTabOn()) bxOpenSel();
  bxSyncSend();
}
$('bxProfile').addEventListener('change', (e) => {
  const hit = bxProfiles().find(({ n, p }) => bvKey(n.id, p.identity) === e.target.value);
  if (hit) bxSelect(hit.n.id, hit.p.identity, hit.n.name);
});

async function bxLoadTasks() {
  const s = BX.sel;
  if (!s) return;
  const k = bvKey(s.node, s.identity), q = `identity=${encodeURIComponent(s.identity)}&node=${encodeURIComponent(s.node)}`;
  try {
    const r = await api(`/api/browser/tasks?${q}`);
    if (!BX.sel || bvKey(BX.sel.node, BX.sel.identity) !== k) return;
    BX.tasks = Array.isArray(r) ? r : r.tasks || [];
    BX.err = '';
    const t = bxShown();
    if (t && t.status === 'running' && !O.tasks.get(t.id)) {
      const a = await api('/api/orch/approvals').catch(() => null);
      if (a) BX.ap.set(t.id, (a.approvals || []).filter((x) => x.task === t.id));
    }
  } catch (e) { BX.err = e.message; }
  bxRenderActivity();
}
const bxSoon = () => { clearTimeout(BX.timer); BX.timer = setTimeout(bxLoadTasks, 500); };
// Live updates: a status change (otask) or a new tool call (olane) of a task on this profile reloads the list.
function bxOnOrch(msg) {
  if (!BX.sel || !bvTabOn()) return;
  const id = msg.t === 'otask' ? msg.task.id : msg.t === 'olane' ? msg.taskId : null;
  if (id == null) return;
  const mine = BX.tasks.some((t) => t.id === id) || (msg.t === 'otask' && msg.task.browser === BX.sel.identity && (msg.task.node || msg.task.run_on || 'controller') === BX.sel.node);
  if (mine) bxSoon();
}
// The task the panel follows: the pinned one (just sent, or tapped in Earlier prompts), else the latest: a running one,
// else a queued one, else the newest.
function bxLatest() {
  const ts = BX.tasks;
  return ts.find((t) => t.status === 'running') || ts.find((t) => t.status === 'queued') || ts.reduce((a, t) => (!a || t.id > a.id ? t : a), null);
}
const bxShown = () => BX.tasks.find((t) => t.id === BX.pin) || bxLatest();
const bxLive = (t) => t && ['running', 'queued'].includes(t.status);
function bxRenderBusy() {
  const s = BV.st, t = bxShown(), m = BVM.tab;
  const busy = BV.view?.m === m && !s?.closed && !s?.takeover && (!!(s?.active && s.task) || t?.status === 'running');
  m.root.classList.toggle('agent-busy', busy);
  $('bxBusy').hidden = !busy;
}
const BX_STATUS = { queued: 'Waiting to start', running: 'Working…', done: 'Done', failed: 'Could not finish', cancelled: 'Stopped' };
const BX_VERB = { nav: 'Opened', click: 'Clicked', type: 'Typed in', read: 'Read', shot: 'Took a screenshot of', approval: 'Asked you:' };
const bxStep = (s) => `${BX_VERB[s.kind] || ''} ${s.label || ''}`.trim() || s.kind;
function bxRenderActivity() {
  const box = $('bxActivity');
  box.textContent = '';
  bxRenderBusy();
  if (BX.err) box.append(el('div', 'cn-err', BX.err));
  if (BX.rules) {
    const r = el('div', 'bx-rules muted', bxRulesLine(BX.rules));
    r.id = 'bxRules';
    box.append(r);
  }
  const t = bxShown();
  if (!t) {
    if (BX.sel) box.append(el('div', 'bx-empty muted', `No agent has worked on ${BX.sel.identity} yet. Say what to do above: it opens sites, clicks and types here, and asks you first only for what Settings → Browser doesn't allow.`));
    return;
  }
  const head = el('div', 'bx-head');
  const st = bxDot(t);
  st.append(el('span', '', BX_STATUS[t.status] || t.status));
  const title = el('button', 'link-btn bx-title', `#${t.id} ${t.title || ''}`);
  title.type = 'button';
  title.title = 'Open the task';
  title.onclick = () => showTask(t.id);
  head.append(st, title);
  if (t !== bxLatest()) {
    const back = el('button', 'link-btn bx-back', 'Back to latest');
    back.type = 'button';
    back.onclick = () => { BX.pin = null; bxRenderActivity(); };
    head.append(back);
  }
  if (bxLive(t)) {
    const stop = el('button', 'btn small danger', 'Stop');
    stop.type = 'button';
    stop.id = 'bxStop';
    stop.onclick = async () => {
      stop.disabled = true;
      try { await api(`/api/browser/task/${t.id}/stop`, 'POST'); toast(`Stopped #${t.id}`); } catch (e) { toast(e.message, { kind: 'error' }); }
      bxLoadTasks();
    };
    head.append(stop);
  }
  box.append(head);
  const aps = t.status === 'running' ? O.tasks.get(t.id)?.approvals || BX.ap.get(t.id) || [] : [];
  for (const a of aps) box.append(approvalPanel(a));
  const steps = t.steps || [];
  if (steps.length) {
    const ol = el('ol', 'bx-steps');
    for (const s of steps) {
      const li = el('li', `bx-step ${s.kind}`, bxStep(s));
      ol.append(li);
    }
    box.append(ol);
    ol.scrollTop = ol.scrollHeight;
  } else if (bxLive(t)) box.append(el('div', 'bx-empty muted', t.status === 'queued' ? 'Starting soon…' : 'Getting started…'));
  const shots = steps.filter((s) => s.mediaId).map((s) => ({ id: s.mediaId, name: bxStep(s) }));
  if (shots.length) box.append(shotGrid(shots));
  const mcp = bxMcpLine(t.mcp);
  if (mcp) box.append(el('div', 'bx-mcp muted', mcp));
  if (t.resultText) {
    const r = el('div', 'bx-result');
    r.innerHTML = md(t.resultText);
    box.append(r);
  }
  bxRenderEarlier(box, t);
}
// Details: how long the browser tool took to start on the latest run (and how many tries it needed), or that it didn't.
function bxMcpLine(m) {
  if (!m) return '';
  const dur = (ms) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : fmtDur(ms / 1000));
  const tries = m.attempt > 1 ? ` (try ${m.attempt} of 3)` : '';
  if (!m.ok) return `Browser tool didn't start${tries}${m.attempt < 3 ? ', retrying' : ''}`;
  return `Browser tool started in ${dur(m.ms)}${m.warmMs != null ? ` (browser ready in ${dur(m.warmMs)})` : ''}${tries}`;
}
// A status dot in a .bx-st span (the head adds the status's words).
function bxDot(t) {
  const st = el('span', `bx-st ${t.status}`);
  st.append(el('span', `dot ${t.status === 'running' ? 'wait' : t.status === 'done' ? 'on' : t.status === 'failed' ? 'warn' : ''}`));
  st.title = BX_STATUS[t.status] || t.status;
  return st;
}
// Earlier prompts: the profile's other tasks, newest first (8, then Show more). A row shows that task above;
// Ask again puts its prompt back in the box, unsent.
function bxRenderEarlier(box, shown) {
  const rest = BX.tasks.filter((t) => t !== shown).sort((a, b) => b.id - a.id);
  if (!rest.length) return;
  const sec = el('section', 'bx-earlier');
  sec.append(el('h3', '', 'Earlier prompts'));
  const ul = el('ul');
  for (const t of BX.more ? rest : rest.slice(0, 8)) {
    const li = el('li', 'bx-erow');
    const row = el('button', 'bx-ebtn');
    row.type = 'button';
    row.title = t.title || '';
    const ts = t.finishedAt ?? t.finished_at ?? t.startedAt ?? t.created_at ?? t.createdAt; // seconds
    row.append(bxDot(t), el('span', 'bx-eid', `#${t.id}`), el('span', 'bx-etitle', t.title || ''));
    if (ts) row.append(el('span', 'bx-etime muted', relTime(ts < 1e12 ? ts * 1000 : ts)));
    row.onclick = () => { BX.pin = t.id; bxRenderActivity(); };
    const again = el('button', 'link-btn bx-again', 'Ask again');
    again.type = 'button';
    again.title = 'Put this prompt back in the box';
    again.onclick = () => {
      bxIn.value = t.prompt || t.title || '';
      bxIn.dispatchEvent(new Event('input')); // grows the box and runs bxSyncSend()
      bxIn.focus();
    };
    li.append(row, again);
    ul.append(li);
  }
  sec.append(ul);
  if (!BX.more && rest.length > 8) {
    const more = el('button', 'link-btn bx-more', 'Show more');
    more.type = 'button';
    more.onclick = () => { BX.more = true; bxRenderActivity(); };
    sec.append(more);
  }
  box.append(sec);
}

// The prompt box: Enter sends on a desktop (Shift+Enter is a new line); a phone's return key is a new line.
const bxIn = $('bxInput');
// Which browser the next prompt drives (/api/browser runner, chrome.mjs): the owner's Chrome on a Mac, or the built-in one.
function bxRunnerText(runner, sel, many, slow) {
  if (runner?.mode === 'chrome') return runner.label;
  const where = sel ? ` · ${sel.identity}${many ? ` on ${sel.name}` : ''}${slow ? ' · Running on the VPS (slow)' : ''}` : '';
  return `Built-in browser${/^No Chrome/.test(runner?.note || '') ? ' (no Chrome runner online)' : ''}${where}`;
}
function bxSyncSend() {
  $('bxSend').disabled = BX.sending || !BX.sel || !bxIn.value.trim();
  const r = BV.data?.runner, hint = $('bxHint');
  hint.textContent = BX.sel ? bxRunnerText(r, BX.sel, (BV.data?.nodes || []).length > 1, bvSlow(BX.sel.node)) : '';
  hint.title = r?.mode === 'builtin' && r.note ? r.note : '';
}
bxIn.addEventListener('input', () => {
  bxIn.style.height = 'auto';
  bxIn.style.height = Math.min(bxIn.scrollHeight, innerHeight * 0.3) + 'px';
  bxSyncSend();
});
bxIn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); $('bxPrompt').requestSubmit(); }
});
kbAware(bxIn);
$('bxPrompt').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = bxIn.value.trim(), s = BX.sel;
  if (!prompt || !s || BX.sending) return;
  BX.sending = true;
  bxSyncSend();
  try {
    const r = await api('/api/browser/task', 'POST', { prompt, identity: s.identity, node: s.node });
    bxIn.value = '';
    bxIn.style.height = '';
    if (r.taskId) {
      BX.pin = r.taskId;
      if (!BX.tasks.some((t) => t.id === r.taskId)) BX.tasks.unshift({ id: r.taskId, title: prompt.slice(0, 60), status: 'queued', steps: [] });
    }
    bxRenderActivity();
    bxLoadTasks();
  } catch (err) { toast(err.message, { kind: 'error' }); }
  finally { BX.sending = false; bxSyncSend(); }
});

// ----- the task drawer's live thumbnail
function bvTaskThumb(t) {
  if (t.status !== 'running' || !t.browser) { bvThumbDrop(); return null; }
  const node = t.node || 'controller', k = bvKey(node, t.browser);
  if (BV.thumb?.key !== k || BV.thumb.task !== t.id) {
    bvThumbDrop();
    const box = el('div', 'dr-sec bv-thumb');
    box.append(el('h3', '', 'Browser'));
    const btn = el('button', 'bv-tcanvas');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Watch the ${t.browser} browser`);
    const cv = el('canvas');
    const wait = el('span', 'bv-twait', 'Waiting for the page…');
    btn.append(cv, wait);
    const line = el('div', 'bv-tline muted', `Profile ${t.browser}${t.node_name ? ` on ${t.node_name}` : ''}`);
    const acts = el('div', 'dr-actions');
    const watch = el('button', 'btn small', 'Watch');
    const take = el('button', 'btn small', 'Take over');
    take.title = 'Drive the browser yourself; the task\'s browser actions wait until you hand back';
    const name = t.node_name || (node === 'controller' ? 'This server' : node);
    btn.onclick = watch.onclick = () => bvOpen(node, t.browser, name);
    take.onclick = () => bvOpen(node, t.browser, name, { take: true });
    acts.append(watch, take);
    box.append(btn, line, acts);
    BV.thumb = { key: k, el: box, canvas: cv, wait, line, node, identity: t.browser, task: t.id, profile: `Profile ${t.browser}${t.node_name ? ` on ${t.node_name}` : ''}` };
    bvWant(node, t.browser, 'thumb', true);
  }
  return BV.thumb.el;
}
function bvThumbDrop() {
  const th = BV.thumb;
  if (!th) return;
  BV.thumb = null;
  bvWant(th.node, th.identity, 'thumb', false);
}
function bvThumbDraw(f) {
  const th = BV.thumb, img = new Image();
  img.onload = () => {
    if (BV.thumb !== th) return;
    const c = th.canvas;
    if (c.width !== img.naturalWidth) { c.width = img.naturalWidth; c.height = img.naturalHeight; }
    c.getContext('2d').drawImage(img, 0, 0);
    th.wait.hidden = true;
  };
  img.src = `data:image/jpeg;base64,${f.data}`;
}
function bvThumbState(s) {
  const th = BV.thumb;
  th.line.textContent = s.closed ? `${th.profile} · ${s.error || 'closed'}` : `${th.profile}${s.url && s.url !== 'about:blank' ? ` · ${s.url}` : ''}${s.takeover ? ' · taken over' : ''}`;
}
// The app opened on the Browser tab: app.js chose it before this script loaded.
if (bvTabOn()) bxShow();
