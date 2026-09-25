'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

marked.setOptions({ gfm: true, breaks: false });
const md = (text) => DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['target'] });

// ---------- click-to-copy for shell commands ----------
// Markdown marks shell code blocks and command-like inline code with .copy-cmd; tool lines carry
// data-copy. One capture-phase handler copies either (capture, so it runs before a row's toggle).
const SHELL_LANG = /\blanguage-(?:bash|sh|shell|zsh|console)\b/;
const SHELL_CMD = /^(?:git|npm|npx|node|python3?|sudo|cd|ls|codex|agy|claude|gh|tmux|systemctl)(?:\s|$)|\s&&\s|\s\|\s/;
DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.nodeName !== 'CODE') return;
  const pre = n.parentNode?.nodeName === 'PRE' ? n.parentNode : null;
  if (pre ? SHELL_LANG.test(n.className) || /^\$ /m.test(n.textContent) : SHELL_CMD.test(n.textContent.trim())) (pre || n).classList.add('copy-cmd');
});
// "$ cmd" lines in a block: copy just the commands, without the prompt or their output.
function copyText(node) {
  if (node.dataset.copy != null) return node.dataset.copy;
  const t = node.textContent.replace(/\n$/, '');
  const cmds = t.split('\n').filter((l) => l.startsWith('$ ')).map((l) => l.slice(2));
  return cmds.length ? cmds.join('\n') : t;
}
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  // Plain http has no navigator.clipboard.
  const ta = el('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}
document.addEventListener('click', async (e) => {
  const node = e.target.closest?.('.copy-cmd, [data-copy]');
  if (!node || e.target.closest('a') || String(window.getSelection?.() || '')) return;
  e.preventDefault();
  e.stopPropagation();
  const ok = await copyToClipboard(copyText(node));
  // A fixed tip, since tool lines clip their overflow.
  const r = node.getBoundingClientRect();
  const tip = el('div', 'copy-tip', ok ? 'Copied' : 'Copy failed');
  tip.style.left = `${Math.max(8, Math.min(r.left + Math.min(r.width, 240) / 2, innerWidth - 8))}px`;
  tip.style.top = `${Math.max(4, r.top - 30)}px`;
  document.body.append(tip);
  node.classList.add('copied');
  setTimeout(() => { tip.remove(); node.classList.remove('copied'); }, 1200);
}, true);

const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'orchestrator'];
const MODE_NAMES = { default: 'Ask before acting', acceptEdits: 'Auto-accept edits', plan: 'Plan mode', bypassPermissions: 'Full access', orchestrator: 'Orchestrator Mode' };

const state = {
  convos: [],
  cid: null,
  workspace: '',
  // What the next new chat works in: a brand-new project folder, or an existing folder.
  draft: { type: 'new', name: '' },
  // Full access is the default here; an older saved "ask first" choice is upgraded once.
  draftMode: store.get('cw.fullAccess') ? store.get('cw.mode') || 'bypassPermissions'
    : (store.set('cw.fullAccess', '1'), ['plan', 'orchestrator'].includes(store.get('cw.mode')) ? store.get('cw.mode') : 'bypassPermissions'),
  draftModel: store.get('cw.model') || 'claude|', // agent|model (an older saved value is a bare Claude model)
  draftAuto: store.get('cw.auto') === '1', // Auto Delegate for the next new chat
  busy: false,
  ws: null,
  live: null,        // element receiving streamed text
  liveText: '',
  tools: new Map(),  // tool_use id -> card
  perms: new Map(),  // pid -> card
  workingSince: 0,
};

// ---------- view toggle (chat / terminals) ----------
function setView(view) {
  if (view !== 'term') view = 'chat';
  $('app').dataset.view = view;
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  $('chatView').hidden = view !== 'chat';
  $('termView').hidden = view !== 'term';
  $('title').textContent = view === 'term' ? 'Terminal' : currentTitle();
  $('cwdLabel').textContent = view === 'term' ? '~/workspace · bash' : currentCwdLabel();
  if (view === 'term') openTerminals();
  else $('input').focus({ preventScroll: true });
  store.set('cw.view', view);
}
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('bannerTerm').addEventListener('click', () => setView('term'));
$('updateRestart').addEventListener('click', async () => {
  $('updateRestart').disabled = true;
  try { await api('/api/restart-when-idle', 'POST'); upd.pending = true; } catch { $('updateRestart').disabled = false; }
  renderUpdateBanner();
});
$('updateDismiss').addEventListener('click', () => { upd.dismissed = upd.commits; store.set('cw.updDismissed', String(upd.commits)); renderUpdateBanner(); });

// ---------- terminals ----------
// Every terminal is a tmux session running bash on the server, so it keeps running when the
// browser closes. Each keeps its own iframe alive, so switching never reconnects. Layouts: one at
// a time (tabs), all side by side (split), or a grid.
const T = {
  list: [], active: store.get('cw.term') || null, cells: new Map(),
  layout: ['tabs', 'split', 'stack', 'grid'].includes(store.get('cw.termLayout')) ? store.get('cw.termLayout') : 'tabs',
};
const termLabel = (name) => (/^term-(\d+)$/.test(name) ? `Terminal ${name.slice(5)}` : name === 'github' ? 'GitHub sign-in' : name);
const termSrc = (name) => `/shell/?arg=${encodeURIComponent(name)}`;

async function openTerminals(focusName) {
  await refreshTerminals();
  if (!T.list.length) return newTerminal();
  const name = focusName && T.list.some((t) => t.name === focusName) ? focusName
    : T.list.some((t) => t.name === T.active) ? T.active : T.list[T.list.length - 1].name;
  showTerminal(name);
}
async function refreshTerminals() {
  try { T.list = (await api('/api/terminals')).terminals; } catch { return; }
  for (const [name, cell] of T.cells) if (!T.list.some((t) => t.name === name)) { cell.remove(); T.cells.delete(name); }
  renderTermTabs();
}
async function newTerminal() {
  try {
    const { name } = await api('/api/terminals', 'POST');
    await refreshTerminals();
    showTerminal(name);
  } catch (e) {
    $('termNote').textContent = `Couldn't open a terminal: ${e.message}`;
  }
}
function termCell(name) {
  let cell = T.cells.get(name);
  if (cell) return cell;
  cell = el('div', 'term-cell');
  const label = el('div', 'tc-label');
  label.append(el('span', 'tc-name', termLabel(name)));
  const x = el('button', 'tc-close');
  x.type = 'button';
  x.title = `Close ${termLabel(name)}`;
  x.setAttribute('aria-label', `Close ${termLabel(name)}`);
  x.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  x.addEventListener('click', (e) => { e.stopPropagation(); closeTerminal(name); });
  label.append(x);
  label.addEventListener('click', () => showTerminal(name));
  const f = el('iframe');
  f.title = termLabel(name);
  f.allow = 'clipboard-read; clipboard-write';
  f.src = termSrc(name);
  // Clicking into a cell makes it the active terminal.
  f.addEventListener('load', () => {
    try {
      f.contentWindow.addEventListener('focus', () => markActive(name));
      // Match the dark theme inside the terminal page (its scrollbar is otherwise light).
      const st = f.contentDocument.createElement('style');
      st.textContent = 'html{color-scheme:dark}' +
        '.xterm-viewport::-webkit-scrollbar{width:4px}.xterm-viewport::-webkit-scrollbar-track{background:transparent}' +
        '.xterm-viewport::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:4px}' +
        '.xterm-viewport::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.3)}' +
        '@supports not selector(::-webkit-scrollbar){.xterm-viewport{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.14) transparent}}';
      f.contentDocument.head.append(st);
    } catch {}
    hookClipboard(f);
  });
  cell.append(label, f);
  T.cells.set(name, cell);
  $('termFrames').append(cell);
  return cell;
}
// Selecting text works like an ordinary terminal: drag to select, the highlight stays after you let
// go, and it is copied straight away (Cmd/Ctrl+C copies it too). tmux has mouse mode on so the wheel
// scrolls its history, which would normally hand drags to tmux as well. So left-button presses and
// drags are re-sent with the modifier that tells xterm.js to select instead (Option on a Mac,
// Shift elsewhere). Programs that copy by sending OSC 52 reach the clipboard too.
function hookClipboard(f, tries = 40) {
  let term, doc, w;
  try { w = f.contentWindow; doc = f.contentDocument; term = w.term; } catch { return; }
  if (!term?.parser || !doc?.querySelector('.xterm')) { if (tries > 0) setTimeout(() => hookClipboard(f, tries - 1), 150); return; }
  if (term.__hooked) return;
  term.__hooked = true;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const forceKey = isMac ? 'altKey' : 'shiftKey';
  term.options.macOptionClickForcesSelection = true;
  term.options.altClickMovesCursor = false;

  let dragging = false;
  const reissue = (e) => {
    if (e.__forced) return;
    if (e.type === 'mousedown') {
      if (e.button !== 0 || !e.target.closest?.('.xterm')) return;
      dragging = true;
    } else if (!dragging) return;
    if (e.type === 'mouseup') dragging = false;
    if (e[forceKey]) return; // already a selection gesture
    e.stopImmediatePropagation();
    e.preventDefault();
    const clone = new w.MouseEvent(e.type, {
      bubbles: true, cancelable: true, view: w, detail: e.detail,
      screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY,
      button: e.button, buttons: e.buttons, ctrlKey: e.ctrlKey, metaKey: e.metaKey,
      shiftKey: e.shiftKey, altKey: e.altKey, [forceKey]: true,
    });
    clone.__forced = true;
    e.target.dispatchEvent(clone);
    if (e.type === 'mouseup') setTimeout(copySelection, 0);
  };
  for (const type of ['mousedown', 'mousemove', 'mouseup']) doc.addEventListener(type, reissue, true);
  // A selection only stays until the next click or keystroke; clicking focuses the terminal again.
  const copySelection = () => {
    if (!term.hasSelection()) return;
    const text = term.getSelection();
    if (text) writeClipboard(w, text, 'Copied');
  };
  term.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (!b64 || b64 === '?') return true;
    try { writeClipboard(w, new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))), 'Copied'); } catch {}
    return true;
  });
}
function writeClipboard(w, text, verb) {
  const n = text.length;
  (w.navigator.clipboard || navigator.clipboard).writeText(text)
    .then(() => flashTermNote(`${verb} ${n} character${n === 1 ? '' : 's'}`))
    .catch(() => flashTermNote(`Selected ${n} character${n === 1 ? '' : 's'} · press ${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+'}C to copy`));
}
let noteTimer;
function flashTermNote(text) {
  const n = $('termNote');
  if (!n.dataset.base) n.dataset.base = n.innerHTML;
  n.textContent = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { n.innerHTML = n.dataset.base; }, 1800);
}
function markActive(name) {
  if (T.active === name) return;
  T.active = name;
  store.set('cw.term', name);
  for (const [n, c] of T.cells) c.classList.toggle('focus', n === name);
  renderTermTabs();
}
// Puts the keyboard in the terminal, retrying until ttyd has drawn it.
function focusTerminal(name, tries = 30) {
  const f = T.cells.get(name)?.querySelector('iframe');
  if (!f || $('termView').hidden) return;
  try {
    const w = f.contentWindow;
    const ta = f.contentDocument?.querySelector('.xterm-helper-textarea');
    if (w?.term?.focus) { w.focus(); w.term.focus(); return; }
    if (ta) { w.focus(); ta.focus(); return; }
  } catch {}
  if (tries > 0) setTimeout(() => focusTerminal(name, tries - 1), 150);
}
// Track sizes (as fr weights) per layout and terminal count, remembered between visits.
const sizeKey = (axis, count) => `cw.termSizes.${T.layout}.${axis}.${count}`;
function trackSizes(axis, count) {
  try {
    const saved = JSON.parse(store.get(sizeKey(axis, count)) || 'null');
    if (Array.isArray(saved) && saved.length === count && saved.every((x) => x > 0)) return saved;
  } catch {}
  return Array(count).fill(1);
}
function layoutTerminals() {
  const box = $('termFrames');
  const multi = T.layout !== 'tabs' && T.list.length > 1;
  if (multi) for (const t of T.list) termCell(t.name); // every terminal shows, so all need to load
  const shown = multi ? T.list.map((t) => t.name) : T.active ? [T.active] : [];
  for (const [n, c] of T.cells) {
    c.hidden = !shown.includes(n);
    c.classList.toggle('focus', n === T.active);
    c.style.order = String(T.list.findIndex((t) => t.name === n));
  }
  box.classList.toggle('multi', multi);
  const n = shown.length || 1;
  let cols = 1, rows = 1;
  if (multi && T.layout === 'split') cols = n;
  else if (multi && T.layout === 'stack') rows = n;
  else if (multi && T.layout === 'grid') { cols = Math.ceil(Math.sqrt(n)); rows = Math.ceil(n / cols); }
  T.grid = { cols: trackSizes('cols', cols), rows: trackSizes('rows', rows) };
  applyTracks();
  renderGutters();
  document.querySelectorAll('#termLayout button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === T.layout)));
  renderTermTabs();
}
function applyTracks() {
  const box = $('termFrames');
  const tpl = (fr) => fr.map((f) => `minmax(0, ${f}fr)`).join(' ');
  box.style.gridTemplateColumns = tpl(T.grid.cols);
  box.style.gridTemplateRows = tpl(T.grid.rows);
  // Keep dividers on the boundaries they belong to.
  for (const g of box.querySelectorAll('.term-gutter')) {
    const fr = T.grid[g.dataset.axis], i = Number(g.dataset.i);
    const pos = (fr.slice(0, i).reduce((a, b) => a + b, 0) / fr.reduce((a, b) => a + b, 0)) * 100;
    if (g.dataset.axis === 'cols') g.style.left = `${pos}%`; else g.style.top = `${pos}%`;
  }
}
// A draggable divider on every boundary between two terminals; double-click evens them out.
function renderGutters() {
  const box = $('termFrames');
  box.querySelectorAll('.term-gutter').forEach((g) => g.remove());
  for (const axis of ['cols', 'rows']) {
    for (let i = 1; i < T.grid[axis].length; i++) {
      const g = el('div', `term-gutter ${axis === 'cols' ? 'v' : 'h'}`);
      g.dataset.axis = axis;
      g.dataset.i = i;
      g.title = 'Drag to resize · double-click to even out';
      g.addEventListener('pointerdown', (e) => startResize(e, g, axis, i));
      g.addEventListener('dblclick', () => {
        T.grid[axis] = T.grid[axis].map(() => 1);
        store.set(sizeKey(axis, T.grid[axis].length), JSON.stringify(T.grid[axis]));
        applyTracks();
      });
      box.append(g);
    }
  }
  applyTracks();
}
function startResize(e, g, axis, i) {
  e.preventDefault();
  const box = $('termFrames');
  const rect = box.getBoundingClientRect();
  const fr = T.grid[axis];
  const total = fr.reduce((a, b) => a + b, 0);
  const before = fr.slice(0, i - 1).reduce((a, b) => a + b, 0) / total; // start of the track left/above the divider
  const after = fr.slice(0, i + 1).reduce((a, b) => a + b, 0) / total;  // end of the track right/below it
  const MIN = Math.min(0.08, (after - before) / 2);
  g.setPointerCapture(e.pointerId);
  g.classList.add('active');
  box.classList.add('resizing', axis === 'cols' ? 'resizing-x' : 'resizing-y'); // iframes stop swallowing the pointer
  const move = (ev) => {
    const raw = axis === 'cols' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
    const pos = Math.min(after - MIN, Math.max(before + MIN, raw));
    fr[i - 1] = (pos - before) * total;
    fr[i] = (after - pos) * total;
    applyTracks();
  };
  const up = () => {
    g.releasePointerCapture(e.pointerId);
    g.classList.remove('active');
    box.classList.remove('resizing', 'resizing-x', 'resizing-y');
    g.removeEventListener('pointermove', move);
    g.removeEventListener('pointerup', up);
    g.removeEventListener('pointercancel', up);
    store.set(sizeKey(axis, fr.length), JSON.stringify(fr));
    if (T.active) focusTerminal(T.active);
  };
  g.addEventListener('pointermove', move);
  g.addEventListener('pointerup', up);
  g.addEventListener('pointercancel', up);
}
function showTerminal(name) {
  termCell(name);
  markActive(name);
  $('termFrames').querySelector('.term-empty')?.remove();
  layoutTerminals();
  renderTermTabs();
  focusTerminal(name);
}
async function closeTerminal(name) {
  if (!confirm(`Close ${termLabel(name)}? Anything still running in it stops.`)) return;
  await api(`/api/terminals/${encodeURIComponent(name)}`, 'DELETE').catch(() => {});
  T.cells.get(name)?.remove();
  T.cells.delete(name);
  await refreshTerminals();
  if (T.active === name) T.active = null;
  if (T.list.length) showTerminal(T.active || T.list[T.list.length - 1].name);
  else { layoutTerminals(); $('termFrames').append(el('div', 'term-empty', 'No terminals open. Press + to start one.')); }
}
function renderTermTabs() {
  const bar = $('termTabs');
  bar.querySelectorAll('.term-tab').forEach((b) => b.remove());
  for (const t of T.list) {
    const b = el('button', 'term-tab');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(t.name === T.active));
    b.title = t.name;
    if (t.attached) b.append(el('span', 'dot-live'));
    b.append(el('span', '', termLabel(t.name)));
    b.hidden = T.layout !== 'tabs'; // every terminal is on screen in the other layouts
    b.addEventListener('click', () => showTerminal(t.name));
    bar.insertBefore(b, $('termAdd'));
  }
}
$('termAdd').addEventListener('click', newTerminal);
$('termLayout').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-layout]');
  if (!b) return;
  T.layout = b.dataset.layout;
  store.set('cw.termLayout', T.layout);
  layoutTerminals();
  if (T.active) focusTerminal(T.active);
});
$('termReload').addEventListener('click', () => { const f = T.cells.get(T.active)?.querySelector('iframe'); if (f) f.src = termSrc(T.active); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === '`') { e.preventDefault(); setView($('app').dataset.view === 'chat' ? 'term' : 'chat'); }
});

// ---------- sidebar ----------
const closeSidebar = () => $('app').classList.remove('side-open');
$('openSidebar').addEventListener('click', () => $('app').classList.add('side-open'));
$('closeSidebar').addEventListener('click', closeSidebar);
$('scrim').addEventListener('click', closeSidebar);
$('newChat').addEventListener('click', () => {
  state.draft = { type: 'new', name: '' };
  openConvo(null);
  closeSidebar();
  setView('chat');
});
$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});

function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}
function folderName(cwd) {
  if (!cwd) return 'workspace';
  if (cwd === state.workspace) return 'workspace (root)';
  return cwd.startsWith(state.workspace + '/') ? cwd.slice(state.workspace.length + 1) : tilde(cwd);
}

function renderConvoList() {
  const nav = $('convoList');
  nav.textContent = '';
  if (!state.convos.length) {
    const p = el('p', 'group-label', 'No projects yet');
    p.style.textTransform = 'none';
    nav.append(p);
    return;
  }
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const sorted = [...state.convos].sort((a, b) => b.updatedAt - a.updatedAt);
  let lastGroup = '';
  for (const c of sorted) {
    const group = c.updatedAt >= dayStart ? 'Today' : c.updatedAt >= dayStart - 6 * 864e5 ? 'This week' : 'Older';
    if (group !== lastGroup) { nav.append(el('div', 'group-label', group)); lastGroup = group; }
    const b = el('div', 'convo' + (c.id === state.cid ? ' active' : ''));
    b.tabIndex = 0;
    b.setAttribute('role', 'button');
    b.title = tilde(c.cwd);
    b.append(el('span', 'ct', c.title || folderName(c.cwd)));
    const meta = el('span', 'cm');
    if (c.busy) meta.append(el('span', 'busy-dot'));
    const bits = [c.mode === 'orchestrator' ? 'Orchestrator' : 'Chat'];
    if (c.git?.error) bits.push('not pushed');
    bits.push(relTime(c.updatedAt));
    meta.append(document.createTextNode(bits.join(' · ')));
    b.append(meta);
    const more = el('button', 'more');
    more.setAttribute('aria-label', 'Project options');
    more.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>';
    more.addEventListener('click', (e) => { e.stopPropagation(); convoMenu(c, more); });
    b.append(more);
    const open = () => { openConvo(c.id); closeSidebar(); setView('chat'); };
    b.addEventListener('click', open);
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    nav.append(b);
  }
}

