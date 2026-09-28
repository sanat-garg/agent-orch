'use strict';
// ---------- Browser: profiles per machine and the live view (server: browser-view.mjs, /api/browser*, bv_* on /ws) ----------
// The sidebar's globe opens the Browser sheet (#browserModal): each machine that can run a browser, its profiles with
// Open, the signed-in sites (cookie domains only) and Clear. Open shows the live view (#bvModal): screencast frames on a
// canvas that scales to fit, the owner's mouse, touch, keys and paste sent back, a URL bar with Back and Reload. While a
// task uses the profile the owner watches, and can take over (the task's browser actions wait) until they hand back.
// A running browser task's drawer shows a small live thumbnail (bvTaskThumb). Loaded after app.js and uses its helpers
// ($, el, api, toast, send, openTask).
const BV = {
  data: null, err: '', loading: false, lastFocus: null, sites: new Map(), // `${node}/${identity}` → {list, err, open}
  view: null, // the open viewer: {node, identity, name}
  st: null, frame: { w: 0, h: 0 }, decoding: false, pending: null,
  want: new Map(), // key → {node, identity, modal, thumb}: what this tab watches (re-sent after a reconnect)
  thumb: null, // {key, el, canvas, node, identity, task}
};
const bvKey = (node, identity) => `${node}/${identity}`;
const BV_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ----- which views this tab wants (one server-side viewer per tab and profile)
function bvSync(node, identity) {
  const k = bvKey(node, identity), w = BV.want.get(k);
  if (!w || (!w.modal && !w.thumb)) { BV.want.delete(k); return send({ t: 'bv_close', node, identity }); }
  send({ t: 'bv_open', node, identity, thumb: !w.modal, ...(w.url && { url: w.url }) });
  delete w.url;
}
function bvWant(node, identity, part, on, url) {
  const k = bvKey(node, identity), w = BV.want.get(k) || { node, identity, modal: false, thumb: false };
  w[part] = on;
  if (url) w.url = url;
  BV.want.set(k, w);
  bvSync(node, identity);
}
function bvResume() { for (const w of BV.want.values()) send({ t: 'bv_open', node: w.node, identity: w.identity, thumb: !w.modal }); }

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
  (BV.lastFocus?.isConnected ? BV.lastFocus : $('browserBtn')).focus?.();
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
    bvOpen(n.id, id, n.name);
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
  open.onclick = () => bvOpen(n.id, p.identity, n.name);
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
$('browserBtn').addEventListener('click', bwOpen);
$('browserModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) bwClose(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('browserModal').hidden && $('bvModal').hidden) { e.stopImmediatePropagation(); bwClose(); }
}, true);

// ----- the live view
function bvOpen(node, identity, name, { take = false } = {}) {
  if (BV.view) bvClose({ keepFocus: true });
  BV.lastViewFocus = document.activeElement;
  BV.view = { node, identity, name: name || node };
  BV.st = null;
  BV.frame = { w: 0, h: 0 };
  BV.take = take;
  $('bvTitle').textContent = identity;
  $('bvUrl').value = '';
  $('bvWait').hidden = false;
  $('bvWait').textContent = 'Starting the browser…';
  const c = $('bvCanvas');
  c.width = 0; c.height = 0;
  $('bvModal').hidden = false;
  bvRenderState();
  bvWant(node, identity, 'modal', true);
  c.focus({ preventScroll: true });
}
function bvClose({ keepFocus = false } = {}) {
  if (!BV.view) return;
  const { node, identity } = BV.view;
  BV.view = null;
  BV.st = null;
  $('bvModal').hidden = true;
  $('bvKeys').blur();
  bvWant(node, identity, 'modal', false);
  if (!$('browserModal').hidden) bwLoad();
  if (!keepFocus) (BV.lastViewFocus?.isConnected ? BV.lastViewFocus : $('browserBtn')).focus?.();
}
const bvCanDrive = () => BV.st?.role === 'control' && !BV.st.closed;
function bvRenderState() {
  const s = BV.st, v = BV.view;
  if (!v) return;
  const status = $('bvStatus'), take = $('bvTake');
  let text = `${v.name}`;
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
  status.textContent = text;
  $('bvModal').classList.toggle('watching', !bvCanDrive());
  for (const id of ['bvBack', 'bvReload', 'bvPaste', 'bvKbd', 'bvUrl']) $(id).disabled = !bvCanDrive();
  if (s && !s.closed && document.activeElement !== $('bvUrl')) $('bvUrl').value = s.url === 'about:blank' ? '' : s.url || '';
  if (s?.closed) { $('bvWait').hidden = false; $('bvWait').textContent = s.error || 'The browser closed.'; }
  if (s && BV.take && s.active && !s.takeover && !s.closed) { BV.take = false; bvSay({ t: 'bv_take' }); }
}
const bvSay = (m) => BV.view && send({ node: BV.view.node, identity: BV.view.identity, ...m });
$('bvTake').addEventListener('click', () => {
  const s = BV.st;
  if (!s) return;
  bvSay({ t: s.takeover && s.role === 'control' ? 'bv_handback' : 'bv_take' });
});