function convoMenu(c, anchor) {
  document.querySelector('.menu')?.remove();
  const m = el('div', 'menu');
  const rename = el('button', '', 'Rename');
  const del = el('button', 'danger', 'Delete');
  rename.onclick = async () => {
    m.remove();
    const title = prompt('Rename project (the folder keeps its name)', c.title);
    if (title && title.trim()) await api(`/api/convos/${c.id}`, 'PATCH', { title });
  };
  del.onclick = async () => {
    m.remove();
    if (!confirm(`Remove "${c.title}" and its chat from the sidebar? The folder and its GitHub repo are kept.`)) return;
    await api(`/api/convos/${c.id}`, 'DELETE');
    if (state.cid === c.id) openConvo(null);
  };
  m.append(rename, del);
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${Math.min(r.bottom + 4, innerHeight - 100)}px`;
  m.style.left = `${Math.min(r.left, innerWidth - 170)}px`;
  setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }));
}

async function api(url, method = 'GET', body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

// ---------- conversation state ----------
const currentConvo = () => state.convos.find((c) => c.id === state.cid);
const currentTitle = () => currentConvo()?.title || 'New chat';
const tilde = (p) => (p || '').replace(/^\/home\/[^/]+/, '~');
function currentCwdLabel() {
  const c = currentConvo();
  if (c) return tilde(c.cwd);
  return state.draft.type === 'folder' ? tilde(state.draft.path) : `~/workspace/${draftSlug() || '(named from your first message)'}`;
}
// Mirrors the server's slugify so the preview matches the folder that gets created.
const STOP_WORDS = new Set('a an the and or of for to in on with me my our your i we you it this that please can could would should make build create write add set up setup help need want let using use into from some new small simple quick basic'.split(' '));
function slugify(text, fromMessage = false) {
  if (!text) return '';
  const words = String(text).toLowerCase().replace(/[^a-z0-9\s._-]/g, ' ').split(/[\s_]+/).filter(Boolean);
  const keep = fromMessage ? words.filter((w) => !STOP_WORDS.has(w)) : words;
  return (keep.length ? keep : words).slice(0, fromMessage ? 4 : 8).join('-').replace(/[^a-z0-9.-]/g, '').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40);
}
function draftSlug() {
  return state.draft.type === 'new' ? slugify(state.draft.name) || slugify($('input').value, true) : '';
}
function updateHeader() {
  if ($('app').dataset.view !== 'chat') { $('repoLink').hidden = true; return; }
  $('title').textContent = currentTitle();
  $('cwdLabel').textContent = currentCwdLabel();
  document.title = `${currentTitle()} · agent-orch`;
  renderRepoLink();
}
function renderRepoLink() {
  const c = currentConvo(), a = $('repoLink');
  a.hidden = !c;
  if (!c) return;
  a.classList.remove('warn');
  a.onclick = null;
  if (c.repo) {
    a.href = c.repo.url;
    const behind = c.git?.error ? ` · not pushed` : '';
    $('repoText').textContent = c.repo.full.split('/')[1] + behind;
    a.title = c.git?.error ? `Couldn't push yet (retrying): ${c.git.error}` : c.git?.pushedAt ? `Pushed ${relTime(c.git.pushedAt)} · ${c.repo.url}` : c.repo.url;
    if (c.git?.error) a.classList.add('warn');
  } else {
    a.removeAttribute('href');
    a.classList.add('warn');
    $('repoText').textContent = GH.linked ? 'Creating repo…' : 'Link GitHub';
    a.title = GH.linked ? 'Creating this project\'s GitHub repo' : 'Every project is pushed to its own GitHub repo';
    if (!GH.linked) a.onclick = (e) => { e.preventDefault(); linkGitHub(); };
  }
}
function projectLabel() {
  const c = currentConvo();
  if (c) return folderName(c.cwd);
  if (state.draft.type === 'folder') return folderName(state.draft.path);
  const slug = draftSlug();
  return slug ? `New: ${slug}` : 'New project';
}
function updateFolderChip() {
  const c = currentConvo();
  const isNew = !c && state.draft.type === 'new';
  $('folderLabel').textContent = projectLabel();
  $('folderBtn').classList.toggle('new', isNew);
  $('folderBtn').title = c ? `This chat works in ${tilde(c.cwd)}. Pick another project to start a new chat there.` : 'Choose which project Claude works in';
  // The big picker in the empty state
  const pick = document.querySelector('.project-pick');
  if (pick) {
    pick.classList.toggle('new', isNew);
    pick.querySelector('.pp-name').textContent = projectLabel();
  }
}
function setModeUI(mode) {
  $('mode').value = mode;
  $('modeChip').dataset.mode = mode;
  $('input').placeholder = mode === 'orchestrator'
    ? 'Tell the orchestrator what to build or fix…'
    : 'Ask Claude to build something…';
  if (typeof renderOrchBar === 'function') renderOrchBar();
}

function openConvo(cid) {
  if (cid !== state.cid) { closeTask(); O.project = null; }
  state.cid = cid;
  history.replaceState(null, '', cid ? `#${cid}` : '#');
  resetMessages();
  setBusy(false);
  if (!cid) {
    $('messages').append($('emptyTpl').content.cloneNode(true));
    renderRecentProjects();
    setModeUI(state.draftMode);
    setPick(state.draftModel);
  }
  updateFolderChip();
  updateHeader();
  renderConvoList();
  send({ t: 'open', cid });
  $('input').focus({ preventScroll: true });
}

function resetMessages() {
  $('messages').textContent = '';
  state.tools.clear();
  state.perms.clear();
  state.live = null;
  state.liveText = '';
}

// ---------- rendering ----------
const scroller = $('scroller');
let stick = true;
scroller.addEventListener('scroll', () => {
  stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  $('jump').hidden = stick;
});
$('jump').addEventListener('click', () => { stick = true; scrollDown(true); });
function scrollDown(force) {
  if (stick || force) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
}
function add(node) {
  $('messages').querySelector('.empty')?.remove();
  $('messages').append(node);
  scrollDown();
  return node;
}

function shortPath(p) {
  if (!p) return '';
  const c = currentConvo();
  if (c && p.startsWith(c.cwd + '/')) return p.slice(c.cwd.length + 1);
  return p.replace(/^\/home\/[^/]+/, '~');
}
function toolSummary(name, i = {}) {
  switch (name) {
    case 'Bash': return i.description ? `${i.description}  ·  ${i.command}` : i.command;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return shortPath(i.file_path || i.notebook_path);
    case 'Glob': return i.pattern;
    case 'Grep': return `${i.pattern}${i.path ? '  in ' + shortPath(i.path) : ''}`;
    case 'WebFetch': return i.url;
    case 'WebSearch': return i.query;
    case 'Task': case 'Agent': return i.description || i.prompt;
    case 'TodoWrite': return `${(i.todos || []).length} tasks`;
    default: {
      const s = JSON.stringify(i);
      return s === '{}' ? '' : s;
    }
  }
}
const TOOL_LABEL = { Bash: 'Run', Read: 'Read', Write: 'Write', Edit: 'Edit', MultiEdit: 'Edit', Glob: 'Find files', Grep: 'Search', WebFetch: 'Fetch', WebSearch: 'Web search', TodoWrite: 'Tasks', Task: 'Agent', Agent: 'Agent' };

function diffView(edits) {
  const d = el('div', 'diff');
  for (const e of edits) {
    if (edits.length > 1) d.append(el('div', 'h', '@@'));
    const a = e.old_string ? String(e.old_string).split('\n') : [];
    const b = e.new_string ? String(e.new_string).split('\n') : [];
    // Lines both sides share at the start and end are context, not changes.
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    a.slice(0, pre).forEach((l) => d.append(el('div', '', '  ' + l)));
    a.slice(pre, a.length - suf).forEach((l) => d.append(el('div', 'd', '- ' + l)));
    b.slice(pre, b.length - suf).forEach((l) => d.append(el('div', 'a', '+ ' + l)));
    a.slice(a.length - suf).forEach((l) => d.append(el('div', '', '  ' + l)));
  }
  return d;
}
function writeView(content) {
  const lines = String(content || '').split('\n');
  const d = el('div', 'diff');
  lines.slice(0, 400).forEach((l) => d.append(el('div', 'a', '+ ' + l)));
  if (lines.length > 400) d.append(el('div', 'h', `… ${lines.length - 400} more lines`));
  return d;
}
function todoView(todos = []) {
  const ul = el('ul', 'todos');
  for (const t of todos) {
    const li = el('li', t.status);
    li.append(el('span', 'box', t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'));
    li.append(el('span', '', t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content));
    ul.append(li);
  }
  return ul;
}
function toolInputView(name, input = {}) {
  const frag = document.createDocumentFragment();
  if (name === 'Bash') { const pre = frag.appendChild(el('pre', 'cmd', '$ ' + input.command)); pre.dataset.copy = input.command; }
  else if (name === 'Edit') frag.append(diffView([input]));
  else if (name === 'MultiEdit') frag.append(diffView(input.edits || []));
  else if (name === 'Write') frag.append(writeView(input.content));
  else if (name === 'TodoWrite') frag.append(todoView(input.todos));
  else if (['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'].includes(name)) { /* summary line says it all */ }
  else if (name === 'Task' || name === 'Agent') frag.append(el('pre', '', input.prompt || ''));
  else frag.append(el('pre', '', JSON.stringify(input, null, 2)));
  return frag;
}

function toolCard(ev) {
  const card = el('details', 'tool running' + (ev.sub ? ' msg sub' : ''));
  const sum = el('summary');
  const ts = el('span', 'ts', toolSummary(ev.name, ev.input) || '');
  if (ev.name === 'Bash' && ev.input?.command) ts.dataset.copy = ev.input.command;
  sum.append(el('span', 'st'), el('span', 'tn', TOOL_LABEL[ev.name] || ev.name), ts);
  const chev = el('span', 'chev');
  chev.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  sum.append(chev);
  const body = el('div', 'body');
  body.append(toolInputView(ev.name, ev.input));
  card.append(sum, body);
  // Diffs and task lists are what people want to see without clicking.
  if (['Edit', 'MultiEdit', 'TodoWrite'].includes(ev.name)) card.open = true;
  if (ev.name === 'Write' && String(ev.input?.content || '').split('\n').length <= 30) card.open = true;
  card.dataset.name = ev.name;
  return card;
}
function finishTool(ev) {
  const card = state.tools.get(ev.id);
  if (!card) return;
  card.classList.remove('running');
  card.classList.add(ev.isError ? 'err' : 'ok');
  const name = card.dataset.name;
  const text = (ev.text || '').trim();
  // Edit/Write/Todo results are just confirmations; the input already shows the change.
  const quiet = ['Edit', 'MultiEdit', 'Write', 'TodoWrite'].includes(name) && !ev.isError;
  if (text && !quiet) {
    const body = card.querySelector('.body');
    if (name !== 'Bash' && body.children.length) body.append(el('div', 'label', 'Result'));
    body.append(el('pre', 'out' + (ev.isError ? ' err' : ''), text));
  }
  if (ev.isError) card.open = true;
}

// ----- screenshots: {id, name, w, h} images served from /api/media/:id
const mediaUrl = (id) => `/api/media/${encodeURIComponent(id)}`;
function shotMissing() { return el('div', 'shot-missing', 'Image unavailable'); }
function shotNode(img) {
  const fig = el('figure', 'shot');
  const b = el('button');
  b.type = 'button';
  b.title = `Open ${img.name || 'image'}`;
  const im = el('img');
  im.src = mediaUrl(img.id);
  im.alt = img.name || 'Screenshot';
  im.loading = 'lazy';
  im.decoding = 'async';
  if (img.w && img.h) { im.width = img.w; im.height = img.h; }
  im.onerror = () => { b.replaceWith(shotMissing()); fig.classList.add('broken'); };
  b.append(im);
  b.onclick = () => openShot(fig);
  fig.dataset.id = img.id;
  fig.dataset.name = img.name || '';
  fig.append(b, el('figcaption', '', img.name || 'image'));
  return fig;
}
function shotGrid(imgs = []) {
  const g = el('div', 'shots');
  for (const img of imgs) g.append(shotNode(img));
  return g;
}
// Prev/next goes through every image of the chat, or of the whole task in the drawer.
function openShot(fig) {
  let list;
  if (fig.closest('#drBody') && O.detail) list = O.detail.runs.flatMap((r) => r.entries.filter((e) => e.k === 'image'));
  else list = [...$('messages').querySelectorAll('.shot')].map((f) => ({ id: f.dataset.id, name: f.dataset.name }));
  const seen = new Set();
  list = list.filter((i) => i.id && !seen.has(i.id) && seen.add(i.id));
  LB.list = list;
  LB.lastFocus = document.activeElement;
  showShot(Math.max(0, list.findIndex((i) => i.id === fig.dataset.id)));
  $('lightbox').hidden = false;
  $('lightbox').querySelector('[data-close].icon-btn').focus();
}
const LB = { list: [], i: 0, lastFocus: null };
function showShot(i) {
  const n = LB.list.length;
  if (!n) return;
  LB.i = (i + n) % n;
  const img = LB.list[LB.i];
  $('lbTitle').textContent = img.name || 'Screenshot';
  $('lbSub').textContent = n > 1 ? `${LB.i + 1} of ${n} · use ← → to browse` : '';
  $('lbOpen').href = mediaUrl(img.id);
  $('lbMissing').hidden = true;
  $('lbImg').hidden = false;
  $('lbImg').alt = img.name || 'Screenshot';
  $('lbImg').src = mediaUrl(img.id);
  $('lbPrev').hidden = $('lbNext').hidden = n < 2;
}
function closeShot() {
  $('lightbox').hidden = true;
  $('lbImg').removeAttribute('src');
  LB.lastFocus?.focus?.();
}
$('lbImg').addEventListener('error', () => { if ($('lbImg').getAttribute('src')) { $('lbImg').hidden = true; $('lbMissing').hidden = false; } });
$('lbPrev').addEventListener('click', () => showShot(LB.i - 1));
$('lbNext').addEventListener('click', () => showShot(LB.i + 1));
$('lightbox').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeShot(); });
// On window, capturing: runs before the drawer's and the chat's own Escape handlers.
window.addEventListener('keydown', (e) => {
  if ($('lightbox').hidden) return;
  if (e.key === 'Escape') closeShot();
  else if (e.key === 'ArrowLeft') showShot(LB.i - 1);
  else if (e.key === 'ArrowRight') showShot(LB.i + 1);
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

function endLive() {
  if (state.live) state.live.classList.remove('streaming');
  state.live = null;
  state.liveText = '';
}
let liveRender = 0;
function onDelta(text) {
  if (!state.live) {
    state.live = add(el('div', 'msg text streaming'));
    state.liveText = '';
  }
  state.liveText += text;
  if (!liveRender) {
    liveRender = requestAnimationFrame(() => {
      liveRender = 0;
      if (state.live) { state.live.innerHTML = md(state.liveText); scrollDown(); }
    });
  }
}

function renderEvent(ev, replay) {
  switch (ev.t) {
    case 'user': {
      endLive();
      add(el('div', 'msg user', ev.text));
      if (!replay) { stick = true; scrollDown(true); }
      break;
    }
    case 'delta':
      onDelta(ev.text);
      break;
    case 'text': {
      if (ev.sub) { add(el('div', 'msg text sub')).innerHTML = md(ev.text); break; }
      const target = state.live || add(el('div', 'msg text'));
      target.innerHTML = md(ev.text);
      target.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
      endLive();
      break;
    }
    case 'tool_use': {
      endLive();
      if (ev.name === 'AskUserQuestion' || ev.name === 'ExitPlanMode') break; // shown as prompts instead
      const card = toolCard(ev);
      state.tools.set(ev.id, card);
      add(card);
      break;
    }
    case 'tool_result':
      finishTool(ev);
      break;
    case 'image': {
      // Consecutive screenshots share one grid.
      endLive();
      const last = $('messages').lastElementChild;
      const grid = last?.classList.contains('shots') ? last : add(shotGrid());
      grid.append(shotNode(ev));
      scrollDown();
      break;
    }
    case 'perm_done':
      resolvePerm(ev);
      break;
    case 'result': {
      endLive();
      state.tools.forEach((c) => c.classList.contains('running') && c.classList.replace('running', 'ok'));
      const bits = [];
      if (ev.ms) bits.push(`${(ev.ms / 1000).toFixed(ev.ms < 10000 ? 1 : 0)}s`);
      if (ev.turns > 1) bits.push(`${ev.turns} steps`);
      if (!ev.ok && ev.text) add(el('div', 'notice error', `Stopped: ${ev.text.replace(/_/g, ' ')}`));
      if (bits.length) add(el('div', 'meta', bits.join(' · ')));
      break;
    }
    case 'error':
      endLive();
      add(el('div', 'notice error', withUntil(ev)));
      break;
    case 'notice':
      endLive();
      add(el('div', 'notice', withUntil(ev)));
      break;
    case 'text_end':
      // The planner's reply was only a tasks block: drop the empty streaming bubble.
      if (state.live && !state.liveText.replace(/`+/g, '').trim()) state.live.remove();
      else if (state.live) state.live.innerHTML = md(state.liveText.replace(/`{1,3}a?o?2?[-\w]*$/, ''));
      endLive();
      break;
    case 'tasks': {
      endLive();
      const box = el('div', 'task-cards');
      box.append(el('div', 'tc-caption', ev.source === 'reflection'
        ? `Queued ${ev.ids.length} next step${ev.ids.length === 1 ? '' : 's'}`
        : `Queued ${ev.ids.length} task${ev.ids.length === 1 ? '' : 's'}`));
      for (const id of ev.ids) box.append(taskCard(id));
      add(box);
      break;
    }
    case 'reflect': {
      endLive();
      const box = el('div', 'task-cards');
      box.append(el('div', 'tc-caption', ev.text || 'Looking for the next improvements'));
      box.append(taskCard(ev.taskId));
      add(box);
      break;
    }
  }
}

// ---------- permission prompts ----------
function permTitle(req) {
  const i = req.input || {};
  switch (req.tool) {
    case 'Bash': return ['Run this command?', i.description || ''];
    case 'Edit': case 'MultiEdit': return [`Edit ${shortPath(i.file_path)}?`, ''];
    case 'Write': return [`Create or overwrite ${shortPath(i.file_path)}?`, ''];
    case 'WebFetch': return ['Fetch this page?', i.url];
    case 'WebSearch': return ['Search the web?', i.query];
    default: return [`Allow ${req.tool}?`, ''];
  }
}

function permCard(req) {
  endLive();
  const card = el('div', 'perm');
  card.dataset.pid = req.pid;
  const reply = (payload) => {
    send({ t: 'perm_reply', cid: state.cid, pid: req.pid, ...payload });
    card.querySelectorAll('button, input').forEach((b) => (b.disabled = true));
  };

  if (req.tool === 'AskUserQuestion') {
    card.append(el('div', 'ph', 'Claude has a question'));
    const answers = {};
    const qs = req.input?.questions || [];
    for (const q of qs) {
      const box = el('div', 'q');
      box.append(el('div', 'qt', q.question));
      const opts = el('div', 'opts');
      const chosen = new Set();
      const other = el('input', 'other');
      other.type = 'text';
      other.placeholder = 'Or type your own answer';
      const sync = () => {
        const parts = [...chosen];
        if (other.value.trim()) parts.push(other.value.trim());
        answers[q.question] = parts.join(', ');
      };
      for (const o of q.options || []) {
        const b = el('button', 'opt');
        b.type = 'button';
        const t = el('div');
        t.append(el('strong', '', o.label));
        if (o.description) t.append(el('small', '', o.description));
        b.append(t);
        b.onclick = () => {
          if (!q.multiSelect) { chosen.clear(); opts.querySelectorAll('.opt').forEach((x) => x.classList.remove('sel')); other.value = ''; }
          if (chosen.has(o.label)) { chosen.delete(o.label); b.classList.remove('sel'); } else { chosen.add(o.label); b.classList.add('sel'); }
          sync();
        };
        opts.append(b);
      }
      other.oninput = () => {
        if (!q.multiSelect && other.value) { chosen.clear(); opts.querySelectorAll('.opt').forEach((x) => x.classList.remove('sel')); }
        sync();
      };
      box.append(opts, other);
      card.append(box);
    }
    const actions = el('div', 'actions');
    const ok = el('button', 'btn primary', 'Send answers');
    const skip = el('button', 'btn', 'Skip');
    ok.onclick = () => {
      if (qs.some((q) => !answers[q.question])) { ok.textContent = 'Answer each question first'; setTimeout(() => (ok.textContent = 'Send answers'), 1800); return; }
      reply({ decision: 'allow', answers });
    };
    skip.onclick = () => reply({ decision: 'deny', message: 'The user skipped the question. Use your best judgment.' });
    actions.append(ok, skip);
    card.append(actions);
    return card;
  }

  if (req.tool === 'ExitPlanMode') {
    const h = el('div', 'ph', 'Ready to build? Here is Claude\'s plan');
    card.append(h);
    const plan = el('div', 'pbody');
    const inner = el('div', 'plan msg text');
    inner.innerHTML = md(req.input?.plan || '');
    plan.append(inner);
    card.append(plan);
    const actions = el('div', 'actions');
    const go = el('button', 'btn primary', 'Approve & auto-accept edits');
    const goAsk = el('button', 'btn', 'Approve, ask for each edit');
    const fb = el('input');
    fb.type = 'text';
    fb.placeholder = 'Or tell Claude what to change';
    const keep = el('button', 'btn', 'Keep planning');
    go.onclick = () => reply({ decision: 'allow', nextMode: 'acceptEdits' });
    goAsk.onclick = () => reply({ decision: 'allow', nextMode: 'default' });
    keep.onclick = () => reply({ decision: 'deny', message: fb.value.trim() || 'Keep planning. The user wants changes to the plan.' });
    fb.onkeydown = (e) => { if (e.key === 'Enter') keep.click(); };
    actions.append(go, goAsk, fb, keep);
    card.append(actions);
    return card;
  }

  const [title, sub] = permTitle(req);
  const h = el('div', 'ph', title);
  if (sub) h.append(el('small', '', sub));
  card.append(h);
  const body = el('div', 'pbody');
  body.append(toolInputView(req.tool, req.input));
  if (body.childNodes.length) card.append(body);
  const actions = el('div', 'actions');
  const allow = el('button', 'btn primary');
  allow.innerHTML = 'Allow <kbd>↵</kbd>';
  const always = el('button', 'btn', 'Always allow');
  const fb = el('input');
  fb.type = 'text';
  fb.placeholder = 'Or tell Claude what to do instead';
  const deny = el('button', 'btn danger');
  deny.innerHTML = 'Deny <kbd>esc</kbd>';
  allow.onclick = () => reply({ decision: 'allow' });
  always.onclick = () => reply({ decision: 'always' });
  deny.onclick = () => reply({ decision: 'deny', message: fb.value.trim() || undefined });
  fb.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); deny.click(); } };
  actions.append(allow);
  if (req.canAlways) actions.append(always);
  actions.append(fb, deny);
  card.append(actions);
  return card;
}

function showPerm(req) {
  if (state.perms.has(req.pid)) return;
  const card = add(permCard(req));
  state.perms.set(req.pid, card);
  stick = true;
  scrollDown(true);
  if (!('ontouchstart' in window)) card.querySelector('.btn.primary')?.focus({ preventScroll: true });
}
function resolvePerm(ev) {
  const card = state.perms.get(ev.pid);
  state.perms.delete(ev.pid);
  let line;
  if (ev.tool === 'AskUserQuestion' && ev.decision === 'answered') {
    line = el('div', 'resolved');
    const wrap = el('div');
    for (const [q, a] of Object.entries(ev.answers || {})) wrap.append(el('span', 'qa', `${q} → ${a}`));
    line.append(el('span', '', '✓'), wrap);
  } else if (ev.tool === 'ExitPlanMode' && ev.decision !== 'deny' && ev.decision !== 'cancelled') {
    const d = el('details', 'tool ok');
    const s = el('summary');
    s.append(el('span', 'st'), el('span', 'tn', 'Plan approved'), el('span', 'ts', 'show plan'));
    const b = el('div', 'body');
    const inner = el('div', 'plan msg text');
    inner.style.padding = '4px 14px';
    inner.innerHTML = md(ev.input?.plan || '');
    b.append(inner);
    d.append(s, b);
    line = d;
  } else if (ev.decision === 'deny') {
    line = el('div', 'resolved denied', `✗ Denied ${TOOL_LABEL[ev.tool] || ev.tool || ''}`.trim());
  } else if (ev.decision === 'cancelled') {
    line = null;
  } else {
    // Allowed tool calls show up as their own tool card, so the prompt can just disappear.
    line = null;
  }
  if (card) {
    if (line) card.replaceWith(line); else card.remove();
  } else if (line) {
    add(line);
  }
}

// Keyboard shortcuts for the newest open prompt and for interrupting.
document.addEventListener('keydown', (e) => {
  if ($('app').dataset.view !== 'chat') return;
  const cards = [...state.perms.values()];
  const top = cards[cards.length - 1];
  const inField = e.target.matches('input, textarea') && e.target !== $('input');
  if (e.key === 'Escape') {
    if (top && !top.querySelector('.q, .plan')) { e.preventDefault(); top.querySelector('.btn.danger')?.click(); return; }
    if (state.busy) { e.preventDefault(); send({ t: 'interrupt', cid: state.cid }); }
  }
  if (e.key === 'Enter' && top && !inField && e.target !== $('input') && !top.querySelector('.q, .plan')) {
    if (document.activeElement?.closest('.perm') !== top) { e.preventDefault(); top.querySelector('.btn.primary')?.click(); }
  }
});

// ---------- busy indicator ----------
const VERBS = ['Working', 'Thinking', 'Reading', 'Tinkering', 'Building', 'Pondering', 'Crafting'];
let workTimer;
function setBusy(b) {
  state.busy = b;
  $('working').hidden = !b;
  updateSendButton();
  clearInterval(workTimer);
  if (b) {
    state.workingSince = Date.now();
    const verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    const tick = () => {
      const s = Math.floor((Date.now() - state.workingSince) / 1000);
      $('workingText').textContent = `${verb}… ${s}s`;
    };
    tick();
    workTimer = setInterval(tick, 1000);
    scrollDown();
  } else {
    endLive();
  }
}

// ---------- composer ----------
const input = $('input');
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px';
}
function updateSendButton() {
  const stop = state.busy && !input.value.trim();
  $('send').classList.toggle('stop', stop);
  $('send').setAttribute('aria-label', stop ? 'Stop' : 'Send');
  $('send').disabled = !stop && !input.value.trim();
}
input.addEventListener('input', () => {
  autosize();
  updateSendButton();
  store.set('cw.draft.' + (state.cid || 'new'), input.value);
  // An unnamed new project previews the folder name it will get from this message.
  if (!state.cid && state.draft.type === 'new' && !state.draft.name) { updateFolderChip(); updateHeader(); }
});
const coarse = matchMedia('(pointer: coarse)').matches;
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    const next = MODES[(MODES.indexOf($('mode').value) + 1) % MODES.length];
    changeMode(next);
  }
});
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) {
    if (state.busy) send({ t: 'interrupt', cid: state.cid });
    return;
  }
  if (!state.cid) {
    try {
      const d = state.draft;
      const c = await api('/api/convos', 'POST', d.type === 'new'
        ? { newProject: { name: d.name, fromText: text }, mode: state.draftMode }
        : { folder: d.path, mode: state.draftMode });
      state.draft = { type: 'new', name: '' }; // the next new chat starts its own project again
      if (!state.convos.find((x) => x.id === c.id)) state.convos.unshift(c);
      openConvo(c.id);
      if (pickVal(parsePick(state.draftModel)) !== 'claude|') send({ t: 'set_model', cid: c.id, ...parsePick(state.draftModel) });
      setAutoPick(state.draftAuto);
    } catch (err) {
      const n = el('div', 'notice error', err.message);
      if (/github/i.test(err.message)) {
        const b = el('button', 'btn small primary', 'Link GitHub');
        b.style.marginLeft = '10px';
        b.onclick = linkGitHub;
        n.append(b);
      }
      add(n);
      return;
    }
  }
  if (!send({ t: 'send', cid: state.cid, text, autoDelegate: autoPick() })) {
    // Keep the text (under this chat's draft key, which reconnect restores) rather than lose it.
    store.set('cw.draft.' + state.cid, input.value);
    add(el('div', 'notice error', 'Not connected, reconnecting. Your message was kept.'));
    return;
  }
  input.value = '';
  store.set('cw.draft.' + state.cid, '');
  store.set('cw.draft.new', '');
  autosize();
  updateSendButton();
});
$('messages').addEventListener('click', (e) => {
  if (e.target.closest('[data-open-picker]')) openPicker();
  const r = e.target.closest('.recent-projects button[data-path]');
  if (r) chooseFolder(r.dataset.path);
});

function changeMode(mode) {
  setModeUI(mode);
  if (state.cid) send({ t: 'set_mode', cid: state.cid, mode });
  else { state.draftMode = mode; store.set('cw.mode', mode); }
}
$('mode').addEventListener('change', () => changeMode($('mode').value));
$('model').addEventListener('change', () => {
  const v = $('model').value;
  if (v === CONNECT_PICK) { $('model').value = autoPick() ? AUTO_PICK : $('model').dataset.prev || 'claude|'; openConnections(); return; }
  if (v === AUTO_PICK) { setAutoPick(true); return; }
  setAutoPick(false);
  $('model').dataset.prev = v;
  if (state.cid) send({ t: 'set_model', cid: state.cid, ...parsePick(v) });
  else { state.draftModel = v; store.set('cw.model', v); }
  renderConnFoot();
});

// ---------- agent + model picker (options come from the server's agent registry) ----------
let AGENT_LIST = [];
// A model's display name as its CLI reports it (the id when the agent's list doesn't name it).
const modelLabel = (agent, id) => AGENT_LIST.find((a) => a.id === agent)?.models.find((m) => m.id === id || m.resolved === id)?.label || id;
const CONNECT_PICK = '__connect'; // the picker's last option: opens the Connections window
// The picker's first option: agent-orch may move this chat's queued tasks to a comparable model with usage left
// (BRIEF goal 8). It is a per-chat flag sent with each message; the chat keeps its agent/model as the starting point.
// Any specific model pins the tasks to it.
const AUTO_PICK = '__auto';
const autoPick = () => (state.cid ? store.get('cw.auto.' + state.cid) === '1' : state.draftAuto);
function setAutoPick(on) {
  if (state.cid) store.set('cw.auto.' + state.cid, on ? '1' : '0');
  else { state.draftAuto = on; store.set('cw.auto', on ? '1' : '0'); }
  const sel = $('model');
  sel.value = on ? AUTO_PICK : sel.dataset.prev || 'claude|';
  renderPickChip();
}
// The composer chip: "Auto" or the model this chat's tasks are pinned to.
function renderPickChip() {
  const c = $('pickChip');
  if (!c) return;
  const { agent, model } = parsePick($('model').dataset.prev || 'claude|');
  const auto = autoPick();
  c.classList.toggle('auto', auto);
  c.textContent = auto ? 'Auto' : model ? modelLabel(agent, model) : shortLabel(agent);
  c.title = auto ? `Auto Delegate: queued tasks may move to a comparable model with usage left (starts on ${model ? modelLabel(agent, model) : shortLabel(agent)})`
    : 'Pinned: tasks from this chat stay on this model';
}
const pickVal = ({ agent, model }) => `${agent || 'claude'}|${model || ''}`;
const parsePick = (v) => (v.includes('|') ? { agent: v.slice(0, v.indexOf('|')), model: v.slice(v.indexOf('|') + 1) } : { agent: 'claude', model: v });
const shortLabel = (agent) => (AGENT_LIST.find((a) => a.id === agent)?.label || agent).replace(/ (Code|CLI)$/, '');
function setPick(v) {
  const sel = $('model'), val = pickVal(parsePick(v || ''));
  if (![...sel.options].some((o) => o.value === val)) {
    const { agent, model } = parsePick(val);
    const o = el('option', '', model ? `${shortLabel(agent)} · ${modelLabel(agent, model)}` : shortLabel(agent));
    o.value = val;
    sel.append(o);
  }
  sel.dataset.prev = val;
  sel.value = autoPick() ? AUTO_PICK : val;
  renderPickChip();
}
function renderAgentPicker() {
  const sel = $('model'), keep = sel.dataset.prev || sel.value;
  sel.textContent = '';
  const auto = el('option', '', 'Auto Delegate');
  auto.value = AUTO_PICK;
  auto.title = 'agent-orch picks, and may reassign to a comparable model with usage left while this message\'s tasks wait';
  sel.append(auto);
  for (const a of AGENT_LIST) {
    const g = document.createElement('optgroup');
    g.label = !a.available ? `${a.label} (not installed)` : a.loggedIn === false ? `${a.label} (sign in via Connections)` : a.label;
    g.disabled = !(a.available && a.loggedIn !== false);
    const def = el('option', '', `${a.label} · default model`);
    def.value = pickVal({ agent: a.id });
    g.append(def);
    for (const m of a.models) {
      const o = el('option', '', `${shortLabel(a.id)} · ${m.label}${m.default ? ' (default)' : ''}`);
      o.value = pickVal({ agent: a.id, model: m.id });
      if (m.description) o.title = m.description;
      g.append(o);
    }
    // Only real models from the CLI: when there are none, say why instead of guessing.
    if (!a.models.length && a.available) {
      const why = a.loggedIn === false || a.modelsError === 'not signed in' ? 'Sign in to load models'
        : a.modelsError === 'loading' ? 'Loading models…' : `Couldn't load models: ${a.modelsError || 'none listed'}`;
      const o = el('option', '', why);
      o.disabled = true;
      o.value = `__note:${a.id}`;
      g.append(o);
    }
    sel.append(g);
  }
  const off = AGENT_LIST.filter((a) => !a.available || a.loggedIn === false).length;
  const link = el('option', '', off ? 'Sign in to more agents…' : 'Connections…');
  link.value = CONNECT_PICK;
  sel.append(link);
  setPick(keep);
}
api('/api/agents').then((d) => { AGENT_LIST = d.agents || []; renderAgentPicker(); }).catch(() => {});
// "codex · gpt-5-codex": the agent and model a task last ran on (or was assigned).
function agentBadge(t) {
  const agent = t.ran_agent || t.agent, model = t.ran_model || t.model;
  if (!agent && !model) return null;
  const b = el('span', 'tc-tag agent', [agent || 'claude', model].filter(Boolean).join(' · '));
  b.title = t.ran_agent ? 'Agent and model it ran on' : 'Agent and model it will run on';
  if (t.route_note) { b.classList.add('warn'); b.title += ` — ${t.route_note}`; }
  if (t.delegated_from) { b.textContent = `↪ ${b.textContent}`; b.title += ` — delegated from ${t.delegated_from}${t.delegated_reason ? `: ${t.delegated_reason}` : ''}`; }
  return b;
}
// "delegated from claude/opus": shown next to the agent badge.
function delegatedBadge(t) {
  if (!t.delegated_from) return null;
  const b = el('span', 'tc-tag deleg', `delegated from ${t.delegated_from}`);
  b.title = t.delegated_reason || '';
  return b;
}

// ---------- project picker ----------
const FOLDER_ICON = '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const pk = { projects: [], kb: -1, browsePath: null, lastFocus: null };

// Picking a project for a chat that already exists starts a new chat there;
// a chat's folder can't change because Claude's session history lives with it.
function applyDraft(draft) {
  state.draft = draft;
  closePicker();
  if (state.cid) openConvo(null);
  updateFolderChip();
  updateHeader();
  input.focus();
}
// One chat per project: an existing project opens its chat instead of starting another.
const chooseFolder = (p) => {
  const existing = state.convos.find((c) => c.cwd === p);
  if (existing) { closePicker(); openConvo(existing.id); setView('chat'); return; }
  applyDraft({ type: 'folder', path: p });
};
const chooseNew = (name) => applyDraft({ type: 'new', name: name.trim() });

function projectMeta(p) {
  const bits = [];
  if (p.chats) bits.push(`${p.chats} chat${p.chats > 1 ? 's' : ''}`);
  bits.push(p.items ? `${p.items} item${p.items > 1 ? 's' : ''}` : 'empty');
  if (p.lastUsed || p.mtime) bits.push(`active ${relTime(p.lastUsed || p.mtime)}`);
  return bits.join(' · ');
}
function pkItem(f, { meta, onOpen, onUse, current, create }) {
  const row = el('div', 'pk-item' + (current ? ' current' : '') + (create ? ' create' : ''));
  row.setAttribute('role', 'option');
  row.tabIndex = -1;
  const icon = el('span', 'fi');
  icon.innerHTML = create ? '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>' : FOLDER_ICON;
  const main = el('span', 'fm');
  main.append(el('span', 'fn', f.name), el('span', 'fd', meta));
  row.append(icon, main);
  if (f.kind) row.append(el('span', 'tag', f.kind));
  if (f.git) row.append(el('span', 'tag', 'git'));
  if (onOpen && onUse) {
    const use = el('button', 'use', 'Use');
    use.type = 'button';
    use.onclick = (e) => { e.stopPropagation(); onUse(); };
    row.append(use);
  }
  if (onOpen) { const go = el('span', 'go'); go.innerHTML = CHEVRON; row.append(go); }
  row.onclick = onOpen || onUse;
  row.dataset.act = '1';
  return row;
}

async function loadProjects() {
  try { pk.projects = (await api('/api/projects')).projects; } catch { pk.projects = []; }
  return pk.projects;
}
// First row is always "new project": named from the typed text, or from the first message when
// the box is empty. Below it, existing projects that match what's typed.
function renderProjectList() {
  const raw = $('pkSearch').value.trim();
  const q = raw.toLowerCase();
  const slug = slugify(raw);
  const list = $('pkList');
  list.textContent = '';
  const current = currentConvo()?.cwd || (state.draft.type === 'folder' ? state.draft.path : null);
  const shown = pk.projects.filter((p) => !q || p.name.toLowerCase().includes(q) || (slug && p.name.includes(slug)));
  const exact = slug && pk.projects.some((p) => p.name === slug);
  if (!exact) {
    const fromMsg = slugify($('input').value, true);
    list.append(pkItem(
      { name: raw ? `Create "${slug || raw}"` : 'New project' },
      {
        create: true,
        meta: raw ? `~/workspace/${slug}` : fromMsg ? `Named from your message: ${fromMsg}` : 'Named from your first message',
        onUse: () => chooseNew(raw),
      },
    ));
  }
  for (const p of shown) {
    list.append(pkItem(p, { meta: projectMeta(p), onUse: () => chooseFolder(p.path), current: p.path === current }));
  }
  // Enter picks the top row without needing the arrow keys first.
  pk.kb = 0;
  list.querySelector('.pk-item')?.classList.add('kb');
}