// Frames: only the newest is decoded; one in flight at a time.
function bvDraw(f) {
  BV.pending = f;
  if (BV.decoding) return;
  BV.decoding = true;
  const img = new Image();
  img.onload = img.onerror = () => {
    const c = $('bvCanvas');
    if (img.naturalWidth && BV.view) {
      if (c.width !== img.naturalWidth || c.height !== img.naturalHeight) { c.width = img.naturalWidth; c.height = img.naturalHeight; }
      c.getContext('2d').drawImage(img, 0, 0);
      BV.frame = { w: f.w, h: f.h };
      $('bvWait').hidden = true;
    }
    BV.decoding = false;
    if (BV.pending !== f && BV.pending) bvDraw(BV.pending);
    else BV.pending = null;
  };
  img.src = `data:image/jpeg;base64,${f.data}`;
}

// ----- input: canvas pixels → page CSS px (the frame's w×h)
function bvPoint(e) {
  const r = $('bvCanvas').getBoundingClientRect();
  if (!r.width || !BV.frame.w) return null;
  return { x: Math.round(((e.clientX - r.left) / r.width) * BV.frame.w), y: Math.round(((e.clientY - r.top) / r.height) * BV.frame.h) };
}
const bvMods = (e) => ({ ...(e.altKey && { alt: true }), ...(e.ctrlKey && { ctrl: true }), ...(e.metaKey && { meta: true }), ...(e.shiftKey && { shift: true }) });
const bvInput = (events) => { if (bvCanDrive() && events.length) bvSay({ t: 'bv_input', events }); };
const BV_BTN = ['left', 'middle', 'right'];
let bvTouch = null, bvMoveAt = 0;
const bvCv = $('bvCanvas');
bvCv.addEventListener('pointerdown', (e) => {
  const p = bvPoint(e);
  if (!p) return;
  bvCv.focus({ preventScroll: true });
  if (e.pointerType === 'mouse') { e.preventDefault(); bvCv.setPointerCapture(e.pointerId); bvInput([{ type: 'mouse', action: 'down', button: BV_BTN[e.button] || 'left', clickCount: e.detail || 1, ...p, ...bvMods(e) }]); }
  else bvTouch = { id: e.pointerId, x: e.clientX, y: e.clientY, at: Date.now(), lastY: e.clientY, lastX: e.clientX, p, moved: false };
});
bvCv.addEventListener('pointermove', (e) => {
  const p = bvPoint(e);
  if (!p) return;
  if (e.pointerType === 'mouse') {
    const now = Date.now();
    if (now - bvMoveAt < 50 && !e.buttons) return;
    bvMoveAt = now;
    return bvInput([{ type: 'mouse', action: 'move', buttons: e.buttons, button: e.buttons & 2 ? 'right' : 'left', ...p }]);
  }
  // Touch: a drag scrolls the page.
  const t = bvTouch;
  if (!t || t.id !== e.pointerId) return;
  if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8) t.moved = true;
  if (!t.moved) return;
  const r = bvCv.getBoundingClientRect(), k = BV.frame.w / (r.width || 1);
  bvInput([{ type: 'mouse', action: 'wheel', ...t.p, dx: Math.round((t.lastX - e.clientX) * k), dy: Math.round((t.lastY - e.clientY) * k) }]);
  t.lastX = e.clientX; t.lastY = e.clientY;
});
bvCv.addEventListener('pointerup', (e) => {
  const p = bvPoint(e);
  if (e.pointerType === 'mouse') { if (p) bvInput([{ type: 'mouse', action: 'up', button: BV_BTN[e.button] || 'left', clickCount: e.detail || 1, ...p, ...bvMods(e) }]); return; }
  const t = bvTouch;
  bvTouch = null;
  if (t && t.id === e.pointerId && !t.moved && p) bvInput([{ type: 'click', ...p }]); // a tap is a click
});
bvCv.addEventListener('pointercancel', () => { bvTouch = null; });
bvCv.addEventListener('contextmenu', (e) => e.preventDefault());
bvCv.addEventListener('wheel', (e) => {
  const p = bvPoint(e);
  if (!p || !bvCanDrive()) return;
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  bvInput([{ type: 'mouse', action: 'wheel', ...p, dx: Math.round(e.deltaX * k), dy: Math.round(e.deltaY * k) }]);
}, { passive: false });
// Keys while the canvas has focus go to the page (Escape too; the close button or a click outside closes).
bvCv.addEventListener('keydown', (e) => {
  if (!bvCanDrive()) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); return bvPaste(); }
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  bvInput([{ type: 'key', key: e.key, code: e.code, ...bvMods(e) }]);
});
// The on-screen keyboard (iPhone): a hidden field takes what is typed and forwards it; it always stays empty.
const bvKeysEl = $('bvKeys');
bvKeysEl.addEventListener('beforeinput', (e) => {
  e.preventDefault();
  if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText' || e.inputType === 'insertFromPaste') { if (e.data) bvInput([{ type: 'text', text: e.data }]); }
  else if (e.inputType === 'deleteContentBackward') bvInput([{ type: 'key', key: 'Backspace', code: 'Backspace' }]);
  else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') bvInput([{ type: 'key', key: 'Enter', code: 'Enter' }]);
});
bvKeysEl.addEventListener('input', () => { bvKeysEl.value = ''; });
bvKeysEl.addEventListener('keydown', (e) => {
  if (['Enter', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key) && !e.isComposing) {
    e.preventDefault();
    e.stopPropagation();
    bvInput([{ type: 'key', key: e.key, code: e.code, ...bvMods(e) }]);
  }
});
$('bvKbd').addEventListener('click', () => { bvKeysEl.value = ''; bvKeysEl.focus(); });
async function bvPaste() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { text = prompt('Paste the text to type into the page') || ''; }
  if (text) bvInput([{ type: 'text', text }]);
}
$('bvPaste').addEventListener('click', bvPaste);
$('bvBack').addEventListener('click', () => bvCanDrive() && bvSay({ t: 'bv_nav', action: 'back' }));
$('bvReload').addEventListener('click', () => bvCanDrive() && bvSay({ t: 'bv_nav', action: 'reload' }));
$('bvBar').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('bvUrl').value.trim();
  if (!url || !bvCanDrive()) return;
  bvSay({ t: 'bv_nav', action: 'go', url });
  bvCv.focus({ preventScroll: true });
});
$('bvModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) bvClose(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('bvModal').hidden || e.target === bvCv || e.target === bvKeysEl) return;
  e.stopImmediatePropagation();
  bvClose();
}, true);

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