async function openPicker() {
  renderGhRow();
  refreshGitHub().then(renderGhRow);
  pk.lastFocus = document.activeElement;
  closeSidebar();
  const note = $('pickerNote');
  const c = currentConvo();
  note.hidden = !c;
  if (c) note.innerHTML = `Picking a project starts a new chat. This one stays in <code>${tilde(c.cwd)}</code>.`;
  $('pickerTitle').textContent = 'Choose a project';
  $('pkProjects').hidden = false;
  $('pkBrowse').hidden = true;
  $('pkSearch').value = state.draft.type === 'new' ? state.draft.name : '';
  $('pickerModal').hidden = false;
  $('pkSearch').focus();
  renderProjectList();
  await loadProjects();
  renderProjectList();
}
function closePicker() {
  if ($('pickerModal').hidden) return;
  $('pickerModal').hidden = true;
  pk.lastFocus?.focus?.();
}

async function browse(dir) {
  $('pkProjects').hidden = true;
  $('pkBrowse').hidden = false;
  $('pickerTitle').textContent = 'Choose a folder';
  const list = $('pkBrowseList');
  list.textContent = '';
  list.append(el('div', 'pk-empty', 'Loading…'));
  let d;
  try { d = await api(`/api/folders?path=${encodeURIComponent(dir || '')}`); } catch (e) { list.textContent = e.message; return; }
  pk.browsePath = d.path;
  const crumbs = $('pkCrumbs');
  crumbs.textContent = '';
  d.crumbs.forEach((c, i) => {
    if (i) crumbs.append(el('span', 'sep', '/'));
    const b = el('button', '', c.name);
    b.type = 'button';
    b.onclick = () => browse(c.path);
    crumbs.append(b);
  });
  list.textContent = '';
  pk.kb = -1;
  for (const f of d.folders) {
    const meta = `${f.items ? `${f.items} item${f.items > 1 ? 's' : ''}` : 'empty'} · changed ${relTime(f.mtime)}`;
    list.append(pkItem(f, { meta, onOpen: () => browse(f.path), onUse: () => chooseFolder(f.path) }));
  }
  if (!d.folders.length) list.append(el('div', 'pk-empty', 'No folders inside this one.'));
  const here = d.path === d.home ? '~' : tilde(d.path);
  $('pkUseHere').textContent = `Use ${here.length > 28 ? '…' + here.slice(-26) : here}`;
  $('pkUseHere').disabled = d.path === d.home; // the whole home folder is too broad
  $('pkUseHere').title = d.path === d.home ? 'Pick a folder inside your home folder' : '';
}

$('folderBtn').addEventListener('click', openPicker);
$('pickerModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closePicker(); });
$('pkSearch').addEventListener('input', renderProjectList);
$('pkBrowseBtn').addEventListener('click', () => browse(state.workspace));
$('pkBack').addEventListener('click', () => {
  $('pickerTitle').textContent = 'Choose a project';
  $('pkBrowse').hidden = true;
  $('pkProjects').hidden = false;
  $('pkSearch').focus();
});
$('pkUseHere').addEventListener('click', () => chooseFolder(pk.browsePath));

// Arrow keys move through the visible list; Enter picks (projects) or opens (browse).
$('pickerModal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); return; }
  const list = $('pkBrowse').hidden ? $('pkList') : $('pkBrowseList');
  const rows = [...list.querySelectorAll('.pk-item')];
  if (!rows.length || !['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
  if (e.key === 'Enter') {
    if (e.target.closest('form')) return;
    // Enter in the search box picks the top match.
    const idx = pk.kb >= 0 ? pk.kb : e.target === $('pkSearch') ? 0 : -1;
    if (idx < 0) return;
    e.preventDefault();
    rows[idx].click();
    return;
  }
  e.preventDefault();
  pk.kb = Math.max(0, Math.min(rows.length - 1, pk.kb + (e.key === 'ArrowDown' ? 1 : -1)));
  rows.forEach((r, i) => r.classList.toggle('kb', i === pk.kb));
  rows[pk.kb].scrollIntoView({ block: 'nearest' });
}, true);

// Quick picks under "What should we build?"
async function renderRecentProjects() {
  const box = document.querySelector('.recent-projects');
  if (!box) return;
  updateFolderChip();
  const projects = (await loadProjects()).slice(0, 5);
  if (!projects.length || !document.body.contains(box)) return;
  box.textContent = '';
  box.append(el('span', 'lbl', 'or continue a recent project'));
  for (const p of projects) {
    const b = el('button');
    b.type = 'button';
    b.dataset.path = p.path;
    b.innerHTML = FOLDER_ICON.replace('width="17" height="17"', 'width="13" height="13"');
    b.append(document.createTextNode(p.name));
    box.append(b);
  }
}

// ---------- WebSocket ----------
let retry = 0; // failed attempts since the last open: 0 before the first open reads as "Connecting…"
const CONN = { list: [], sig: '', drafts: {}, sent: {}, dismissed: {}, justDone: {}, lastFocus: null };
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    retry = 0;
    renderConnFoot();
    send({ t: 'open', cid: state.cid });
    pollUpdates();
    refreshConnections();
    if (!$('serverModal').hidden) send({ t: 'metrics_sub', on: true });
    if (O.drawer) { send({ t: 'owatch', taskId: O.drawer, on: true }); loadDetail(); }
  };
  ws.onclose = (e) => {
    updateLive();
    if (e.code === 4001) { location.href = '/login'; return; }
    // A failed upgrade usually means the login expired; check before retrying.
    fetch('/api/status').then((r) => { if (r.status === 401) location.href = '/login'; }).catch(() => {});
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
    renderConnFoot();
  };
  ws.onmessage = (m) => onServer(JSON.parse(m.data));
}
function send(msg) {
  if (state.ws?.readyState !== 1) return false;
  state.ws.send(JSON.stringify(msg));
  return true;
}

function onServer(msg) {
  if (msg.t === 'mtick' || msg.t === 'mhist' || msg.t === 'mdetail' || msg.t === 'usage') return onMetrics(msg);
  if (['otask', 'oproject', 'ostate', 'orun'].includes(msg.t)) return onOrch(msg);
  if (msg.t === 'connections') return applyConnections(msg.connections);
  if (msg.t === 'models') return api('/api/agents').then((d) => { AGENT_LIST = d.agents || []; renderAgentPicker(); }).catch(() => {});
  if (msg.t === 'status') { upd.pending = !!msg.restartPending; return renderUpdateBanner(); }
  if (msg.t === 'convos') {
    state.convos = msg.convos;
    if (state.cid && !state.convos.find((c) => c.id === state.cid)) openConvo(null);
    renderConvoList();
    updateFolderChip();
    updateHeader();
    return;
  }
  if (msg.cid && msg.cid !== state.cid) return;
  switch (msg.t) {
    case 'history': {
      applyOrchSnapshot(msg.orch);
      resetMessages();
      if (!msg.events.length) { $('messages').append($('emptyTpl').content.cloneNode(true)); renderRecentProjects(); }
      for (const ev of msg.events) renderEvent(ev, true);
      // Tool calls still running from before a reload.
      for (const req of msg.pending) showPerm(req);
      setBusy(msg.busy);
      setModeUI(msg.mode || 'default');
      setPick(pickVal(msg));
      renderConnFoot();
      input.value = store.get('cw.draft.' + state.cid) || '';
      autosize();
      updateSendButton();
      stick = true;
      scrollDown(true);
      break;
    }
    case 'busy':
      setBusy(msg.busy);
      break;
    case 'perm':
      showPerm(msg);
      break;
    case 'mode':
      setModeUI(msg.mode);
      break;
    case 'osnapshot':
      applyOrchSnapshot(msg.orch);
      break;
    case 'model':
      setPick(pickVal(msg));
      renderConnFoot();
      break;
    case 'init':
      break;
    default:
      renderEvent(msg, false);
  }
}

// ---------- status / boot ----------
async function checkStatus() {
  try {
    const s = await api('/api/status');
    state.workspace = s.workspace;
    $('hostName').textContent = s.host;
    $('loginBanner').hidden = s.claudeSignedIn;
    const a = s.claudeAuth || {};
    if (!s.claudeSignedIn) {
      $('loginBanner').querySelector('span').innerHTML = a.loggedIn
        ? '<strong>Chat is paused: Claude Code is signed in with an API key, which bills separately.</strong> Run <code>/login</code> in the terminal and choose your Claude account.'
        : "<strong>Claude Code isn't signed in on this server yet.</strong> Open a terminal, run <code>claude</code> and sign in with your Claude account once. Chat works after that.";
    }
    applyUpdateStatus(s);
    updateFolderChip();
    updateHeader();
    if (!s.claudeSignedIn) setTimeout(checkStatus, 8000);
  } catch {}
}

// The server's checkout moved on since it booted (or a restart is queued): offer to restart once idle.
const upd = { commits: 0, pending: false, dismissed: Number(store.get('cw.updDismissed')) || 0 };
function applyUpdateStatus(s) {
  upd.commits = s.commitsSinceBoot || 0;
  upd.pending = !!s.restartPending;
  if (upd.commits < upd.dismissed) { upd.dismissed = 0; store.set('cw.updDismissed', '0'); } // a restart reset the count
  renderUpdateBanner();
}
async function pollUpdates() { try { applyUpdateStatus(await api('/api/status')); } catch {} }
function renderUpdateBanner() {
  const draining = upd.pending || !!O.state?.draining;
  $('updateBanner').hidden = !draining && (!upd.commits || upd.commits <= upd.dismissed);
  $('updateText').textContent = draining ? 'Restarting after running tasks finish…'
    : `${upd.commits} new commit${upd.commits === 1 ? '' : 's'} since the server started`;
  $('updateRestart').hidden = draining;
  $('updateRestart').disabled = false;
  $('updateDismiss').hidden = draining;
}

// ---------- server metrics ----------
const M = {
  latest: null,       // newest 3 s sample, for the big numbers and the sidebar
  series: null,       // chart data for the chosen range
  range: store.get('cw.range') in { '15m': 1, '1h': 1, '6h': 1, '24h': 1, '7d': 1, all: 1 } ? store.get('cw.range') : '1h',
  sampleMs: 3000,
  data: null, built: false, draws: [], lastTick: 0, usage: null,
};

const fmtBytes = (b, digits = 1) => {
  if (b == null || isNaN(b)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i === 0 ? 0 : b < 10 ? digits : 0)} ${u[i]}`;
};
const fmtRate = (b) => `${fmtBytes(b)}/s`;
const fmtPct = (p) => `${Math.round(p)}%`;
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function level(pct, warnAt = 75, critAt = 90) {
  if (pct >= critAt) return ['crit', 'High'];
  if (pct >= warnAt) return ['warn', 'Busy'];
  return ['', 'Normal'];
}
const REGION_NAMES = { 'ap-mumbai-1': 'Mumbai', 'ap-hyderabad-1': 'Hyderabad', 'us-ashburn-1': 'Ashburn', 'us-phoenix-1': 'Phoenix', 'eu-frankfurt-1': 'Frankfurt', 'uk-london-1': 'London', 'ap-singapore-1': 'Singapore', 'ap-tokyo-1': 'Tokyo' };

// ----- stored history for the charts -----
const RANGE_MS = { '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 864e5, all: 0 };
const RANGE_AGO = { '15m': '15 min ago', '1h': '1 hour ago', '6h': '6 hours ago', '24h': '24 hours ago', '7d': '7 days ago' };
function chartWindow() {
  const s = M.series;
  const end = Date.now();
  const rangeMs = RANGE_MS[M.range];
  return { start: rangeMs ? end - rangeMs : Math.min(s?.earliest ?? end, s?.points[0]?.t ?? end), end };
}
async function loadHistory(animate = false) {
  const range = M.range;
  const lines = [...document.querySelectorAll('#mGrid .sline')];
  if (animate) lines.forEach((l) => { l.classList.remove('reveal'); l.classList.add('switching'); });
  const started = Date.now();
  try {
    const d = await api(`/api/metrics/history?range=${range}`);
    if (range !== M.range) return; // a newer range was picked meanwhile
    d.points.forEach((p) => (p.n = 1));
    if (animate) await new Promise((r) => setTimeout(r, Math.max(0, 220 - (Date.now() - started)))); // let the fade finish
    M.series = d;
    renderMetrics();
  } catch {}
  if (animate) {
    lines.forEach((l) => { l.classList.remove('switching'); void l.offsetWidth; l.classList.add('reveal'); });
    setTimeout(() => lines.forEach((l) => l.classList.remove('reveal')), 800);
  }
}
// Fold each live sample into the chart: a new point, or averaged into the latest one
// when the range is long enough that points cover more than one sample.
function appendLive(s) {
  const d = M.series;
  if (!d) return;
  const last = d.points[d.points.length - 1];
  if (last && s.t <= last.t) return;
  if (last && s.t - last.t < d.bucketMs && last.n) {
    const n = last.n + 1;
    for (const k of Object.keys(s)) if (k !== 't') last[k] = (last[k] * last.n + s[k]) / n;
    last.n = n;
    last.t = s.t;
  } else {
    d.points.push({ ...s, n: 1 });
  }
  const { start } = chartWindow();
  while (d.points.length > 2 && d.points[0].t < start) d.points.shift();
}

// A single-series chart with a hover crosshair, plotted by time across the chosen range.
function sparkline(host, get, fmt, fixedMax) {
  host.className = 'sline';
  host.innerHTML = '<svg aria-hidden="true"><line class="base"/><path class="area"/><path class="line" pathLength="1"/><line class="cross" hidden/><circle class="pt" r="4" hidden/></svg><div class="tip" hidden></div>';
  const svg = host.querySelector('svg');
  const [base, area, line, cross, pt] = svg.children;
  const tip = host.querySelector('.tip');
  const label = el('div', 'sline-label');
  const [lFrom, lStat, lNow] = [el('span'), el('span', 'stat'), el('span', '', 'now')];
  label.append(lFrom, lStat, lNow);
  host.after(label);
  let hoverX = null;
  function draw() {
    const pts = M.series?.points || [];
    const w = host.clientWidth, h = host.clientHeight;
    const { start, end } = chartWindow();
    lFrom.textContent = RANGE_AGO[M.range] || new Date(start).toLocaleDateString([], { month: 'short', day: 'numeric' });
    if (!w) return;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    base.setAttribute('x1', 0); base.setAttribute('x2', w); base.setAttribute('y1', h - 0.5); base.setAttribute('y2', h - 0.5);
    if (pts.length < 2) { line.setAttribute('d', ''); area.setAttribute('d', ''); lStat.textContent = pts.length ? '' : 'collecting…'; return; }
    const vals = pts.map(get);
    const top = fixedMax || Math.max(1024, ...vals) * 1.2;
    const span = Math.max(1, end - start);
    const x = (t) => ((t - start) / span) * w;
    const y = (v) => h - 1 - Math.min(v / top, 1) * (h - 6);
    // Break the line where the server was down instead of drawing a straight bridge.
    const gap = Math.max(M.series.bucketMs * 3, 30e3);
    let d = '', runStart = 0, areaD = '';
    const closeRun = (i) => { if (i > runStart) areaD += `L${x(pts[i - 1].t).toFixed(1)},${h}L${x(pts[runStart].t).toFixed(1)},${h}Z`; };
    pts.forEach((p, i) => {
      const brk = i === 0 || p.t - pts[i - 1].t > gap;
      if (brk && i) { closeRun(i); runStart = i; }
      const seg = `${brk ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(vals[i]).toFixed(1)}`;
      d += seg;
      areaD += seg;
    });
    closeRun(pts.length);
    line.setAttribute('d', d);
    area.setAttribute('d', areaD);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    lStat.textContent = `avg ${fmt(avg)} · peak ${fmt(Math.max(...vals))}`;
    if (hoverX == null) { cross.setAttribute('hidden', ''); pt.setAttribute('hidden', ''); tip.hidden = true; return; }
    const tHover = start + (hoverX / w) * span;
    let i = 0;
    for (let k = 1; k < pts.length; k++) if (Math.abs(pts[k].t - tHover) < Math.abs(pts[i].t - tHover)) i = k;
    const cx = x(pts[i].t), cy = y(vals[i]);
    cross.removeAttribute('hidden'); pt.removeAttribute('hidden');
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('y1', 0); cross.setAttribute('y2', h);
    pt.setAttribute('cx', cx); pt.setAttribute('cy', cy);
    tip.hidden = false;
    const when = new Date(pts[i].t);
    const long = span > 24 * 3600e3;
    tip.textContent = `${fmt(vals[i])} · ${long ? when.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' : ''}${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: long ? undefined : '2-digit' })}`;
    tip.style.left = `${Math.max(70, Math.min(w - 70, cx))}px`;
  }
  host.addEventListener('pointermove', (e) => { hoverX = e.clientX - host.getBoundingClientRect().left; draw(); });
  host.addEventListener('pointerleave', () => { hoverX = null; draw(); });
  M.draws.push(draw);
}

function tile(id, title, { bar, spark, pair } = {}) {
  const card = el('div', 'm-card');
  card.id = `t-${id}`;
  const top = el('div', 'tile-top');
  top.append(el('h3', '', title), el('span', 'status'));
  card.append(top);
  if (pair) {
    const p = el('div', 'pair');
    for (const [k, label] of pair) {
      const col = el('div');
      col.append(el('div', 'detail', label));
      const big = el('div', 'big'); big.dataset.k = k;
      col.append(big);
      p.append(col);
    }
    card.append(p);
  } else {
    card.append(el('div', 'big'));
  }
  if (bar) { const b = el('div', 'bar'); b.append(el('i')); card.append(b); }
  card.append(el('div', 'detail'));
  if (spark) { const s = el('div'); card.append(s); sparkline(s, ...spark); }
  return card;
}
function buildMetrics() {
  if (M.built) return;
  M.built = true;
  const g = $('mGrid');
  g.append(
    tile('cpu', 'CPU', { spark: [(h) => h.cpu, fmtPct, 100] }),
    tile('mem', 'Memory', { bar: true, spark: [(h) => h.mem, fmtPct, 100] }),
    tile('disk', 'Disk ( / )', { bar: true }),
    tile('net', 'Network', { pair: [['rx', 'Download'], ['tx', 'Upload']], spark: [(h) => h.rx + h.tx, fmtRate] }),
    tile('io', 'Disk activity', { pair: [['dr', 'Read'], ['dw', 'Write']], spark: [(h) => h.dr + h.dw, fmtRate] }),
    tile('load', 'Load average'),
  );
  let resizeTimer;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => M.draws.forEach((d) => d()), 100); });
}

// Swaps a number with a quick blur: the old value blurs out, the new one sharpens in.
// Only runs when the shown text actually changes.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function tween(node, value, fmt, force) {
  if (!node) return;
  node._cur = value;
  blurSwap(node, fmt(value), force);
}
// `force` plays the blur even when the text is unchanged, to show a refresh landed.
function blurSwap(node, text, force) {
  if (!node) return;
  if (!force && (node._next === text || (!node._next && node.textContent === text))) return;
  node._next = text;
  clearTimeout(node._swap);
  if (!node.textContent || node.textContent === '–' || reduceMotion.matches) {
    node.textContent = text;
    node._next = null;
    return;
  }
  node.classList.remove('blur-in');
  node.classList.add('blur-out');
  node._swap = setTimeout(() => {
    node.textContent = text;
    node._next = null;
    node.classList.remove('blur-out');
    void node.offsetWidth; // restart the animation
    node.classList.add('blur-in');
  }, 140);
}

function setTile(id, { num, bigSmall, status, detail, bar, pair }) {
  const t = $(`t-${id}`);
  if (!t) return;
  if (num) {
    const b = t.querySelector(':scope > .big');
    if (!b._num) {
      b.textContent = '';
      b._num = el('span', 'n');
      b._small = el('small');
      b.append(b._num, b._small);
    }
    tween(b._num, num[0], num[1]);
    b._small.textContent = bigSmall || '';
  }
  if (pair) for (const [k, [v, f]] of Object.entries(pair)) tween(t.querySelector(`.big[data-k="${k}"]`), v, f);
  const st = t.querySelector('.status');
  if (st) { st.className = 'status' + (status?.[0] ? ' ' + status[0] : ''); st.textContent = status?.[1] || ''; }
  if (detail != null) t.querySelector(':scope > .detail').innerHTML = detail;
  if (bar != null) t.querySelector('.bar i').style.width = `${Math.min(100, bar)}%`;
}

function renderMetrics() {
  const d = M.data;
  if (!d) { M.draws.forEach((fn) => fn()); return; }
  const now = M.latest || {};
  const inst = d.instance;
  $('mDevice').textContent = d.device;
  $('mSub').textContent = [
    inst ? `${inst.shape} · ${inst.ocpus} OCPU · ${inst.memoryGB} GB RAM` : null,
    inst ? `${REGION_NAMES[inst.region] || inst.region} (${inst.region})` : null,
    `${d.os} · ${d.arch}`,
    `up ${fmtUptime(d.uptime)}`,
  ].filter(Boolean).join('  ·  ');

  setTile('cpu', {
    num: [now.cpu || 0, fmtPct],
    status: level(now.cpu || 0),
    detail: `${d.cpu.cores} vCPU · ${d.cpu.model}<br>Steal <b>${(now.steal || 0).toFixed(1)}%</b> · I/O wait <b>${(now.iowait || 0).toFixed(1)}%</b>`,
  });
  const memPct = (d.mem.used / d.mem.total) * 100;
  setTile('mem', {
    num: [d.mem.used, fmtBytes], bigSmall: `of ${fmtBytes(d.mem.total)}`,
    status: level(memPct), bar: memPct,
    detail: `Available <b>${fmtBytes(d.mem.available)}</b> · cache ${fmtBytes(d.mem.cached)} · swap ${d.mem.swapTotal ? fmtBytes(d.mem.swapUsed) + ' used' : 'none'}`,
  });
  const diskPct = (d.disk.used / d.disk.total) * 100;
  const [dcls, dword] = level(diskPct, 80, 92);
  setTile('disk', {
    num: [d.disk.used, fmtBytes], bigSmall: `of ${fmtBytes(d.disk.total)}`,
    status: [dcls, dcls ? (dcls === 'crit' ? 'Almost full' : 'Filling up') : 'Plenty free'], bar: diskPct,
    detail: `<b>${fmtBytes(d.disk.free)}</b> free · ${fmtPct(diskPct)} used`,
  });
  setTile('net', {
    pair: { rx: [now.rx || 0, fmtRate], tx: [now.tx || 0, fmtRate] },
    status: ['', ''],
    detail: `Since boot on ${d.net.iface}: ↓ <b>${fmtBytes(d.net.rxTotal)}</b> · ↑ <b>${fmtBytes(d.net.txTotal)}</b>${inst?.bandwidthGbps ? ` · ${inst.bandwidthGbps} Gbps link` : ''}`,
  });
  setTile('io', { pair: { dr: [now.dr || 0, fmtRate], dw: [now.dw || 0, fmtRate] }, status: ['', ''], detail: 'Reads and writes on the boot volume' });
  const loadPct = (d.cpu.load[0] / d.cpu.cores) * 100;
  setTile('load', {
    num: [d.cpu.load[0], (v) => v.toFixed(2)],
    status: level(loadPct, 80, 150),
    detail: `5 min <b>${d.cpu.load[1].toFixed(2)}</b> · 15 min <b>${d.cpu.load[2].toFixed(2)}</b><br>${d.cpu.cores} vCPU, so 1.00 means fully busy · ${d.procs.total} processes`,
  });

  const tb = $('mTop').querySelector('tbody');
  tb.textContent = '';
  for (const p of d.top) {
    const tr = el('tr');
    tr.append(el('td', '', p.name), el('td', 'num', `${p.cpu.toFixed(1)}%`), el('td', 'num', fmtBytes(p.rss)));
    tb.append(tr);
  }

  M.draws.forEach((fn) => fn());
}

function setBar(bar, pct) {
  bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  bar.className = pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '';
}
function renderMini() {
  const now = M.latest;
  if (!now) return;
  tween($('miniCpu'), now.cpu, fmtPct);
  setBar($('miniCpuBar'), now.cpu);
  tween($('miniMem'), now.mem, fmtPct);
  setBar($('miniMemBar'), now.mem);
}

// ----- plan usage -----
function fmtReset(iso) {
  if (!iso) return '';
  const t = new Date(iso), mins = Math.round((t - Date.now()) / 60e3);
  if (mins <= 0) return 'resetting now';
  if (mins < 60) return `resets in ${mins}m`;
  if (mins < 24 * 60) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `resets ${t.toLocaleDateString([], { weekday: 'short' })} ${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
// `fresh` is true when new numbers just arrived from the server, so they blur in even if unchanged.
// "11:40 PM · in 2h 9m", or "Mon 8:30 PM · in 3d 4h" when it's not today.
function fmtResetAt(iso, now = Date.now()) {
  const t = new Date(iso), secs = (t - now) / 1000;
  if (!(secs > 0)) return 'now';
  const clock = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = t.toDateString() === new Date(now).toDateString() ? '' : `${t.toLocaleDateString([], { weekday: 'short' })} `;
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  return `${day}${clock} · in ${d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`}`;
}
// A notice's {until} (epoch s from the server) in this browser's timezone: "Fri 1:50 PM (in 5h 30m)".
// Replayed notices whose time has passed show just the absolute time ("Thu 3:10 PM"), never "now".
function fmtUntil(until, now = Date.now()) {
  const t = new Date(until * 1000);
  if (t - now > 0) return fmtResetAt(t, now).replace(/^(.+) · (.+)$/, '$1 ($2)');
  return `${t.toLocaleDateString([], { weekday: 'short' })} ${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
function withUntil(ev) {
  return ev.until ? ev.text.replace('{until}', fmtUntil(ev.until)) : ev.text;
}
function renderUsage(fresh = false) {
  const u = M.usage;
  const planName = u?.plan ? `Claude ${u.plan[0].toUpperCase()}${u.plan.slice(1)}` : 'Claude';
  $('usageCard').title = `${planName} limits · open usage over time`;
  const show = (key, w) => {
    if (w) tween($(`us${key}`), w.pct, fmtPct, fresh);
    else blurSwap($(`us${key}`), '–');
    setBar($(`us${key}Bar`), w ? w.pct : 0);
    $(`us${key}Row`).title = w ? fmtReset(w.resetsAt) : '';
  };
  show('Session', u?.session);
  show('Weekly', u?.weekly);
  let note;
  if (!u || !u.updatedAt) note = 'Checking plan limits…';
  else if (!u.available) note = u.error ? `Couldn't read limits: ${u.error}` : 'Plan limits unavailable (not signed in with a subscription)';
  else {
    note = [u.session?.resetsAt && `5-hour resets ${fmtResetAt(u.session.resetsAt)}`,
      u.weekly?.resetsAt && `Weekly resets ${fmtResetAt(u.weekly.resetsAt)}`].filter(Boolean).join('\n');
    // Only speak up about extra usage when it's switched on, since that is the case that can cost money.
    if (u.extraUsage === true) note += ' ⚠ Extra usage is ON: it can bill beyond your plan';
  }
  blurSwap($('usNote'), note.trim(), fresh);
  renderUsageAge();
}
function renderUsageAge() {
  const u = M.usage;
  if ($('usRefresh').classList.contains('spin')) { blurSwap($('usAge'), 'checking…'); return; }
  if (!u?.updatedAt) { blurSwap($('usAge'), ''); return; }
  const m = Math.floor((Date.now() - u.updatedAt) / 60e3);
  blurSwap($('usAge'), m < 1 ? 'just now' : `${m}m ago`);
  $('usAge').title = `Checked ${new Date(u.updatedAt).toLocaleTimeString()}. Updates every 3 minutes and after each chat reply.`;
}
let refreshGuard;
function setRefreshing(on) {
  const b = $('usRefresh');
  b.classList.toggle('spin', on);
  b.disabled = on;
  clearTimeout(refreshGuard);
  // Never leave the spinner stuck if no answer comes back.
  if (on) refreshGuard = setTimeout(() => setRefreshing(false), 25000);
  renderUsageAge();
}
$('usRefresh').addEventListener('click', () => { setRefreshing(true); send({ t: 'usage_refresh' }); });
setInterval(renderUsageAge, 5000);

// ----- live stream from the server -----
function onMetrics(msg) {
  if (msg.t === 'mtick') {
    if (M.latest && M.latest.t >= msg.s.t) return;
    const first = !M.latest;
    M.latest = msg.s;
    if (msg.sampleMs) M.sampleMs = msg.sampleMs;
    appendLive(msg.s);
    // The first sample after (re)connecting is a catch-up copy, not a fresh fetch.
    if (!first) { M.lastTick = Date.now(); beat(); } else M.lastTick = msg.s.t;
  } else if (msg.t === 'mdetail') {
    M.data = msg.d;
  } else if (msg.t === 'usage') {
    M.usage = msg.usage;
    setRefreshing(false);
    renderUsage(true);
    return;
  }
  renderMini();
  if (!$('serverModal').hidden) renderMetrics();
  updateLive();
}
function beat() {
  for (const dot of document.querySelectorAll('.live-dot')) {
    dot.classList.remove('beat');
    void dot.offsetWidth;
    dot.classList.add('beat');
  }
}
function updateLive() {
  const connected = state.ws?.readyState === 1;
  const age = M.lastTick ? (Date.now() - M.lastTick) / 1000 : Infinity;
  const late = age > (M.sampleMs / 1000) * 2.5;
  const cls = !connected ? 'off' : late ? 'stale' : 'on';
  document.querySelectorAll('.live-dot').forEach((d) => {
    if (d.classList.contains(cls)) return; // leave the dot alone so its pulse animation isn't disturbed
    d.classList.remove('on', 'stale', 'off');
    d.classList.add(cls);
  });
  if ($('serverModal').hidden) return;
  // The pulsing dot shows each update; the label only names the state.
  const text = !connected ? 'Reconnecting…' : late ? 'Waiting for data…' : 'Live';
  if ($('liveText').textContent !== text) $('liveText').textContent = text;
}
setInterval(updateLive, 1000);

// ----- server window -----
let lastFocus = null;
function openServer() {
  closeSidebar();
  lastFocus = document.activeElement;
  buildMetrics();
  $('serverModal').hidden = false;
  send({ t: 'metrics_sub', on: true });
  renderUsage();
  renderRangePicker();
  renderMetrics();
  loadHistory();
  updateLive();
  $('serverModal').querySelector('[data-close].icon-btn').focus();
}
function renderRangePicker() {
  document.querySelectorAll('#rangePicker button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === M.range)));
}
$('rangePicker').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-range]');
  if (!b || b.dataset.range === M.range) return;
  M.range = b.dataset.range;
  store.set('cw.range', M.range);
  renderRangePicker();
  loadHistory(true);
});
function closeServer() {
  $('serverModal').hidden = true;
  send({ t: 'metrics_sub', on: false });
  lastFocus?.focus?.();
}
$('miniStats').addEventListener('click', openServer);
$('serverModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeServer(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('serverModal').hidden) { e.stopImmediatePropagation(); closeServer(); }
}, true);
setInterval(() => { if (M.usage) renderUsage(); }, 30e3); // keep the "in 2h 9m" countdowns current

// ---------- usage window ----------
// Per-agent plan windows, tokens and limit hits over time (GET /api/usage/history, see usage.mjs).
const U = { range: { '24h': 1, '7d': 1, '30d': 1 }[store.get('cw.urange')] ? store.get('cw.urange') : '24h', data: null, err: '', at: 0, timer: null, lastFocus: null, draws: [] };
const USAGE_AGENTS = ['claude', 'codex', 'antigravity'];
const WIN_NAMES = { five_hour: '5-hour', seven_day: 'Weekly', '5h': '5-hour', weekly: 'Weekly' };
const SERIES = ['var(--accent)', 'var(--chart-2)', 'var(--chart-3)', 'var(--faint)'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// claude five_hour/seven_day_opus, codex 5h/weekly, agy gemini-5h/3p-weekly.
function winLabel(w) {
  if (WIN_NAMES[w]) return WIN_NAMES[w];
  let m = w.match(/^seven_day_(.+)$/);
  if (m) return `Weekly ${cap(m[1].replace(/_/g, ' '))}`;
  m = w.match(/^(.+)-(5h|weekly)$/);
  if (m) return `${cap(m[1])} ${WIN_NAMES[m[2]].toLowerCase()}`;
  return cap(w.replace(/_/g, ' '));
}
const winRank = (w) => (/(^|-)5h$|five_hour/.test(w) ? 0 : /(^|-)weekly$|^seven_day$/.test(w) ? 1 : 2);
const byWin = (a, b) => winRank(a) - winRank(b) || a.localeCompare(b);
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
// Browser-local: "3:10 PM" today, "Tue 3:10 PM" within a week, else "Sep 20 3:10 PM".
function fmtWhen(ms, now = Date.now()) {
  const t = new Date(ms), clock = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (t.toDateString() === new Date(now).toDateString()) return clock;
  if (Math.abs(ms - now) < 6 * 864e5) return `${t.toLocaleDateString([], { weekday: 'short' })} ${clock}`;
  return `${t.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`;
}
const agentLabel = (id) => AGENT_LIST.find((a) => a.id === id)?.label || CONN.list.find((c) => c.id === id)?.label || cap(id);

// Current reading per window: "5-hour 42% · resets 3:10 PM".
function usageChips(a) {
  const box = el('div', 'ug-chips'), now = Date.now();
  if (a.status.blocked) {
    box.append(el('span', 'ug-chip crit', `Limit hit · ${a.status.resetsAt ? `until ${fmtWhen(a.status.resetsAt * 1000)}` : 'reset time unknown'}`));
  }
  for (const w of Object.keys(a.status.windows).sort(byWin)) {
    const s = a.status.windows[w], reset = s.resetsAt ? s.resetsAt * 1000 : null;
    const c = el('span', `ug-chip ${reset && reset <= now ? '' : level(s.pct)[0]}`,
      reset && reset <= now ? `${winLabel(w)} · reset ${fmtWhen(reset)}` : `${winLabel(w)} ${Math.round(s.pct)}% · ${reset ? `resets ${fmtWhen(reset)}` : 'reset time unknown'}`);
    c.title = `Read ${fmtWhen(s.t)}`;
    box.append(c);
  }
  return box;
}

// Chart plumbing shared with the server window's sparkline: .sline svg, crosshair, point and tooltip.
function usageChart(host, cls, extra) {
  host.className = `sline ug-chart ${cls}`;
  host.innerHTML = `<svg aria-hidden="true"><line class="base"/>${extra}<line class="cross" hidden/><g class="pts"></g></svg><div class="tip" hidden></div>`;
  const svg = host.querySelector('svg'), tip = host.querySelector('.tip');
  const label = el('div', 'sline-label');
  const [lFrom, lStat, lNow] = [el('span', '', RANGE_AGO[U.range] || `${U.range} ago`), el('span', 'stat'), el('span', '', 'now')];
  label.append(lFrom, lStat, lNow);
  host.after(label);
  const ns = (tag, attrs) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const showTip = (text, cx, w) => {
    tip.hidden = !text;
    tip.textContent = text || '';
    const half = Math.min(tip.offsetWidth, w) / 2;
    tip.style.left = `${Math.max(half, Math.min(w - half, cx))}px`;
  };
  const cross = svg.querySelector('.cross');
  const setCross = (cx, h) => {
    if (cx == null) { cross.setAttribute('hidden', ''); return; }
    cross.removeAttribute('hidden');
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('y1', 0); cross.setAttribute('y2', h);
  };
  const c = { svg, tip, lStat, ns, showTip, setCross, hoverX: null, draw: () => {} };
  const move = (e) => { c.hoverX = e.clientX - host.getBoundingClientRect().left; c.draw(); };
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerdown', move);
  host.addEventListener('pointerleave', (e) => { if (e.pointerType === 'touch') return; c.hoverX = null; c.draw(); }); // a tap's tooltip stays
  U.draws.push(() => c.draw());
  return c;
}

// Window % over time: stepped lines (a reading holds until the next one, and drops to 0 at its reset),
// a dashed 100% line and a marker at every reset.
function usageLineChart(host, wins, from, to) {
  const c = usageChart(host, 'ug-line', '<line class="cap"/><g class="resets"></g><g class="lines"></g>');
  const names = Object.keys(wins).sort(byWin);
  const series = names.map((n) => wins[n]);
  const resets = new Map(); // ms -> window names
  for (const [i, pts] of series.entries()) for (const p of pts) {
    const r = p.resetsAt * 1000;
    if (p.resetsAt && r > from && r <= to && r > p.t) resets.set(r, [...new Set([...(resets.get(r) || []), names[i]])]);
  }
  const valueAt = (pts, t) => {
    let p = null;
    for (const q of pts) { if (q.t <= t) p = q; else break; }
    if (!p) return null;
    return p.resetsAt && p.resetsAt * 1000 <= t ? 0 : p.pct;
  };
  const peaks = series.flat().map((p) => p.pct);
  c.lStat.textContent = names.map((n, i) => `${winLabel(n)} peak ${Math.round(Math.max(...series[i].map((p) => p.pct)))}%`).join(' · ');
  c.draw = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w) return;
    const { svg, ns } = c;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const top = Math.max(110, Math.max(0, ...peaks) * 1.05);
    const x = (t) => ((t - from) / Math.max(1, to - from)) * w;
    const y = (v) => h - 1 - (Math.min(v, top) / top) * (h - 4);
    const base = svg.querySelector('.base'), capL = svg.querySelector('.cap');
    for (const [k, v] of Object.entries({ x1: 0, x2: w, y1: h - 0.5, y2: h - 0.5 })) base.setAttribute(k, v);
    for (const [k, v] of Object.entries({ x1: 0, x2: w, y1: y(100), y2: y(100) })) capL.setAttribute(k, v);
    const rg = svg.querySelector('.resets'), lg = svg.querySelector('.lines'), pg = svg.querySelector('.pts');
    rg.replaceChildren(); lg.replaceChildren(); pg.replaceChildren();
    // Many resets (5-hour windows over days) become short ticks on the baseline so they don't hide the lines.
    const dense = resets.size * 14 > w;
    for (const r of resets.keys()) {
      rg.append(dense ? ns('line', { class: 'reset tick', x1: x(r), x2: x(r), y1: h - 6, y2: h })
        : ns('line', { class: 'reset', x1: x(r), x2: x(r), y1: 4, y2: h }), ns('circle', { class: 'reset-dot', cx: x(r), cy: dense ? h - 1 : 4, r: dense ? 1.5 : 2.5 }));
    }
    series.forEach((pts, i) => {
      if (!pts.length) return;
      let d = '', prev = 0;
      pts.forEach((p, k) => {
        d += k ? `L${x(p.t).toFixed(1)},${y(prev).toFixed(1)}L${x(p.t).toFixed(1)},${y(p.pct).toFixed(1)}` : `M${x(p.t).toFixed(1)},${y(p.pct).toFixed(1)}`;
        prev = p.pct;
        const next = k + 1 < pts.length ? pts[k + 1].t : to, r = p.resetsAt * 1000;
        if (p.resetsAt && r > p.t && r < next) { d += `L${x(r).toFixed(1)},${y(prev).toFixed(1)}L${x(r).toFixed(1)},${y(0).toFixed(1)}`; prev = 0; }
        if (k + 1 === pts.length) d += `L${x(to).toFixed(1)},${y(prev).toFixed(1)}`;
      });
      lg.append(ns('path', { class: 'line', d, style: `stroke:${SERIES[i % SERIES.length]}` }));
    });
    if (c.hoverX == null) { c.setCross(null); c.showTip(''); return; }
    // Snap to the nearest reading or reset.
    const tHover = from + (c.hoverX / w) * (to - from);
    let t = null, isReset = false;
    for (const p of series.flat()) if (t == null || Math.abs(p.t - tHover) < Math.abs(t - tHover)) t = p.t;
    for (const r of resets.keys()) if (t == null || Math.abs(r - tHover) < Math.abs(t - tHover)) { t = r; isReset = true; }
    if (t == null) return;
    const cx = x(t);
    c.setCross(cx, h);
    const parts = [];
    series.forEach((pts, i) => {
      const v = valueAt(pts, t);
      if (v == null) return;
      pg.append(ns('circle', { class: 'pt', cx, cy: y(v), r: 4, style: `fill:${SERIES[i % SERIES.length]}` }));
      parts.push(`${winLabel(names[i])} ${Math.round(v)}%`);
    });
    if (isReset) parts.unshift(`${resets.get(t).map(winLabel).join(', ')} reset`);
    c.showTip(`${parts.join(' · ')} · ${fmtWhen(t)}`, cx, w);
  };
}

// Tokens per bucket, stacked: input (uncached) under output.
function usageBarChart(host, buckets, bucketMs, from, to) {
  const c = usageChart(host, 'ug-bars', '<g class="bars"></g>');
  const sum = (k) => buckets.reduce((a, b) => a + b[k], 0);
  c.lStat.textContent = `in ${fmtTok(sum('input'))} · out ${fmtTok(sum('output'))}`;
  const daily = bucketMs >= 864e5;
  const when = (t) => daily ? new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    : `${fmtWhen(t)}–${new Date(t + bucketMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  c.draw = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w) return;
    const { svg, ns } = c;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const base = svg.querySelector('.base');
    for (const [k, v] of Object.entries({ x1: 0, x2: w, y1: h - 0.5, y2: h - 0.5 })) base.setAttribute(k, v);
    const top = Math.max(1, ...buckets.map((b) => b.input + b.output)) * 1.08;
    const x = (t) => ((t - from) / Math.max(1, to - from)) * w;
    const bw = Math.max(1, (bucketMs / Math.max(1, to - from)) * w);
    const gap = Math.min(3, bw * 0.2);
    const hx = c.hoverX;
    const hi = hx == null ? -1 : buckets.findIndex((b) => hx >= x(b.t) && hx < x(b.t) + bw);
    const g = svg.querySelector('.bars');
    g.replaceChildren();
    buckets.forEach((b, i) => {
      const x0 = Math.max(0, x(b.t)) + gap / 2, x1 = Math.min(w, x(b.t) + bw) - gap / 2;
      if (x1 <= x0) return;
      const hIn = (b.input / top) * (h - 2), hOut = (b.output / top) * (h - 2);
      const dim = hi >= 0 && hi !== i ? ' dim' : '';
      if (hIn) g.append(ns('rect', { class: `in${dim}`, x: x0, width: x1 - x0, y: h - 1 - hIn, height: hIn }));
      if (hOut) g.append(ns('rect', { class: `out${dim}`, x: x0, width: x1 - x0, y: h - 1 - hIn - hOut, height: hOut }));
    });
    const pg = svg.querySelector('.pts');
    pg.replaceChildren();
    if (hi < 0) { c.showTip(''); return; }
    const b = buckets[hi];
    c.showTip(`${when(b.t)} · in ${fmtTok(b.input)} · out ${fmtTok(b.output)}${b.cached ? ` · cached ${fmtTok(b.cached)}` : ''} · ${b.turns} ${b.turns === 1 ? 'turn' : 'turns'}`,
      x(b.t) + bw / 2, w);
  };
}

// Limit hits (newest first), each with when it cleared.
function usageLimits(a) {
  const rows = [];
  let open = null;
  for (const e of a.limits) {
    if (e.status === 'hit') { if (open) rows.push({ hit: open }); open = e; }
    else { rows.push({ hit: open, cleared: e }); open = null; }
  }
  if (open) rows.push({ hit: open, still: a.status.blocked });
  if (!rows.length) return el('p', 'na', 'No limits hit in this range.');
  const ul = el('ul', 'm-list ug-limits');
  for (const r of rows.reverse()) {
    const li = el('li');
    const win = (r.hit || r.cleared).window;
    li.append(el('span', 'k', `${r.hit ? `Hit ${fmtWhen(r.hit.t)}` : 'Hit before this range'}${win ? ` · ${winLabel(win)}` : ''}`));
    const reset = r.hit?.resetsAt ? ` · resets ${fmtWhen(r.hit.resetsAt * 1000)}` : '';
    li.append(el('span', `v${r.still ? ' crit' : ''}`, r.cleared
      ? `Cleared ${fmtWhen(r.cleared.t)}${r.hit ? ` · after ${fmtDur((r.cleared.t - r.hit.t) / 1000)}` : ''}`
      : r.still ? `Still limited${reset}` : `No clear recorded${reset}`));
    ul.append(li);
  }
  return ul;
}

function usageSection(id, a, conn, d) {
  const sec = el('section', 'm-card ug-agent');
  sec.dataset.agent = id;
  const head = el('div', 'tile-top');
  head.append(el('h3', '', agentLabel(id)));
  const signedOut = conn && !conn.signedIn;
  if (signedOut) head.append(el('span', 'status warn', 'Not connected'));
  else if (a?.status.blocked) head.append(el('span', 'status crit', 'Limited'));
  else if (a) head.append(el('span', 'status', 'Connected'));
  sec.append(head);
  if (signedOut) {
    const p = el('p', 'na ug-conn', `${agentLabel(id)} isn't signed in on this server. `);
    const go = el('button', 'ug-link', 'Open Connections');
    go.type = 'button';
    go.onclick = () => { closeUsage(false); openConnections(id); };
    p.append(go);
    sec.append(p);
  }
  if (!a) return sec;
  sec.append(usageChips(a));
  const grid = el('div', 'ug-grid');
  const col = (title) => { const c = el('div', 'ug-col'); c.append(el('h4', '', title)); grid.append(c); return c; };
  const lc = col('Plan windows');
  const names = Object.keys(a.windows).sort(byWin);
  if (names.some((n) => a.windows[n].length)) {
    const legend = el('div', 'ug-legend');
    names.forEach((n, i) => { const s = el('span', '', winLabel(n)); s.style.setProperty('--c', SERIES[i % SERIES.length]); legend.append(s); });
    lc.append(legend);
    const host = el('div');
    lc.append(host);
    usageLineChart(host, a.windows, d.from, d.to);
  } else lc.append(el('p', 'na', 'No window readings in this range.'));
  const bc = col(d.bucketMs >= 864e5 ? 'Tokens per day' : 'Tokens per hour');
  if (a.tokens.some((b) => b.input || b.output)) {
    const legend = el('div', 'ug-legend');
    for (const [k, t] of [['in', 'Input'], ['out', 'Output']]) { const s = el('span', k, t); legend.append(s); }
    bc.append(legend);
    const host = el('div');
    bc.append(host);
    usageBarChart(host, a.tokens, d.bucketMs, d.from, d.to);
  } else bc.append(el('p', 'na', 'No tokens recorded in this range.'));
  sec.append(grid, el('h4', '', 'Limit hits'), usageLimits(a));
  return sec;
}

function renderUsageModal() {
  if ($('usageModal').hidden) return;
  document.querySelectorAll('#usageRange button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === U.range)));
  const d = U.data;
  $('usageSub').textContent = U.err ? `Couldn't load usage: ${U.err}` : !d ? 'Loading…'
    : `Plan windows, tokens and limit hits per agent · updated ${fmtWhen(U.at)}`;
  if (!d) return;
  U.draws = [];
  const body = $('usageBody');
  const ids = [...USAGE_AGENTS, ...Object.keys(d.agents).filter((id) => !USAGE_AGENTS.includes(id))];
  const secs = [];
  for (const id of ids) {
    const a = d.agents[id];
    const has = a && (Object.keys(a.status.windows).length || a.limits.length || a.status.blocked || a.tokens.some((b) => b.turns));
    const conn = CONN.list.find((c) => c.id === id);
    // Hidden when there is nothing to show, unless it's signed out (then it says so, with a way to sign in).
    if (!has && !(conn?.installed && !conn.signedIn)) continue;
    secs.push(usageSection(id, has ? a : null, conn, d));
  }
  if (!secs.length) {
    const empty = el('div', 'm-card ug-empty');
    empty.append(el('h3', '', 'No usage recorded yet'), el('p', 'na', 'Readings appear after the first chat reply or task run, and Claude plan limits are checked every few minutes.'));
    secs.push(empty);
  }
  body.replaceChildren(...secs);
  U.draws.forEach((fn) => fn());
}
async function loadUsageHistory() {
  const range = U.range;
  try {
    const d = await api(`/api/usage/history?range=${range}`);
    if (range !== U.range) return;
    U.data = d; U.err = ''; U.at = Date.now();
  } catch (e) { U.err = e.message; }
  renderUsageModal();
}
function openUsage() {
  closeSidebar();
  if ($('usageModal').hidden) U.lastFocus = document.activeElement;
  $('usageModal').hidden = false;
  renderUsageModal();
  loadUsageHistory();
  if (!CONN.list.length) refreshConnections().then(renderUsageModal);
  clearInterval(U.timer);
  U.timer = setInterval(loadUsageHistory, 60e3); // live refresh while open
  $('usageModal').querySelector('[data-close].icon-btn').focus();
}
function closeUsage(restoreFocus = true) {
  $('usageModal').hidden = true;
  clearInterval(U.timer);
  if (restoreFocus) U.lastFocus?.focus?.();
}
$('usageRange').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-range]');
  if (!b || b.dataset.range === U.range) return;
  U.range = b.dataset.range;
  store.set('cw.urange', U.range);
  U.data = null;
  renderUsageModal();
  loadUsageHistory();
});
// The sidebar usage card opens the window; its refresh button only refreshes.
const usageCard = document.querySelector('.ms-usage');
usageCard.addEventListener('click', (e) => { if (!e.target.closest('#usRefresh')) openUsage(); });
usageCard.addEventListener('keydown', (e) => {
  if (e.target !== usageCard || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  openUsage();
});
$('usageModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeUsage(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('usageModal').hidden) { e.stopImmediatePropagation(); closeUsage(); }
}, true);
{
  let t;
  addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { if (!$('usageModal').hidden) U.draws.forEach((d) => d()); }, 100); });
}

// ---------- Orchestrator Mode ----------
// Tasks live on the server; the chat shows them as cards and the drawer shows one in full.
const O = { tasks: new Map(), project: null, state: null, drawer: null, detail: null, expanded: new Set(), dueOpen: false, err: '' };
const CHEVRON_SVG = '<svg class="chev" viewBox="0 0 24 24" width="14" height="14"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

const fmtClock = (sec) => new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function fmtDue(sec) {
  const d = new Date(sec * 1000), today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getTime() + 864e5).toDateString() === d.toDateString();
  return `${sameDay ? 'today' : tomorrow ? 'tomorrow' : d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtClock(sec)}`;
}
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}
const displayTitle = (t) => (t.kind === 'reflect' ? 'Finding the next improvements' : t.kind === 'plan' ? 'Answering your saved message' : t.title);
const kindLabel = (t) => (t.kind === 'reflect' ? 'Reflection' : t.kind === 'plan' ? 'Planner' : t.source === 'reflection' ? 'Task · from reflection' : 'Task');

function taskState(t) {
  const nowS = Date.now() / 1000;
  switch (t.status) {
    case 'running':
      return { cls: 'running', label: `${t.kind === 'reflect' ? 'Looking through the project' : 'Running'} · ${fmtDur(nowS - (t.started_at || nowS))}` };
    case 'done':
      return { cls: 'done', label: t.summary ? `Done · ${t.summary}` : 'Done' };
    case 'failed': {
      const m = /^blocked: #(\d+)/.exec(t.summary || '');
      return { cls: 'failed', label: m ? `Blocked because #${m[1]} failed` : `Failed${t.summary ? ` · ${t.summary}` : ''}` };
    }
    case 'cancelled': {
      const m = /^cancelled with #(\d+)/.exec(t.summary || '');
      return { cls: 'cancelled', label: m ? `Cancelled with #${m[1]}` : 'Cancelled' };
    }
  }
  const s = O.state;
  const lim = s?.blocks?.[t.runs_on || 'claude'];
  if (lim && lim.until > nowS) return { cls: 'limited', label: `Waiting for ${limitName(t.runs_on || 'claude')} usage reset · ${fmtClock(lim.until)}` };
  if (O.project && O.project.id === t.project_id && O.project.status === 'paused') return { cls: 'waiting', label: 'Paused' };
  if (t.depends_on) {
    const dep = O.tasks.get(t.depends_on);
    if (!dep || dep.status !== 'done') return { cls: 'waiting', label: `Waits for #${t.depends_on}` };
  }
  if (t.not_before > nowS) return { cls: 'waiting', label: `Retrying at ${fmtClock(t.not_before)}` };
  return { cls: 'queued', label: `Queued${t.continuations ? ' · continuing' : t.attempts ? ` · attempt ${t.attempts + 1}` : ''}` };
}

function taskCard(id) {
  const b = el('button', 'tcard');
  b.type = 'button';
  b.dataset.task = id;
  b.innerHTML = `<span class="tc-glyph"></span><span class="tc-main"><span class="tc-title"></span><span class="tc-sub"></span></span><span class="tc-tags"></span>${CHEVRON_SVG}`;
  b.addEventListener('click', () => openTask(id));
  fillCard(b, id);
  return b;
}
function fillCard(b, id) {
  const t = O.tasks.get(id);
  const title = b.querySelector('.tc-title'), sub = b.querySelector('.tc-sub'), tags = b.querySelector('.tc-tags');
  if (!t) {
    b.querySelector('.tc-glyph').className = 'tc-glyph queued';
    title.textContent = `Task #${id}`;
    sub.textContent = '';
    return;
  }
  const s = taskState(t);
  b.querySelector('.tc-glyph').className = `tc-glyph ${s.cls}`;
  title.textContent = displayTitle(t);
  sub.textContent = '';
  sub.append(el('span', 'id', `#${t.id}`), document.createTextNode(` · ${s.label}`));
  tags.textContent = '';
  const open = t.status === 'queued' || t.status === 'running';
  if (open && t.urgency === 'urgent') tags.append(el('span', 'tc-tag urgent', 'Urgent'));
  if (open && t.urgency === 'background') tags.append(el('span', 'tc-tag', 'Later'));
  if (open && t.deadline) tags.append(el('span', 'tc-tag due', `Due ${fmtDue(t.deadline)}`));
  const badge = agentBadge(t);
  if (badge) tags.append(badge);
  const deleg = delegatedBadge(t);
  if (deleg) tags.append(deleg);
  b.classList.toggle('active', O.drawer === id);
}
const refreshCards = (id) => document.querySelectorAll(`.tcard[data-task="${id}"]`).forEach((b) => fillCard(b, id));
const refreshAllCards = () => document.querySelectorAll('.tcard[data-task]').forEach((b) => fillCard(b, Number(b.dataset.task)));

function applyOrchSnapshot(s) {
  O.project = s?.project || null;
  if (s?.state) O.state = s.state;
  for (const t of s?.tasks || []) O.tasks.set(t.id, t);
  renderOrchBar();
  renderUpdateBanner();
  refreshAllCards();
}

function onOrch(msg) {
  if (msg.t === 'otask') {
    O.tasks.set(msg.task.id, msg.task);
    refreshCards(msg.task.id);
    for (const other of O.tasks.values()) if (other.depends_on === msg.task.id) refreshCards(other.id);
    if (O.drawer === msg.task.id) { renderDrawerHead(); scheduleDetail(); }
  } else if (msg.t === 'oproject') {
    const c = currentConvo();
    if (msg.project && c && msg.project.path === c.cwd) {
      O.project = msg.project;
      renderOrchBar();
      refreshAllCards();
    }
  } else if (msg.t === 'ostate') {
    O.state = msg.state;
    renderOrchBar();
    renderUpdateBanner();
    refreshAllCards();
  } else if (msg.t === 'orun' && O.drawer === msg.taskId && O.detail) {
    appendRunEntry(msg.runId, msg.e);
  }
}

// ----- the status bar above the chat
// Each agent's usage limit is independent: state.blocks = { claude: { until, known, reason }, codex: … }.
const limitName = (id) => (id === 'claude' ? 'Claude' : agentLabel(id));
const limitedAgents = (s, nowS) => Object.entries(s.blocks || {}).filter(([, b]) => b.until > nowS);
function renderOrchBar() {
  renderConnFoot(); // routing rules decide whether a signed-out agent warrants the footer's warning
  const on = $('mode').value === 'orchestrator';
  $('orchBar').hidden = !on;
  if (!on) return;
  const p = O.project, s = O.state || {}, nowS = Date.now() / 1000;
  let status;
  if (!p) status = 'Describe what you want. The planner breaks it into small, verified tasks.';
  else if (s.subscription === false) status = 'Waiting: Claude Code is not signed in with your subscription';
  else if (limitedAgents(s, nowS).length) status = limitedAgents(s, nowS).map(([id, b]) => `${limitName(id)}: usage limit reached · resumes ${fmtClock(b.until)}`).join(' · ');
  else if (p.ready === false) status = GH.linked ? 'Setting up the GitHub repo… work starts once it exists' : 'Waiting for GitHub: link it and work starts (every task is pushed)';
  else if (p.status === 'paused') status = 'Paused. Tasks keep their progress.';
  else if (p.counts.running) status = `Working on ${p.counts.running} task${p.counts.running > 1 ? 's' : ''}`;
  else if (p.counts.queued) status = `${p.counts.queued} task${p.counts.queued > 1 ? 's' : ''} waiting to start`;
  else if (p.perpetual) status = p.next_reflect_at > nowS + 90 ? `All done · next improvement check at ${fmtClock(p.next_reflect_at)}` : 'All done · looking for improvements shortly';
  else status = 'All tasks done';
  blurSwap($('obStatus'), status);
  $('obStatus').title = s.pacing ? `Pacing: ${s.pacing}` : '';
  const counts = $('obCounts');
  counts.textContent = '';
  if (p) {
    for (const [k, label] of [['queued', 'queued'], ['done', 'done'], ['failed', 'failed']]) {
      if (!p.counts[k]) continue;
      const span = el('span');
      span.append(el('b', '', String(p.counts[k])), document.createTextNode(` ${label}`));
      counts.append(span);
    }
  }
  const routes = $('obRoutes');
  routes.textContent = '';
  if (p) {
    routes.append(el('strong', '', 'Routing rules'));
    if (!p.routes?.length) routes.append(el('small', '', 'None: every task runs on Claude. Ask in chat, e.g. "use codex for tests".'));
    for (const r of p.routes || []) {
      const row = el('div', 'ob-route');
      const what = el('span', '', `"${r.match}" → ${[r.agent, r.model].filter(Boolean).join(' · ')}`);
      what.append(el('small', '', r.scope === 'global' ? 'all projects' : 'this project'));
      const ag = AGENT_LIST.find((a) => a.id === r.agent);
      if (ag && ag.id !== 'claude' && (!ag.available || ag.loggedIn === false)) {
        const hint = el('small', '', `${ag.available ? 'not signed in' : 'not installed'}, falls back to Claude · `);
        const go = el('button', 'link-btn inline', ag.available ? 'Sign in' : 'Connections');
        go.type = 'button';
        go.onclick = (e) => { e.stopPropagation(); $('obPop').hidden = true; openConnections(ag.id); };
        hint.append(go);
        what.append(hint);
      }
      const del = el('button', 'btn small danger', 'Delete');
      del.type = 'button';
      del.onclick = (e) => {
        e.stopPropagation(); // the row re-renders, which would otherwise read as a click outside the popover
        if (confirm(`Delete the routing rule "${r.match}"${r.scope === 'global' ? ' for all projects' : ''}?`)) orchProject({ removeRoute: r.id });
      };
      row.append(what, del);
      routes.append(row);
    }
  }
  $('obPause').hidden = !p;
  $('obSettingsBtn').parentElement.hidden = !p;
  if (p) {
    $('obPause').textContent = p.status === 'paused' ? 'Resume' : 'Pause';
    $('obPerpetual').checked = p.perpetual;
    $('obPriority').value = p.priority >= 65 ? '80' : p.priority <= 35 ? '25' : '50';
  }
}
setInterval(() => { refreshAllCards(); renderOrchBar(); if (O.drawer) renderDrawerHead(); }, 15000);

async function orchProject(fields) {
  if (!O.project) return;
  try { await api(`/api/orch/project/${O.project.id}`, 'POST', fields); }
  catch (e) { add(el('div', 'notice error', e.message)); }
}
$('obPause').addEventListener('click', () => orchProject({ status: O.project?.status === 'paused' ? 'active' : 'paused' }));
$('obPerpetual').addEventListener('change', (e) => orchProject({ perpetual: e.target.checked }));
$('obPriority').addEventListener('change', (e) => orchProject({ priority: Number(e.target.value) }));
$('obSettingsBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('obPop');
  pop.hidden = !pop.hidden;
  if (pop.hidden) return;
  const close = (ev) => {
    if (pop.contains(ev.target)) return;
    pop.hidden = true;
    document.removeEventListener('click', close);
  };
  setTimeout(() => document.addEventListener('click', close));
});

// ----- the task drawer
function openTask(id) {
  if (O.drawer && O.drawer !== id) send({ t: 'owatch', taskId: O.drawer, on: false });
  const same = O.drawer === id;
  O.drawer = id;
  if (!same) { O.detail = null; O.dueOpen = false; O.err = ''; O.expanded.clear(); }
  $('taskDrawer').hidden = false;
  $('drawerScrim').hidden = !matchMedia('(max-width: 800px)').matches;
  send({ t: 'owatch', taskId: id, on: true });
  refreshAllCards();
  renderDrawer();
  loadDetail();
}
function closeTask() {
  if (!O.drawer) return;
  send({ t: 'owatch', taskId: O.drawer, on: false });
  O.drawer = null;
  O.detail = null;
  $('taskDrawer').hidden = true;
  $('drawerScrim').hidden = true;
  refreshAllCards();
}
$('drClose').addEventListener('click', closeTask);
$('drawerScrim').addEventListener('click', closeTask);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && O.drawer && $('pickerModal').hidden && $('serverModal').hidden && $('connsModal').hidden && $('usageModal').hidden && !e.target.closest?.('.dr-due')) {
    e.stopImmediatePropagation();
    closeTask();
  }
}, true);

let detailTimer;
function scheduleDetail() { clearTimeout(detailTimer); detailTimer = setTimeout(loadDetail, 300); }
async function loadDetail() {
  const id = O.drawer;
  if (!id) return;
  try {
    const d = await api(`/api/orch/task/${id}`);
    if (O.drawer !== id) return;
    O.detail = d;
    O.tasks.set(id, { ...(O.tasks.get(id) || {}), ...d.task });
    renderDrawer();
  } catch (e) {
    if (O.drawer === id) { O.err = e.message; renderDrawer(); }
  }
}

let drawerFrame = 0;
function appendRunEntry(runId, e) {
  const runs = O.detail.runs;
  let run = runs.find((r) => r.id === runId);
  if (!run) { run = { id: runId, started_at: Date.now() / 1000, outcome: null, entries: [] }; runs.push(run); }
  if (e.k === 'end') run.outcome = e.outcome;
  else if (e.k !== 'start') run.entries.push(e);
  if (!drawerFrame) drawerFrame = requestAnimationFrame(() => { drawerFrame = 0; renderDrawer(true); });
}

function renderDrawerHead() {
  const id = O.drawer;
  const t = O.tasks.get(id) || O.detail?.task;
  $('drGlyph').className = `tc-glyph ${t ? taskState(t).cls : 'queued'}`;
  $('drKicker').textContent = t ? `#${t.id} · ${kindLabel(t)}` : `#${id}`;
  const badge = t && agentBadge(t);
  if (badge) $('drKicker').append(' ', badge);
  const deleg = t && delegatedBadge(t);
  if (deleg) $('drKicker').append(' ', deleg);
  $('drTitle').textContent = t ? displayTitle(t) : 'Loading…';
}

function section(title) {
  const s = el('section', 'dr-sec');
  if (title) s.append(el('h3', '', title));
  return s;
}

function renderDrawer(fromLive = false) {
  const id = O.drawer;
  if (!id) return;
  renderDrawerHead();
  const body = $('drBody');
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  const keep = body.scrollTop;
  const moreOpen = body.querySelector('details.dr-more')?.open || false;
  body.textContent = '';
  if (!O.detail) {
    body.append(el('div', 'out-live', O.err || 'Loading…'));
    return;
  }
  const d = O.detail;
  const t = { ...d.task, ...(O.tasks.get(id) || {}) };
  const st = taskState(t);
  const isOpen = t.status === 'queued' || t.status === 'running';

  // 1. Where it stands, and the few things you can do about it.
  const top = section('');
  const sum = el('div', 'dr-summary', st.label);
  const meta = [];
  if (t.attempts) meta.push(`attempt ${t.attempts + (isOpen ? 1 : 0)} of 3`);
  if (t.continuations) meta.push(`continued ${t.continuations}×`);
  if (t.deadline) meta.push(`due ${fmtDue(t.deadline)}`);
  if (t.commit_sha) meta.push(`commit ${t.commit_sha}, pushed to GitHub`);
  if (meta.length) sum.append(el('div', 'muted', meta.join(' · ')));
  top.append(sum);
  const row = el('div', 'dr-actions');
  row.style.marginTop = '12px';
  if (isOpen && t.kind === 'work') {
    const u = el('select');
    u.className = 'btn small';
    for (const [v, label] of [['urgent', 'Urgent'], ['normal', 'Normal'], ['background', 'Later']]) {
      const o = el('option', '', label);
      o.value = v;
      u.append(o);
    }
    u.value = t.urgency;
    u.title = 'How soon this should run';
    u.onchange = () => orchAction('urgency', u.value);
    row.append(u);
    if (t.status === 'queued') {
      const next = el('button', 'btn small', 'Do next');
      next.onclick = () => orchAction('next');
      row.append(next);
      const dg = el('button', 'btn small', 'Delegate…');
      dg.title = 'Move this task to another agent or model';
      dg.onclick = () => openDelegate(t.id);
      row.append(dg);
    }
  }
  if (isOpen) {
    const cancel = el('button', 'btn small danger', 'Cancel');
    cancel.onclick = () => { if (confirm(`Cancel #${t.id}? Tasks waiting on it are cancelled too.`)) orchAction('cancel'); };
    row.append(cancel);
  } else if (t.status === 'failed' || t.status === 'cancelled') {
    const retry = el('button', 'btn small primary', 'Retry');
    retry.onclick = () => orchAction('retry');
    row.append(retry);
  }
  if (row.children.length) top.append(row);
  if (O.err) top.append(el('div', 'dr-err', O.err));
  body.append(top);

  // 2. The instructions it was given.
  if (t.kind === 'work') {
    const c = section('Instructions it was given');
    c.append(el('pre', 'dr-pre', d.task.prompt));
    body.append(c);
  }

  // 3. What happened, in the agent's own words (commands live under Details).
  const said = [];
  for (const run of d.runs) for (const e of run.entries) if (e.k === 'text') said.push(e.text);
  const s3 = section(t.kind === 'reflect' ? 'What it found' : 'What happened');
  if (t.status === 'failed' && d.task.result) s3.append(el('pre', 'dr-pre err', d.task.result));
  else if (t.kind === 'reflect' && t.status === 'done' && d.task.result) {
    const div = el('div', 'dr-said');
    div.innerHTML = md(d.task.result);
    s3.append(div);
  } else if (said.length) {
    for (const text of said.slice(-5)) {
      const div = el('div', 'dr-said');
      div.innerHTML = md(text.replace(/^\s*(?:AGENT-ORCH|AO2)-STATUS:\s*(done|continue)\s*[—:-]*\s*/im, '✓ '));
      s3.append(div);
    }
  } else {
    s3.append(el('div', 'out-live', t.status === 'running' ? 'Starting…' : 'Nothing yet. It starts when an agent picks it up.'));
  }
  // The latest screenshots; the rest sit in order under Details → Commands and output.
  const shots = d.runs.flatMap((r) => r.entries.filter((e) => e.k === 'image'));
  if (shots.length) s3.append(shotGrid(shots.slice(-4)));
  if (shots.length > 4) s3.append(el('div', 'muted shots-more', `${shots.length - 4} more under Details`));
  if (t.status === 'running') {
    const live = el('div', 'out-live');
    live.append(el('span', 'spark'), document.createTextNode('Working…'));
    s3.append(live);
  }
  body.append(s3);

  // 4. What "done" means for it.
  if (t.kind === 'work' && d.task.done_when) {
    const s = section('Done when');
    const txt = el('div', 'dr-text md');
    txt.innerHTML = md(d.task.done_when);
    s.append(txt);
    body.append(s);
  }

  // 5. Everything else, folded away.
  const more = el('details', 'dr-more');
  more.open = moreOpen;
  more.append(el('summary', '', 'Details'));
  const out = section('Commands and output');
  renderOutput(out, d.runs, false);
  more.append(out);
  if (d.task.check) {
    const c = section('Check');
    const line = el('div', 'dr-check');
    line.append(document.createTextNode('Before accepting it, the orchestrator runs '), el('code', '', d.task.check));
    c.append(line);
    if (d.task.verify_output != null && t.status !== 'done') c.append(el('pre', 'dr-pre err', d.task.verify_output || '(no output)'));
    more.append(c);
  }
  if (d.dependsOn || d.followers.length) {
    const c = section('Order');
    const links = el('div', 'dr-links');
    if (d.dependsOn) { O.tasks.set(d.dependsOn.id, { ...(O.tasks.get(d.dependsOn.id) || {}), ...d.dependsOn }); links.append(el('div', 'dr-check', 'Starts after'), taskCard(d.dependsOn.id)); }
    if (d.followers.length) {
      links.append(el('div', 'dr-check', 'Then'));
      for (const f of d.followers) { O.tasks.set(f.id, { ...(O.tasks.get(f.id) || {}), ...f }); links.append(taskCard(f.id)); }
    }
    c.append(links);
    more.append(c);
  }
  if (isOpen && t.kind === 'work') {
    const c = section('Deadline');
    const f = el('form', 'dr-due');
    const inp = el('input');
    inp.placeholder = t.deadline ? `Due ${fmtDue(t.deadline)} · type a new one` : 'tomorrow 6pm, in 3 days…';
    const save = el('button', 'btn small primary', 'Set');
    f.onsubmit = (e) => { e.preventDefault(); if (inp.value.trim()) orchAction('deadline', inp.value.trim()); };
    f.append(inp, save);
    if (t.deadline) {
      const clear = el('button', 'btn small', 'Clear');
      clear.type = 'button';
      clear.onclick = () => orchAction('deadline', '');
      f.append(clear);
    }
    c.append(f);
    more.append(c);
  }
  if (d.events.length) {
    const c = section('Activity');
    const ul = el('ul', 'dr-events');
    for (const ev of d.events) {
      const li = el('li', ev.level);
      li.append(el('time', '', fmtClock(ev.ts)), el('span', '', ev.message));
      ul.append(li);
    }
    c.append(ul);
    more.append(c);
  }
  body.append(more);

  body.scrollTop = fromLive && nearBottom ? body.scrollHeight : keep;
}

const OUTCOME_TEXT = { ok: 'finished', rate_limited: 'paused at the usage limit', aborted: 'paused', timeout: 'timed out', max_turns: 'ran out of turns', error: 'hit an error', auth_error: 'not signed in' };
const TOOL_VERB = { Bash: 'Ran', Read: 'Read', Edit: 'Edited', MultiEdit: 'Edited', Write: 'Wrote', Glob: 'Found', Grep: 'Searched', WebFetch: 'Fetched', WebSearch: 'Searched', TodoWrite: 'Planned', NotebookEdit: 'Edited', Task: 'Delegated', Agent: 'Delegated' };
function toolLine(e) {
  const i = e.input || {};
  const text = i.command || i.file_path || i.pattern || i.url || i.query || i.path || i.description || '';
  return String(text).replace(/^\s*cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s*(?:;|&&)\s*/, '').replace(/\s+/g, ' ').trim();
}

function renderOutput(container, runs, isRunning) {
  if (!runs.length) {
    container.append(el('div', 'out-live', isRunning ? 'Starting…' : 'Nothing yet. Output appears here once an agent picks this task up.'));
    return;
  }
  runs.forEach((run, ri) => {
    const prev = runs[ri - 1];
    const how = ri === 0 ? 'Started' : prev?.outcome === 'ok' ? 'Continued' : ['error', 'max_turns', 'timeout'].includes(prev?.outcome) ? 'Retried' : 'Resumed';
    container.append(el('div', 'out-run', `${how} ${fmtClock(run.started_at)}${run.outcome ? ` · ${OUTCOME_TEXT[run.outcome] || run.outcome}` : ''}`));
    const results = new Map(run.entries.filter((e) => e.k === 'result').map((e) => [e.id, e]));
    let group = null, shots = null;
    for (const e of run.entries) {
      if (e.k !== 'image') shots = null;
      if (e.k === 'image') {
        group = null;
        if (!shots) shots = container.appendChild(shotGrid());
        shots.append(shotNode(e));
      } else if (e.k === 'text') {
        group = null;
        const div = el('div', 'out-text');
        div.innerHTML = md(e.text.replace(/^\s*(?:AGENT-ORCH|AO2)-STATUS:\s*(done|continue)\s*[—:-]*\s*/im, '✓ '));
        container.append(div);
      } else if (e.k === 'tool') {
        if (!group) {
          group = { key: `${run.id}:${e.id}`, items: [] };
          container.append(groupNode(group));
        }
        group.items.push({ e, res: results.get(e.id) });
        group.refresh();
      }
    }
  });
  if (isRunning) {
    const live = el('div', 'out-live');
    live.append(el('span', 'spark'), document.createTextNode('Working…'));
    container.append(live);
  }
}

// Consecutive tool calls fold into one line ("Ran 4 commands"); open it for one row each,
// and open a row for the exact command and what it printed.
function groupNode(group) {
  const box = el('div', 'out-group');
  group.refresh = () => {
    const open = O.expanded.has(group.key);
    box.className = 'out-group' + (open ? ' open' : '');
    box.textContent = '';
    const n = group.items.length;
    const allBash = group.items.every((i) => i.e.name === 'Bash');
    const failed = group.items.filter((i) => i.res?.isError).length;
    const head = el('button');
    head.type = 'button';
    head.append(el('span', 'n', allBash ? `Ran ${n} command${n === 1 ? '' : 's'}` : `Used ${n} tool${n === 1 ? '' : 's'}`));
    if (failed) head.append(el('span', 'fail', `${failed} failed`));
    head.insertAdjacentHTML('beforeend', CHEVRON_SVG);
    head.onclick = () => { if (!O.expanded.delete(group.key)) O.expanded.add(group.key); group.refresh(); };
    box.append(head);
    if (!open) return;
    for (const { e, res } of group.items) {
      const key = `${group.key}:${e.id}`;
      const rowOpen = O.expanded.has(key);
      const row = el('div', 'out-row' + (res?.isError ? ' err' : ''));
      const rb = el('button');
      rb.type = 'button';
      const txt = el('span', 'txt', toolLine(e) || '(no details)');
      if (e.name === 'Bash' && e.input?.command) txt.dataset.copy = e.input.command;
      rb.append(el('span', 'verb', TOOL_VERB[e.name] || e.name), txt);
      rb.onclick = () => { if (!O.expanded.delete(key)) O.expanded.add(key); group.refresh(); };
      row.append(rb);
      if (rowOpen) {
        const i = e.input || {};
        const shown = i.command || (i.new_string != null ? `${i.file_path}\n\n- ${String(i.old_string || '').split('\n').join('\n- ')}\n+ ${String(i.new_string).split('\n').join('\n+ ')}`
          : i.content != null ? `${i.file_path}\n\n${i.content}` : JSON.stringify(i, null, 2));
        const pre = row.appendChild(el('pre', 'dr-pre', shown));
        if (e.name === 'Bash' && i.command) pre.dataset.copy = i.command;
        row.append(el('pre', 'dr-pre' + (res?.isError ? ' err' : ''), res ? (res.text.trim() || 'No output') : 'Still running…'));
      }
      box.append(row);
    }
  };
  return box;
}

async function orchAction(action, value) {
  const id = O.drawer;
  if (!id) return;
  try {
    await api(`/api/orch/task/${id}/action`, 'POST', { action, value });
    O.err = '';
  } catch (e) {
    O.err = e.message;
  }
  loadDetail();
}

// ----- the "Delegate…" sheet: move a queued task to another agent/model (GET/POST /api/orch/tasks/:id/delegate)
const DG = { id: null, data: null, err: '', busy: false, lastFocus: null };
// [label, read(metrics), format, higher is better]
const DG_METRICS = [
  ['Coding Index', (m) => m.coding_index, (v) => v.toFixed(1), true],
  ['Agentic Index', (m) => m.agentic_index, (v) => v.toFixed(1), true],
  ['Terminal-Bench', (m) => m.benchmarks?.terminalbench_hard, (v) => `${(v <= 1 ? v * 100 : v).toFixed(1)}%`, true],
  ['SciCode', (m) => m.benchmarks?.scicode, (v) => `${(v <= 1 ? v * 100 : v).toFixed(1)}%`, true],
  ['TTFT', (m) => m.ttft_s, (v) => `${v.toFixed(2)} s`, false],
  ['Speed', (m) => m.tokens_per_s, (v) => `${Math.round(v)} tok/s`, true],
  ['Context', (m) => m.context_window, (v) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}k`), true],
  ['Price', (m) => m.pricing?.blended ?? m.pricing?.output, (v) => `$${v.toFixed(2)}/M`, false],
];
const dgNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function openDelegate(id) {
  if ($('delegModal').hidden) DG.lastFocus = document.activeElement;
  Object.assign(DG, { id, data: null, err: '', busy: false });
  $('delegModal').hidden = false;
  renderDelegate();
  $('delegModal').querySelector('[data-close].icon-btn').focus();
  api(`/api/orch/tasks/${id}/delegate`).then((d) => { if (DG.id === id) { DG.data = d; renderDelegate(); } })
    .catch((e) => { if (DG.id === id) { DG.err = e.message; renderDelegate(); } });
}
function closeDelegate() {
  $('delegModal').hidden = true;
  DG.id = null;
  DG.lastFocus?.focus?.();
}
$('delegModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeDelegate(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('delegModal').hidden) { e.stopImmediatePropagation(); closeDelegate(); } }, true);
function dgStatus(r) {
  if (r.status === 'available') return el('span', 'dg-st ok', 'available');
  return el('span', 'dg-st lim', r.until ? `limited until ${fmtUntil(r.until)}` : 'limited');
}
function dgMetrics(m, base) {
  const g = el('div', 'dg-metrics');
  for (const [label, read, fmt, up] of DG_METRICS) {
    const v = m && dgNum(read(m)), b = base && dgNum(read(base));
    const cell = el('div', 'dg-m');
    cell.append(el('span', 'k', label), el('span', 'v', v == null ? '—' : fmt(v)));
    if (v != null && b != null && b !== 0 && v !== b) {
      const pct = ((v - b) / Math.abs(b)) * 100;
      const better = up ? v > b : v < b;
      cell.append(el('span', `d ${better ? 'up' : 'down'}`, `${pct > 0 ? '+' : ''}${Math.abs(pct) < 10 ? pct.toFixed(1) : Math.round(pct)}%`));
    }
    g.append(cell);
  }
  return g;
}
function renderDelegate() {
  const body = $('dgBody'), d = DG.data;
  body.textContent = '';
  const t = O.tasks.get(DG.id) || d?.task;
  $('dgTitle').textContent = `Delegate #${DG.id}`;
  $('dgSub').textContent = t ? displayTitle(t) : '';
  if (DG.err) body.append(el('div', 'dr-err', DG.err));
  if (!d) { if (!DG.err) body.append(el('div', 'out-live', 'Loading…')); return; }
  const src = el('p', 'dg-src');
  src.append(d.source === 'artificialanalysis' ? 'Metrics from Artificial Analysis' : 'Metrics entered manually (.agent-orch/model-metrics.json)',
    d.fetched_at ? ` · updated ${relTime(d.fetched_at)}` : ' · never updated', ` · ranked for ${d.category} work`);
  if (d.attribution?.url) {
    const a = el('a', '', d.attribution.text);
    a.href = d.attribution.url; a.target = '_blank'; a.rel = 'noopener';
    src.append(' · ', a);
  }
  body.append(src);
  const cur = el('div', 'dg-row current');
  const ch = el('div', 'dg-head');
  ch.append(el('span', 'dg-name', `Now: ${d.current.agent} · ${d.current.label || d.current.model || 'default model'}`), dgStatus(d.current));
  cur.append(ch, dgMetrics(d.current.metrics, null));
  body.append(cur);
  if (!d.candidates.length) body.append(el('p', 'muted', 'No other signed-in agent or model to move it to.'));
  let shownOther = false;
  for (const r of d.candidates) {
    if (!r.comparable && !shownOther) { body.append(el('h3', 'dg-group', 'Other models')); shownOther = true; }
    const row = el('button', `dg-row${r.status === 'available' ? '' : ' limited'}`);
    row.type = 'button';
    row.disabled = DG.busy;
    const h = el('div', 'dg-head');
    h.append(el('span', 'dg-name', `${r.agent} · ${r.label || r.model}`));
    if (r.ratio != null) {
      const pct = Math.round((r.ratio - 1) * 100);
      h.append(el('span', `dg-delta ${pct >= 0 ? 'up' : 'down'}`, `${pct >= 0 ? '+' : ''}${pct}% vs now`));
    }
    h.append(dgStatus(r));
    row.append(h, dgMetrics(r.metrics, d.current.metrics), el('div', 'dg-why', r.reason));
    row.onclick = () => pickDelegate(r);
    body.append(row);
  }
}
async function pickDelegate(r) {
  if (DG.busy) return;
  DG.busy = true;
  renderDelegate();
  try {
    const res = await api(`/api/orch/tasks/${DG.id}/delegate`, 'POST', { agent: r.agent, model: r.model });
    if (res.task) O.tasks.set(res.task.id, { ...(O.tasks.get(res.task.id) || {}), ...res.task });
    O.err = '';
    closeDelegate();
    loadDetail();
  } catch (e) {
    DG.busy = false;
    DG.err = e.message;
    renderDelegate();
  }
}

// ---------- GitHub ----------
const GH = { linked: false, login: null };
async function refreshGitHub() {
  try { Object.assign(GH, await api('/api/github')); } catch {}
  renderRepoLink();
  return GH;
}
function renderGhRow() {
  const row = $('ghRow');
  row.textContent = '';
  row.className = 'gh-row' + (GH.linked ? '' : ' need');
  row.insertAdjacentHTML('beforeend', $('repoLink').querySelector('svg').outerHTML);
  if (GH.linked) {
    row.append(el('span', '', `GitHub linked as @${GH.login}. Each new project gets a private repo, and every finished task is pushed.`));
  } else {
    row.append(el('span', '', 'Link GitHub to create projects. Each project gets its own private repo, and every finished task is pushed.'));
    const b = el('button', 'btn small primary', 'Link GitHub');
    b.onclick = linkGitHub;
    row.append(b);
  }
}
// Opens a terminal with GitHub's sign-in started; the owner finishes it with GitHub's one-time code.
async function linkGitHub() {
  closePicker();
  try { await api('/api/github/link', 'POST'); } catch (e) { alert(e.message); return; }
  setView('term');
  await openTerminals('github');
  const poll = setInterval(async () => {
    await refreshGitHub();
    if (GH.linked) { clearInterval(poll); renderGhRow(); }
  }, 5000);
  setTimeout(() => clearInterval(poll), 10 * 60e3);
}

// ---------- Connections (agent CLI and GitHub sign-ins; the server runs each CLI's login in tmux) ----------
const CONN_ICONS = {
  claude: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  codex: '<path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 10l2.5 2L9 14M13 14.5h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  antigravity: '<path d="M12 3.5L21 19.5H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
const connIcon = (id) => {
  const s = id === 'github' ? $('repoLink').querySelector('svg').cloneNode(true) : null;
  if (s) { s.setAttribute('width', '16'); s.setAttribute('height', '16'); return s; }
  const w = el('span');
  w.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">${CONN_ICONS[id] || '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/>'}</svg>`;
  return w.firstChild;
};
async function refreshConnections() {
  try { applyConnections((await api('/api/connections')).connections); } catch {}
}
function applyConnections(list) {
  const prev = new Map(CONN.list.map((c) => [c.id, c]));
  CONN.list = list || [];
  let agentsChanged = false;
  for (const c of CONN.list) {
    const p = prev.get(c.id);
    if (p?.login?.state === 'waiting' && c.login?.state === 'done') {
      CONN.justDone[c.id] = true;
      setTimeout(() => { delete CONN.justDone[c.id]; renderConnections(true); }, 6000);
    }
    if (p && (p.signedIn !== c.signedIn || p.installed !== c.installed)) {
      if (c.id === 'github') refreshGitHub().then(() => { if (!$('pickerModal').hidden) renderGhRow(); });
      else agentsChanged = true;
    }
  }
  // Sign-in state feeds the model picker's disabled groups and the routing-rule hints.
  if (agentsChanged) api('/api/agents').then((d) => { AGENT_LIST = d.agents || []; renderAgentPicker(); }).catch(() => {});
  renderConnections();
  renderUsageModal();
}
// The sidebar footer: connection status, plus a warning when an agent in use (chat or routing rules) is signed out.
function usedAgents() {
  const ids = new Set([parsePick($('model').dataset.prev || $('model').value || '').agent]);
  for (const r of O.project?.routes || []) {
    const id = r.agent || AGENT_LIST.find((a) => a.models.some((m) => m.id === r.model || m.resolved === r.model))?.id;
    if (id) ids.add(id);
  }
  return ids;
}
function renderConnFoot() {
  const live = state.ws?.readyState === 1, used = usedAgents();
  const out = CONN.list.filter((c) => used.has(c.id) && c.id !== 'github' && !c.signedIn);
  const text = !live ? (retry ? 'Offline · reconnecting…' : 'Connecting…')
    : out.length ? `Connected · ${out.map((c) => c.label.replace(/ (Code|CLI)$/, '')).join(', ')} signed out` : 'Connected';
  const cls = !live ? (retry ? 'off' : '') : out.length ? 'warn' : 'on';
  $('connDot').className = `dot ${cls}`;
  $('connText').textContent = text;
  $('connFoot').classList.toggle('warn', live && out.length > 0);
  $('connFoot').title = out.length ? `${out.map((c) => c.label).join(', ')} ${out.length > 1 ? 'are' : 'is'} in use but signed out` : 'Open connections';
  const app = $('connsApp');
  app.textContent = '';
  const main = el('div', 'cn-main');
  const info = el('div', 'cn-info');
  info.append(el('span', 'cn-label', 'agent-orch server'));
  const st = el('span', 'cn-status');
  st.append(el('span', `dot ${!live && retry ? 'off' : live ? 'on' : ''}`), el('span', 'cn-st', `${live ? 'Live' : retry ? 'Offline, reconnecting…' : 'Connecting…'} · ${location.host}`));
  info.append(st);
  const icon = el('span');
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="4" y="4" width="16" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="4" y="13" width="16" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  main.append(icon.firstChild, info);
  app.append(main);
}
// The footer, the model picker's "sign in" option and routing hints open this window (optionally at one agent).
function openConnections(id) {
  closeSidebar();
  if ($('connsModal').hidden) CONN.lastFocus = document.activeElement;
  $('connsModal').hidden = false;
  renderConnFoot();
  renderConnections(true);
  refreshConnections();
  refreshAA();
  $('connsModal').querySelector('[data-close].icon-btn').focus();
  const row = id && $('connsList').querySelector(`[data-conn="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'nearest' });
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
}
function closeConnections() {
  $('connsModal').hidden = true;
  CONN.lastFocus?.focus?.();
}
$('connFoot').addEventListener('click', () => openConnections());
$('connsModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeConnections(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('connsModal').hidden) { e.stopImmediatePropagation(); closeConnections(); }
}, true);
async function connAction(c, action, body) {
  try {
    const r = await api(`/api/connections/${c.id}/${action}`, 'POST', body);
    if ('login' in r) { c.login = r.login; renderConnections(true); }
    return r;
  } catch (e) { alert(`${c.label}: ${e.message}`); return null; }
}
async function connStart(c) {
  delete CONN.sent[c.id];
  delete CONN.drafts[c.id];
  await connAction(c, 'start');
}
async function connLogout(c) {
  if (!confirm(c.logoutWarning ? `Sign out of ${c.label}?\n\n${c.logoutWarning}` : `Sign out of ${c.label} on this server?`)) return;
  await connAction(c, 'logout', c.logoutWarning ? { confirm: true } : {});
}
function connStatus(c) {
  if (!c.installed) return ['', 'Not installed'];
  if (c.signedIn) return ['on', c.account ? `Connected as ${c.account}` : 'Connected'];
  if (c.login?.state === 'waiting') return ['wait', 'Signing in…'];
  return ['warn', 'Not signed in'];
}
function connPanel(c) {
  const l = c.login, box = el('div', 'cn-panel');
  if (l.state !== 'waiting') {
    box.classList.add('failed');
    box.append(el('p', 'cn-err', `Sign-in failed: ${l.error || 'unknown error'}`));
    const acts = el('div', 'cn-acts');
    const again = el('button', 'btn small primary', 'Try again');
    again.type = 'button';
    again.onclick = () => connStart(c);
    const close = el('button', 'link-btn', 'Close');
    close.type = 'button';
    close.onclick = () => { CONN.dismissed[c.id] = l.startedAt; renderConnections(true); };
    acts.append(again, close);
    box.append(acts);
    return box;
  }
  let n = 0;
  const step = (text) => el('div', 'cn-step', `${++n}. ${text}`);
  if (l.url) {
    box.append(step('Open the sign-in page'));
    let host = l.url;
    try { host = new URL(l.url).host; } catch {}
    const a = el('a', 'cn-link', `${host} ↗`);
    a.href = l.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = l.url;
    box.append(a);
  } else box.append(el('div', 'cn-step muted', 'Waiting for the sign-in link…'));
  if (l.code) {
    box.append(step('Enter this one-time code'));
    const row = el('div', 'cn-code');
    const code = el('code', '', l.code);
    const copy = el('button', 'btn small', 'Copy');
    copy.type = 'button';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(l.code); copy.textContent = 'Copied'; } catch {
        getSelection().selectAllChildren(code); copy.textContent = 'Press ⌘C';
      }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
    };
    row.append(code, copy);
    box.append(row);
  }
  if (l.needsPastedCode) {
    box.append(step('Paste the code the page shows you'));
    const f = el('form', 'cn-paste');
    const inp = el('input');
    inp.placeholder = 'Authorization code';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.dataset.connInput = c.id;
    inp.value = CONN.drafts[c.id] || '';
    inp.oninput = () => { CONN.drafts[c.id] = inp.value; };
    const go = el('button', 'btn small primary', 'Submit');
    f.append(inp, go);
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!inp.value.trim()) return inp.focus();
      go.disabled = true;
      if (await connAction(c, 'code', { code: inp.value.trim() })) { CONN.sent[c.id] = true; CONN.drafts[c.id] = ''; }
      renderConnections(true);
    };
    box.append(f);
    if (CONN.sent[c.id]) box.append(el('div', 'cn-step muted', 'Code sent, checking…'));
  } else box.append(el('div', 'cn-step muted', 'This panel updates by itself once you finish in the other tab.'));
  const acts = el('div', 'cn-acts');
  const cancel = el('button', 'link-btn', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => connAction(c, 'cancel');
  acts.append(cancel);
  box.append(acts);
  return box;
}
function renderConnections(force) {
  const list = CONN.list;
  const sig = JSON.stringify([list, CONN.justDone, CONN.dismissed, CONN.sent]);
  if (!force && sig === CONN.sig) return;
  CONN.sig = sig;
  const box = $('connsList'), focused = document.activeElement?.dataset?.connInput;
  box.textContent = '';
  renderConnFoot();
  for (const c of list) {
    const row = el('div', 'cn-row');
    row.dataset.conn = c.id;
    const [dot, text] = connStatus(c);
    const main = el('div', 'cn-main');
    const info = el('div', 'cn-info');
    info.append(el('span', 'cn-label', c.label));
    const st = el('span', 'cn-status');
    st.append(el('span', `dot ${dot}`), el('span', 'cn-st', CONN.justDone[c.id] && c.signedIn ? `✓ ${text}` : text));
    st.title = text;
    info.append(st);
    main.append(connIcon(c.id), info);
    const waiting = c.login?.state === 'waiting';
    if (c.installed && c.signedIn && c.canLogout && !waiting) {
      const b = el('button', 'btn small cn-btn', 'Disconnect');
      b.type = 'button';
      b.onclick = () => connLogout(c);
      main.append(b);
    } else if (c.installed && !c.signedIn && c.canLogin && !waiting) {
      const b = el('button', 'btn small primary cn-btn', 'Connect');
      b.type = 'button';
      b.onclick = () => connStart(c);
      main.append(b);
    }
    row.append(main);
    const l = c.login;
    if (l && (l.state === 'waiting' || (l.state === 'failed' && !c.signedIn && CONN.dismissed[c.id] !== l.startedAt))) row.append(connPanel(c));
    box.append(row);
  }
  if (focused) box.querySelector(`[data-conn-input="${focused}"]`)?.focus();
}

// The Artificial Analysis API key (model metrics). Write-only: the server answers only whether one is configured.
const AA = { status: null, draft: '' };
async function refreshAA() {
  try { AA.status = await api('/api/aa/key'); } catch {}
  renderAA();
}
function renderAA() {
  const box = $('connsData'), s = AA.status;
  box.textContent = '';
  if (!s) return;
  const row = el('div', 'cn-row');
  row.dataset.conn = 'aa';
  const main = el('div', 'cn-main'), info = el('div', 'cn-info');
  const [dot, text] = !s.configured ? ['warn', 'No API key · using the manual metrics table']
    : s.error ? ['warn', s.error]
    : ['on', `${s.from === 'env' ? 'Key from AA_API_KEY' : 'Key saved'}${s.count ? ` · ${s.count} models, updated ${relTime(s.fetched_at)}` : ''}`];
  const st = el('span', 'cn-status');
  st.append(el('span', `dot ${dot}`), el('span', 'cn-st', text));
  st.title = text;
  info.append(el('span', 'cn-label', 'Artificial Analysis'), st);
  const icon = el('span');
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 20V13M12 20V5M19 20v-9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  main.append(icon.firstChild, info);
  if (s.configured && s.from === 'file') {
    const b = el('button', 'btn small cn-btn', 'Remove');
    b.type = 'button';
    b.onclick = async () => {
      if (!confirm('Remove the Artificial Analysis API key from this server?')) return;
      try { AA.status = await api('/api/aa/key', 'DELETE'); } catch (e) { alert(e.message); }
      renderAA();
    };
    main.append(b);
  }
  row.append(main);
  if (!s.configured) {
    const f = el('form', 'cn-paste cn-aa');
    const inp = el('input');
    inp.type = 'password';
    inp.placeholder = 'API key';
    inp.autocomplete = 'off';
    inp.setAttribute('aria-label', 'Artificial Analysis API key');
    inp.value = AA.draft;
    inp.oninput = () => { AA.draft = inp.value; };
    const go = el('button', 'btn small primary', 'Save');
    f.append(inp, go);
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!inp.value.trim()) return inp.focus();
      go.disabled = true;
      go.textContent = 'Checking…';
      try { AA.status = await api('/api/aa/key', 'POST', { key: inp.value.trim() }); AA.draft = ''; } catch (err) { alert(err.message); }
      renderAA();
    };
    row.append(f);
  }
  const by = el('div', 'cn-step muted cn-by');
  const a = el('a', '', s.attribution?.text || 'Model metrics by Artificial Analysis');
  a.href = s.attribution?.url || 'https://artificialanalysis.ai';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  by.append(a, document.createTextNode(' ↗'));
  row.append(by);
  box.append(row);
}

// ---------- while you were away ----------
const AWAY_MIN_MS = 10 * 60e3; // only worth a summary after at least this long away
let hiddenAt = null;
function markSeen() { store.set('cw.lastSeen', String(Date.now())); }
async function showAway(since) {
  let d;
  try { d = await api(`/api/away?since=${since}`); } catch { return; }
  if (!d.tasks.length) return;
  const groups = new Map();
  for (const t of d.tasks) {
    if (!groups.has(t.path)) groups.set(t.path, { name: t.project, path: t.path, tasks: [] });
    groups.get(t.path).tasks.push(t);
  }
  const done = d.tasks.filter((t) => t.status === 'done').length, failed = d.tasks.length - done;
  $('awaySub').textContent = `Since ${new Date(since).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} · ` +
    `${done} task${done === 1 ? '' : 's'} done${failed ? `, ${failed} failed` : ''} in ${groups.size} project${groups.size === 1 ? '' : 's'}`;
  const body = $('awayBody');
  body.textContent = '';
  for (const g of groups.values()) {
    const sec = el('div', 'aw-proj');
    const h = el('h3');
    const name = el('a', '', g.name);
    name.href = '#';
    name.style.cssText = 'font-size:15px;color:var(--text);font-weight:600;text-decoration:none';
    name.onclick = (e) => {
      e.preventDefault();
      const c = state.convos.find((x) => x.cwd === g.path);
      $('awayModal').hidden = true;
      if (c) { openConvo(c.id); setView('chat'); }
    };
    h.append(name, el('small', '', `${g.tasks.length} change${g.tasks.length === 1 ? '' : 's'}`));
    if (d.repos[g.path]) {
      const gh = el('a', '', 'GitHub ↗');
      gh.href = d.repos[g.path];
      gh.target = '_blank';
      gh.rel = 'noopener';
      h.append(gh);
    }
    const ul = el('ul', 'aw-list');
    for (const t of g.tasks) {
      const li = el('li', t.status);
      const tx = el('div', 'tx', t.title);
      if (t.summary) tx.append(el('small', '', t.summary));
      li.append(el('span', 'mk', t.status === 'done' ? '✓' : '✗'), tx, el('time', '', fmtClock(t.finished_at)));
      ul.append(li);
    }
    sec.append(h, ul);
    body.append(sec);
  }
  $('awayModal').hidden = false;
}
$('awayModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) $('awayModal').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('awayModal').hidden) { e.stopImmediatePropagation(); $('awayModal').hidden = true; } }, true);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); markSeen(); return; }
  if (hiddenAt && Date.now() - hiddenAt >= AWAY_MIN_MS) showAway(hiddenAt);
  hiddenAt = null;
  markSeen();
});
addEventListener('pagehide', markSeen);
setInterval(() => { if (!document.hidden) markSeen(); }, 60e3);

(async function boot() {
  await checkStatus();
  const cid = location.hash.slice(1) || null;
  openConvo(cid);
  connect();
  setView(store.get('cw.view') || 'chat');
  setInterval(renderConvoList, 60e3);
  setInterval(() => { if (!document.hidden) pollUpdates(); }, 60e3);
  refreshGitHub();
  refreshConnections();
  const lastSeen = Number(store.get('cw.lastSeen')) || 0;
  if (lastSeen && Date.now() - lastSeen >= AWAY_MIN_MS) showAway(lastSeen);
  markSeen();
})();
