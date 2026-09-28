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
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

marked.setOptions({ gfm: true, breaks: false });
const md = (text) => DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['target'] });

// ---------- click-to-copy for shell commands ----------
// Markdown marks shell code blocks and command-like inline code with .copy-cmd; tool lines carry
// data-copy. One capture-phase handler copies either (capture, so it runs before a row's toggle).
const SHELL_LANG = /\blanguage-(?:bash|sh|shell|zsh|console)\b/;
const SHELL_CMD = /^(?:git|npm|npx|node|python3?|sudo|cd|ls|codex|claude|gh|tmux|systemctl)(?:\s|$)|\s&&\s|\s\|\s/;
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
  draftEffort: store.get('cw.effort') || null, // the next new chat's reasoning effort (null = the model default)
  draftFallbacks: (() => { try { return JSON.parse(store.get('cw.fallbacks')) || null; } catch { return null; } })(), // the next new chat's
  busy: false,
  ws: null,
  live: null,        // element receiving streamed text
  liveText: '',
  tools: new Map(),  // tool_use id -> card
  perms: new Map(),  // pid -> card
  workingSince: 0,
};
// Saved chat messages still editable/retractable (see markPending): msgId -> { bubble, status, notice, editing, state }.
const pendingMsgs = new Map();

// ---------- view toggle (Vibecode chat / Files / Terminal) ----------
function setView(view) {
  if (view !== 'term' && view !== 'files') view = 'chat';
  $('app').dataset.view = view;
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  $('chatView').hidden = view !== 'chat';
  $('filesView').hidden = view !== 'files';
  $('termView').hidden = view !== 'term';
  $('title').textContent = view === 'term' ? 'Terminal' : currentTitle();
  $('cwdLabel').textContent = view === 'term' ? '~/workspace · bash' : currentCwdLabel();
  if (view === 'term') openTerminals();
  else if (view === 'files') window.FilesView?.show(); // public/files.js
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

// Chats whose folder has an orchestrator project sit on top in the owner's drag order: the top project is the highest
// priority and the scheduler follows the list (POST /api/orch/projects/reorder). Plain chats follow, newest first.
const rankedConvos = () => state.convos.filter((c) => c.project)
  .sort((a, b) => (a.project.position ?? Infinity) - (b.project.position ?? Infinity) || a.project.id - b.project.id || b.updatedAt - a.updatedAt);
const rankedProjectIds = (convos = rankedConvos()) => [...new Set(convos.map((c) => c.project.id))];

function renderConvoList() {
  if (drag.active) { drag.stale = true; return; } // re-rendering would pull the lifted card out from under the pointer
  const nav = $('convoList');
  const focused = document.activeElement?.closest?.('#convoList .convo')?.dataset.cid;
  nav.textContent = '';
  if (!state.convos.length) {
    const p = el('p', 'group-label', 'No projects yet');
    p.style.textTransform = 'none';
    nav.append(p);
    return;
  }
  const ranked = rankedConvos();
  if (ranked.length) {
    const label = el('div', 'group-label', 'By priority');
    label.title = 'Drag projects to set priority (Alt+↑/↓ with the keyboard): the top one runs first';
    nav.append(label);
    for (const c of ranked) nav.append(convoItem(c, true));
  }
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const sorted = state.convos.filter((c) => !c.project).sort((a, b) => b.updatedAt - a.updatedAt);
  let lastGroup = '';
  for (const c of sorted) {
    const group = c.updatedAt >= dayStart ? 'Today' : c.updatedAt >= dayStart - 6 * 864e5 ? 'This week' : 'Older';
    if (group !== lastGroup) { nav.append(el('div', 'group-label', group)); lastGroup = group; }
    nav.append(convoItem(c, false));
  }
  if (focused) nav.querySelector(`.convo[data-cid="${CSS.escape(focused)}"]`)?.focus();
}

function convoItem(c, rankable) {
  const b = el('div', 'convo' + (c.id === state.cid ? ' active' : ''));
  b.tabIndex = 0;
  b.setAttribute('role', 'button');
  b.dataset.cid = c.id;
  b.title = tilde(c.cwd);
  b.append(el('span', 'ct', c.title || folderName(c.cwd)));
  const meta = el('span', 'cm');
  if (c.busy) meta.append(el('span', 'busy-dot'));
  else if (c.project && runningProjectIds().has(c.project.id)) {
    const dot = el('span', 'run-dot'); dot.title = 'Tasks running'; dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', 'Tasks running');
    meta.append(dot);
  }
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
  b.addEventListener('click', () => { if (performance.now() - drag.droppedAt > 350) open(); });
  b.addEventListener('keydown', (e) => {
    if (e.target !== b) return;
    if (e.key === 'Enter') open();
    else if (rankable && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); nudgeProject(c, e.key === 'ArrowUp' ? -1 : 1); }
  });
  if (rankable) {
    b.classList.add('rankable');
    b.dataset.pid = c.project.id;
    b.title += ` · priority ${c.project.priority} · drag or Alt+↑/↓ to reorder`;
    b.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    b.addEventListener('pointerdown', (e) => dragPointerDown(e, b));
    // Once lifted, a touch drag must not scroll the list (and so cancel the pointer); a long press must not open a menu.
    b.addEventListener('touchmove', (e) => { if (drag.active) e.preventDefault(); }, { passive: false });
    b.addEventListener('contextmenu', (e) => { if (drag.pending || drag.active) e.preventDefault(); });
  }
  return b;
}

// ----- project order: pointer drag (long-press on touch) and Alt+↑/↓
let drag = { active: false, pending: false, stale: false, droppedAt: -Infinity };
function nudgeProject(c, dir) {
  const ids = rankedProjectIds(), i = ids.indexOf(c.project.id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  saveProjectOrder(ids, c);
}
// Positions (and priorities, when the server sent them) onto the chats; `path` also links a chat whose project is new.
function applyProjectOrder(order) {
  const byId = new Map(order.map((r) => [r.id, r])), byPath = new Map(order.filter((r) => r.path).map((r) => [r.path, r]));
  for (const c of state.convos) {
    const r = (c.project && byId.get(c.project.id)) || byPath.get(c.cwd);
    if (!r) continue;
    c.project = { id: r.id, position: r.position, priority: r.priority ?? c.project?.priority ?? null };
  }
  if (O.project) { const r = byId.get(O.project.id); if (r?.priority != null) O.project = { ...O.project, position: r.position, priority: r.priority }; }
}
async function saveProjectOrder(ids, c) {
  const before = state.convos.map((x) => [x, x.project]);
  applyProjectOrder(ids.map((id, i) => ({ id, position: i + 1 }))); // optimistic; the server answers with priorities
  renderConvoList();
  $('convoList').querySelector(`.convo[data-cid="${CSS.escape(c.id)}"]`)?.focus();
  const at = ids.indexOf(c.project.id) + 1;
  $('rankLive').textContent = `${c.title || folderName(c.cwd)}: priority ${at} of ${ids.length}`;
  try {
    applyProjectOrder((await api('/api/orch/projects/reorder', 'POST', { ids })).order);
  } catch (e) {
    for (const [x, p] of before) x.project = p;
    toast(`Couldn't reorder projects: ${e.message}`, { kind: 'error' });
  }
  renderConvoList();
  renderOrchBar();
}
function dragPointerDown(e, card) {
  if (e.button !== 0 || drag.active || drag.pending || e.target.closest('.more')) return;
  const touch = e.pointerType === 'touch', id = e.pointerId, x0 = e.clientX, y0 = e.clientY;
  let timer = null;
  drag.pending = true;
  const done = () => {
    clearTimeout(timer);
    drag.pending = false;
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
  };
  function move(ev) {
    if (ev.pointerId !== id) return;
    if (drag.active) return dragMove(ev.clientY);
    const d = Math.hypot(ev.clientX - x0, ev.clientY - y0);
    if (touch) { if (d > 8) done(); return; } // the finger moved before the long press: it's a scroll
    if (d > 5) { liftCard(card, y0); dragMove(ev.clientY); }
  }
  function up(ev) {
    if (ev.pointerId !== id) return;
    done();
    if (drag.active) dropCard(ev.type === 'pointerup');
  }
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
  if (touch) timer = setTimeout(() => { liftCard(card, y0); navigator.vibrate?.(10); }, 400);
}
function liftCard(card, y) {
  const nav = $('convoList');
  const cards = [...nav.querySelectorAll('.convo.rankable')];
  drag = { ...drag, active: true, pending: false, stale: false, card, cards, y0: y, y, scroll0: nav.scrollTop, to: cards.indexOf(card), edge: 0, raf: 0 };
  const line = el('div', 'drop-indicator');
  line.setAttribute('aria-hidden', 'true');
  nav.append(line);
  drag.line = line;
  nav.classList.add('sorting');
  card.classList.add('lifted');
  drag.onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); dropCard(false); } };
  addEventListener('keydown', drag.onKey, true);
  dragMove(y);
}
function dragMove(y) {
  const nav = $('convoList'), { card, cards } = drag;
  drag.y = y;
  card.style.transform = `translateY(${y - drag.y0 + nav.scrollTop - drag.scroll0}px)`;
  const others = cards.filter((c) => c !== card);
  let to = others.findIndex((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
  if (to < 0) to = others.length;
  drag.to = to;
  const ref = others[to] ?? others[others.length - 1];
  drag.line.hidden = !ref;
  if (ref) drag.line.style.top = `${(others[to] ? ref.offsetTop : ref.offsetTop + ref.offsetHeight) - 1}px`;
  // Near the list's top or bottom edge, scroll it (and keep following the pointer while it rests there).
  const box = nav.getBoundingClientRect();
  drag.edge = y < box.top + 36 ? -1 : y > box.bottom - 36 ? 1 : 0;
  if (drag.edge && !drag.raf) {
    const step = () => {
      drag.raf = 0;
      if (!drag.active || !drag.edge) return;
      nav.scrollTop += drag.edge * 8;
      dragMove(drag.y);
      drag.raf = requestAnimationFrame(step);
    };
    drag.raf = requestAnimationFrame(step);
  }
}
function dropCard(commit) {
  const { card, cards, to, line, raf, onKey, stale } = drag;
  cancelAnimationFrame(raf);
  removeEventListener('keydown', onKey, true);
  line.remove();
  card.classList.remove('lifted');
  card.style.transform = '';
  $('convoList').classList.remove('sorting');
  drag = { active: false, pending: false, stale: false, droppedAt: performance.now() };
  const from = cards.indexOf(card);
  if (commit && to !== from) {
    const order = cards.filter((c) => c !== card);
    order.splice(to, 0, card);
    const byCid = new Map(state.convos.map((c) => [c.id, c]));
    const ids = rankedProjectIds(order.map((x) => byCid.get(x.dataset.cid)).filter((c) => c?.project));
    const c = byCid.get(card.dataset.cid);
    if (c && ids.join() !== rankedProjectIds().join()) return saveProjectOrder(ids, c);
  }
  if (stale) renderConvoList();
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
  if ($('app').dataset.view === 'term') { $('repoLink').hidden = true; return; }
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
  if ($('folderBtn')) {
    $('folderLabel').textContent = projectLabel();
    $('folderBtn').classList.toggle('new', isNew);
    $('folderBtn').title = c ? `This chat works in ${tilde(c.cwd)}. Pick another project to start a new chat there.` : 'Choose which project Claude works in';
  }
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
  $('modeLabel').textContent = $('mode').selectedOptions[0]?.textContent || mode;
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
  window.Ext?.renderChip();
  send({ t: 'open', cid });
  if ($('app').dataset.view === 'files') window.FilesView?.show(); // Files follows the chat's project
  else $('input').focus({ preventScroll: true });
}

function resetMessages() {
  $('messages').textContent = '';
  state.tools.clear();
  state.perms.clear();
  pendingMsgs.clear();
  state.lastUser = null;
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
  if (img.w && img.h) { fig.dataset.w = img.w; fig.dataset.h = img.h; }
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
  const panel = fig.closest('.rv-panel');
  if (panel) list = [...panel.querySelectorAll('.shot')].map((f) => ({ id: f.dataset.id, name: f.dataset.name, w: +f.dataset.w || 0, h: +f.dataset.h || 0 }));
  else if (fig.closest('#drBody') && O.detail) list = O.detail.runs.flatMap((r) => r.entries.filter((e) => e.k === 'image'));
  else list = [...$('messages').querySelectorAll('.shot')].map((f) => ({ id: f.dataset.id, name: f.dataset.name, w: +f.dataset.w || 0, h: +f.dataset.h || 0 }));
  const seen = new Set();
  list = list.filter((i) => i.id && !seen.has(i.id) && seen.add(i.id));
  LB.list = list;
  LB.lastFocus = document.activeElement;
  showShot(Math.max(0, list.findIndex((i) => i.id === fig.dataset.id)));
  $('lightbox').hidden = false;
  $('lightbox').querySelector('[data-close].icon-btn').focus();
}
const LB = { list: [], i: 0, lastFocus: null, size: '' };
function showShot(i) {
  const n = LB.list.length;
  if (!n) return;
  LB.i = (i + n) % n;
  const img = LB.list[LB.i];
  $('lbTitle').textContent = img.name || 'Screenshot';
  LB.size = img.w && img.h ? `${img.w} × ${img.h} px` : '';
  shotCaption();
  $('lbOpen').href = mediaUrl(img.id);
  $('lbMissing').hidden = true;
  $('lbView').hidden = false;
  $('lbImg').alt = img.name || 'Screenshot';
  $('lbImg').src = mediaUrl(img.id);
  $('lbView').scrollTo(0, 0);
  $('lbPrev').hidden = $('lbNext').hidden = n < 2;
}
function shotCaption() {
  const n = LB.list.length;
  $('lbSub').textContent = [LB.size, n > 1 ? `${LB.i + 1} of ${n} · use ← → to browse` : ''].filter(Boolean).join(' · ');
}
function closeShot() {
  $('lightbox').hidden = true;
  $('lbImg').removeAttribute('src');
  LB.lastFocus?.focus?.();
}
$('lbImg').addEventListener('load', () => {
  const im = $('lbImg');
  if (im.naturalWidth) { LB.size = `${im.naturalWidth} × ${im.naturalHeight} px`; shotCaption(); }
});
$('lbImg').addEventListener('error', () => { if ($('lbImg').getAttribute('src')) { $('lbView').hidden = true; $('lbMissing').hidden = false; } });
// Mouse drag pans a large image (touch scrolls natively, and pinch-zoom stays allowed).
$('lbView').addEventListener('pointerdown', (e) => {
  const v = $('lbView');
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  const x = e.clientX + v.scrollLeft, y = e.clientY + v.scrollTop;
  v.setPointerCapture(e.pointerId);
  v.classList.add('panning');
  const move = (m) => v.scrollTo(x - m.clientX, y - m.clientY);
  const up = () => { v.classList.remove('panning'); v.removeEventListener('pointermove', move); v.removeEventListener('pointerup', up); v.removeEventListener('pointercancel', up); };
  v.addEventListener('pointermove', move);
  v.addEventListener('pointerup', up);
  v.addEventListener('pointercancel', up);
  e.preventDefault();
});
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
      state.lastUser = add(el('div', 'msg user' + (ev.attachments?.length ? ` has-atts${ev.text ? '' : ' atts-only'}` : ''), ev.text));
      if (ev.attachments?.length) state.lastUser.append(attachmentList(ev.attachments));
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
    case 'notice': {
      endLive();
      const n = add(el('div', ev.t === 'error' ? 'notice error' : 'notice', withUntil(ev)));
      if (ev.msgId) markPending(ev.msgId, n);
      break;
    }
    case 'moved': {
      // '#152 moved to Astra — Opus is limited until 5:00 AM' (labels from the live model list, else the server's).
      endLive();
      const nm = (m) => (AGENT_LIST.some((a) => a.id === m.agent) ? modelName(m.agent, m.model) : m.label || m.model || m.agent);
      const n = el('div', 'notice moved', `#${ev.taskId} moved to ${nm(ev.to)} — ${nm(ev.from)} is limited${ev.until ? ` until ${fmtWhen(ev.until * 1000)}` : ''}`);
      n.setAttribute('role', 'link');
      n.addEventListener('click', () => showTask(ev.taskId));
      add(n);
      break;
    }
    case 'msg_edit': {
      const p = pendingMsgs.get(ev.msgId);
      if (p && !p.editing) p.bubble.textContent = ev.text;
      break;
    }
    case 'msg_retract':
      dropPending(ev.msgId);
      break;
    case 'msg_state':
      for (const id of ev.ids || []) setMsgState(id, ev.state);
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
      box.append(el('div', 'tc-caption', ev.source === 'review' ? 'Waiting for your review'
        : ev.source === 'reflection'
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

// ---------- saved messages ----------
// A message saved for later (orchestrator deferMessage; the 'Saved…' notice carries its msgId) can be edited or
// retracted until a plan task reads it. Its bubble is the chat's latest user bubble when the notice arrives.
function markPending(id, notice) {
  const bubble = state.lastUser;
  if (!bubble?.isConnected || bubble.dataset.msgId || pendingMsgs.has(id)) return;
  bubble.dataset.msgId = id;
  const status = el('div', 'msg-status');
  bubble.after(status);
  pendingMsgs.set(id, { bubble, status, notice, editing: false });
  setMsgState(id, 'pending');
}
function setMsgState(id, st) {
  const p = pendingMsgs.get(id);
  if (!p) return;
  p.state = st;
  p.status.textContent = '';
  p.bubble.classList.add('saved');
  if (st !== 'pending') { p.status.append(el('span', '', 'Read by planner')); return; }
  const act = (label, fn) => { const b = el('button', 'msg-act', label); b.type = 'button'; b.onclick = fn; return b; };
  p.status.append(el('span', '', 'Pending'), el('span', 'sep', '·'), act('Edit', () => editPending(id)), el('span', 'sep', '·'), act('Undo', () => undoPending(id)));
}
function dropPending(id) {
  const p = pendingMsgs.get(id);
  if (!p) return;
  p.bubble.remove(); p.status.remove(); p.notice?.remove();
  pendingMsgs.delete(id);
}
// The server said no (usually 409: a plan task took it meanwhile).
function pendingFailed(id, err) {
  if (/already read/i.test(err.message)) return setMsgState(id, 'read');
  const p = pendingMsgs.get(id);
  p?.status.prepend(el('span', 'err', `${err.message} `));
}
function editPending(id) {
  const p = pendingMsgs.get(id);
  if (!p || p.editing || p.state !== 'pending') return;
  const old = p.bubble.textContent;
  const ta = el('textarea', 'msg-edit');
  ta.value = old;
  ta.setAttribute('aria-label', 'Edit message');
  const save = el('button', 'btn small primary', 'Save'), cancel = el('button', 'btn small', 'Cancel');
  save.type = cancel.type = 'button';
  const bar = el('div', 'msg-edit-actions');
  bar.append(cancel, save);
  const close = (text) => {
    p.editing = false;
    p.bubble.classList.remove('editing');
    p.bubble.textContent = text;
    p.status.hidden = false;
  };
  const submit = async () => {
    const text = ta.value.trim();
    if (!text || text === old) return close(old);
    save.disabled = cancel.disabled = ta.disabled = true;
    try { await api(`/api/orch/messages/${id}`, 'PATCH', { text }); close(text); }
    catch (err) { close(old); pendingFailed(id, err); }
  };
  save.onclick = submit;
  cancel.onclick = () => close(old);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(old); }
  });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  p.editing = true;
  p.status.hidden = true;
  p.bubble.classList.add('editing');
  p.bubble.textContent = '';
  p.bubble.append(ta, bar);
  ta.style.height = ta.scrollHeight + 'px';
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}
async function undoPending(id) {
  const p = pendingMsgs.get(id);
  if (!p || p.state !== 'pending') return;
  const text = p.bubble.textContent;
  p.status.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try { await api(`/api/orch/messages/${id}`, 'DELETE'); }
  catch (err) { setMsgState(id, p.state); return pendingFailed(id, err); }
  dropPending(id);
  // Back into the composer, ahead of anything already typed there.
  input.value = input.value.trim() ? `${text}\n\n${input.value}` : text;
  store.set('cw.draft.' + (state.cid || 'new'), input.value);
  autosize();
  updateSendButton();
  input.focus();
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
  renderUsage();
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
  const has = !!input.value.trim() || ATT.list.length > 0;
  const stop = state.busy && !has;
  $('send').classList.toggle('stop', stop);
  $('send').setAttribute('aria-label', stop ? 'Stop' : 'Send');
  $('send').disabled = !stop && !has;
}

// ---------- attachments (uploads.mjs): the paperclip, paste or drop; many at once, images and any other file ----------
// Each file uploads as soon as it is added (POST /api/uploads) and waits in the tray above the box; the message then
// names them by id. The server copies them into the project and tells the agent where they are (Claude and Codex also
// see images directly), so they work the same in a chat and in Orchestrator Mode.
const ATT = { list: [], seq: 0, max: 10, maxBytes: 25 * 1024 * 1024 };
function addAttachments(files) {
  let skipped = 0;
  for (const f of files) {
    if (ATT.list.length >= ATT.max) { skipped++; continue; }
    if (!f.size) { toast(`${f.name || 'That file'} is empty`, { kind: 'error' }); continue; }
    if (f.size > ATT.maxBytes) { toast(`${f.name} is too large (max 25 MB)`, { kind: 'error' }); continue; }
    // A pasted screenshot arrives as "image.png": give it a name that says what it is.
    const name = f.name && f.name !== 'image.png' ? f.name : `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    const a = { key: ++ATT.seq, name, size: f.size, type: f.type, status: 'uploading', preview: /^image\/(png|jpe?g|gif|webp)$/.test(f.type) ? URL.createObjectURL(f) : null };
    ATT.list.push(a);
    uploadAttachment(a, f);
  }
  if (skipped) toast(`Up to ${ATT.max} attachments per message; ${skipped} left out`, { kind: 'error' });
  renderAttTray();
  updateSendButton();
}
async function uploadAttachment(a, f) {
  try {
    const r = await fetch('/api/uploads', { method: 'POST', body: f,
      headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(a.name) } });
    if (r.status === 401) { location.href = '/login'; return; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`);
    Object.assign(a, { status: 'ready', id: d.id, image: d.image || null });
  } catch (e) { Object.assign(a, { status: 'error', error: e.message }); }
  if (ATT.list.includes(a)) { renderAttTray(); updateSendButton(); }
}
function removeAttachment(a) {
  ATT.list = ATT.list.filter((x) => x !== a);
  if (a.preview) URL.revokeObjectURL(a.preview);
  renderAttTray();
  updateSendButton();
}
function clearAttachments() {
  for (const a of ATT.list) if (a.preview) URL.revokeObjectURL(a.preview);
  ATT.list = [];
  renderAttTray();
  updateSendButton();
}
const FILE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
function renderAttTray() {
  const tray = $('attTray');
  tray.hidden = !ATT.list.length;
  tray.replaceChildren(...ATT.list.map((a) => {
    const item = el('div', `att-item ${a.preview ? 'img' : 'file'} ${a.status}`);
    item.setAttribute('role', 'listitem');
    item.title = a.status === 'error' ? `${a.name}: ${a.error}` : `${a.name} · ${fmtBytes(a.size)}`;
    if (a.preview) { const im = el('img'); im.src = a.preview; im.alt = a.name; item.append(im); }
    else {
      const ico = el('span', 'att-ico'); ico.innerHTML = FILE_ICON;
      const txt = el('span', 'att-text');
      txt.append(el('span', 'att-name', a.name), el('span', 'att-size', a.status === 'error' ? 'Upload failed' : fmtBytes(a.size)));
      item.append(ico, txt);
    }
    if (a.status === 'uploading') item.append(el('span', 'att-spin'));
    if (a.status === 'error' && a.preview) item.append(el('span', 'att-bad', '!'));
    const x = el('button', 'att-x');
    x.type = 'button';
    x.setAttribute('aria-label', `Remove ${a.name}`);
    x.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
    x.onclick = () => { removeAttachment(a); input.focus(); };
    item.append(x);
    return item;
  }));
}
$('attBtn').addEventListener('click', () => $('attInput').click());
$('attInput').addEventListener('change', (e) => { addAttachments([...e.target.files]); e.target.value = ''; input.focus(); });
// Pasting a copied image or file attaches it; pasting text (even with a picture of it alongside) stays text.
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length || e.clipboardData.types.includes('text/plain')) return;
  e.preventDefault();
  addAttachments(files);
});
// Drop anywhere on the chat: a veil says where it goes; only file drags count (not text or links being moved).
{
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const view = $('chatView'), zone = $('dropZone');
  view.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; zone.hidden = false; });
  view.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  view.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; zone.hidden = true; } });
  view.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.hidden = true;
    addAttachments([...e.dataTransfer.files]);
    input.focus();
  });
}
// A sent message's attachments in the chat log: images as thumbnails (the lightbox pages through them), files as links.
function attachmentList(list) {
  const wrap = el('div', 'msg-atts');
  const imgs = list.filter((a) => a.image);
  if (imgs.length) wrap.append(shotGrid(imgs.map((a) => ({ id: a.image.id, name: a.name, w: a.image.w, h: a.image.h }))));
  for (const a of list.filter((x) => !x.image)) {
    const link = el('a', 'att-file');
    link.href = `/api/uploads/${encodeURIComponent(a.id)}`;
    link.download = a.name;
    link.title = a.path ? `Saved in the project: ${a.path}` : a.name;
    const ico = el('span', 'att-ico'); ico.innerHTML = FILE_ICON;
    const txt = el('span', 'att-text');
    txt.append(el('span', 'att-name', a.name), el('span', 'att-size', fmtBytes(a.size || 0)));
    link.append(ico, txt);
    wrap.append(link);
  }
  return wrap;
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
  if (!text && !ATT.list.length) {
    if (state.busy) send({ t: 'interrupt', cid: state.cid });
    return;
  }
  if (ATT.list.some((a) => a.status === 'uploading')) { toast('Still uploading your attachments. Send again in a moment.'); return; }
  const failed = ATT.list.filter((a) => a.status === 'error');
  if (failed.length) { toast(`${failed.map((a) => a.name).join(', ')} didn't upload. Remove ${failed.length === 1 ? 'it' : 'them'} or add ${failed.length === 1 ? 'it' : 'them'} again.`, { kind: 'error' }); return; }
  const attachments = ATT.list.map((a) => a.id);
  if (!state.cid) {
    try {
      const d = state.draft;
      const c = await api('/api/convos', 'POST', d.type === 'new'
        ? { newProject: { name: d.name, fromText: text || ATT.list[0]?.name.replace(/\.[^.]+$/, '') || '' }, mode: state.draftMode }
        : { folder: d.path, mode: state.draftMode });
      state.draft = { type: 'new', name: '' }; // the next new chat starts its own project again
      if (!state.convos.find((x) => x.id === c.id)) state.convos.unshift(c);
      openConvo(c.id);
      // The draft effort rides on set_model, so the server checks it against the agent it was picked for.
      const effort = clampEffortTo(effortLevels(parsePick(state.draftModel).agent), state.draftEffort);
      if (pickVal(parsePick(state.draftModel)) !== 'claude|') send({ t: 'set_model', cid: c.id, ...parsePick(state.draftModel), ...(effort && { effort }) });
      else if (effort) await api(`/api/convos/${c.id}/effort`, 'PUT', { effort }).then((r) => (c.effort = r.effort ?? null));
      if (state.draftFallbacks?.length) await api(`/api/convos/${c.id}/fallbacks`, 'PUT', { fallbacks: state.draftFallbacks }).then((r) => (c.fallbacks = r.fallbacks));
      const persona = window.Ext?.draftPersona();
      if (persona) await api(`/api/convos/${c.id}/persona`, 'PUT', { persona }).then((r) => (c.persona = r.persona ?? null)).catch(() => {});
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
  if (!send({ t: 'send', cid: state.cid, text, ...(attachments.length && { attachments }) })) {
    // Keep the text (under this chat's draft key, which reconnect restores) rather than lose it.
    store.set('cw.draft.' + state.cid, input.value);
    add(el('div', 'notice error', 'Not connected, reconnecting. Your message was kept.'));
    return;
  }
  input.value = '';
  store.set('cw.draft.' + state.cid, '');
  store.set('cw.draft.new', '');
  clearAttachments();
  autosize();
  updateSendButton();
});
$('messages').addEventListener('click', (e) => {
  if (e.target.closest('[data-open-picker]')) openPicker();
  const r = e.target.closest('.recent-projects button[data-path]');
  if (r) chooseFolder(r.dataset.path);
});

// ---------- composer menus (mode, model, effort) ----------
// One compact listbox popover (.cmenu) in the app's menu style: it opens above its chip (the composer sits at the bottom;
// below when there is more room there), options are .cm-opt buttons (role=option; aria-selected marks the current one),
// arrows/Home/End move, Enter or a click picks, Esc, Tab or a click outside closes. Phones get the same menu.
const CM = { open: null }; // { chip, menu, pick }
function menuOpt(label, { value, selected = false, hint = '', title = '', disabled = false } = {}) {
  const b = el('button', 'cm-opt');
  b.type = 'button';
  b.setAttribute('role', 'option');
  b.setAttribute('aria-selected', String(selected));
  b.dataset.value = value ?? '';
  b.disabled = disabled;
  if (title) b.title = title;
  b.append(el('span', 'cm-l', label));
  if (hint) b.append(el('span', 'cm-h', hint));
  return b;
}
function placeMenu(menu, anchor) {
  const r = anchor.getBoundingClientRect(), gap = 6, edge = 8, vh = window.visualViewport?.height || innerHeight;
  Object.assign(menu.style, { left: '', top: '', bottom: '', maxHeight: '' });
  const above = r.top - gap - edge, below = vh - r.bottom - gap - edge;
  if (above >= below || above >= 240) { menu.style.bottom = `${innerHeight - r.top + gap}px`; menu.style.maxHeight = `${Math.min(440, above)}px`; }
  else { menu.style.top = `${r.bottom + gap}px`; menu.style.maxHeight = `${Math.min(440, below)}px`; }
  menu.style.left = `${Math.max(edge, Math.min(r.left, innerWidth - menu.offsetWidth - edge))}px`;
}
function openMenu(chip, menu, build, pick) {
  closeMenu(false);
  menu.replaceChildren();
  build(menu);
  menu.hidden = false;
  chip.setAttribute('aria-expanded', 'true');
  CM.open = { chip, menu, pick };
  placeMenu(menu, chip);
  const cur = menu.querySelector('.cm-opt[aria-selected="true"]:not(:disabled)') || menu.querySelector('.cm-opt:not(:disabled)')
    || menu.querySelector('input') || menu.querySelector('button'); // a menu without options: Effort's slider
  cur?.scrollIntoView({ block: 'nearest' });
  cur?.focus({ preventScroll: true });
}
function closeMenu(refocus = true) {
  const o = CM.open;
  if (!o) return;
  CM.open = null;
  o.menu.hidden = true;
  o.chip.setAttribute('aria-expanded', 'false');
  if (refocus) o.chip.focus();
}
// The open menu, rebuilt in place (its options changed underneath it, e.g. the agent list loaded).
function refreshMenu(menu, build) {
  if (CM.open?.menu !== menu) return;
  const cur = document.activeElement?.closest?.('.cm-opt')?.dataset.value;
  menu.replaceChildren();
  build(menu);
  placeMenu(menu, CM.open.chip);
  if (cur != null) menu.querySelector(`.cm-opt[data-value="${CSS.escape(cur)}"]`)?.focus({ preventScroll: true });
}
function bindMenu(chip, menu, build, pick) {
  chip.addEventListener('click', () => (CM.open?.menu === menu ? closeMenu() : openMenu(chip, menu, build, pick)));
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(chip, menu, build, pick); }
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('.cm-opt');
    if (!b || b.disabled || CM.open?.menu !== menu) return;
    closeMenu();
    pick(b.dataset.value);
  });
  menu.addEventListener('keydown', (e) => {
    if (!e.target.closest('.cm-opt') && e.key !== 'Escape' && e.key !== 'Tab') return; // e.g. arrows on a slider
    const opts = [...menu.querySelectorAll('.cm-opt:not(:disabled)')], i = opts.indexOf(document.activeElement);
    const go = (j) => { e.preventDefault(); opts[Math.max(0, Math.min(opts.length - 1, j))]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(opts.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === 'Tab') closeMenu(false);
  });
}
document.addEventListener('pointerdown', (e) => {
  if (CM.open && !e.target.closest('.cmenu') && !CM.open.chip.contains(e.target)) closeMenu(false);
}, true);
addEventListener('resize', () => { if (CM.open) placeMenu(CM.open.menu, CM.open.chip); });
// Mode: its four permission levels, then Orchestrator Mode.
bindMenu($('modeChip'), $('modePop'), (menu) => {
  for (const o of $('mode').options) {
    if (o.value === 'orchestrator') menu.append(el('div', 'cm-sep'));
    menu.append(menuOpt(o.textContent, { value: o.value, selected: o.value === $('mode').value }));
  }
}, (v) => changeMode(v));

function changeMode(mode) {
  setModeUI(mode);
  if (state.cid) send({ t: 'set_mode', cid: state.cid, mode });
  else { state.draftMode = mode; store.set('cw.mode', mode); }
}
$('mode').addEventListener('change', () => changeMode($('mode').value));
$('model').addEventListener('change', () => {
  const v = $('model').value;
  $('model').dataset.prev = v;
  clampEffortForAgent(parsePick(v).agent);
  renderPickChip();
  if (state.cid) send({ t: 'set_model', cid: state.cid, ...parsePick(v) });
  else { state.draftModel = v; store.set('cw.model', v); }
  renderConnFoot();
});

// ---------- agent + model picker (options come from the server's agent registry) ----------
let AGENT_LIST = [];
// A model's display name as its CLI reports it (the id when the agent's list doesn't name it).
const modelLabel = (agent, id) => AGENT_LIST.find((a) => a.id === agent)?.models.find((m) => m.id === id || m.resolved === id)?.label || id;
// The model chip's label: 'Claude · Opus 5.5', or 'Claude · default' while it follows the agent's default model.
function fitPick() {
  const v = $('model').value, { agent, model } = parsePick(v || 'claude|');
  const text = model ? `${shortLabel(agent)} · ${modelLabel(agent, model)}` : `${shortLabel(agent)} · default`;
  $('modelLabel').textContent = text;
  $('modelChip').title = `Agent and model: ${text}`;
  $('modelChip').setAttribute('aria-label', `Agent and model: ${text}`);
}
// ---------- fallbacks (BRIEF goal 8) ----------
// One sheet (#fbModal) edits an ordered fallback list: a chat's (the tasks its messages queue snapshot it and move down
// it when their model hits its limit; empty = they wait) or a project's list for reflection tasks. It renders from what
// is already loaded (convos, O.project, AGENT_LIST, O.state.blocks), never a fetch; every change saves at once (PUT).
// The composer's button next to the model picker shows the chat's count; the picker itself only picks the primary model.
function renderPickChip() { fitPick(); renderFbChip(); fbRender(); renderEff(); }
const FB = { host: null, fe: {}, lastFocus: null, local: null, pending: 0, chain: Promise.resolve(), seq: 0 };
const apKey = (r) => `${r.agent}/${r.model}`;
// The model a route runs: its own, else its agent's default.
function fbModelOf({ agent, model }) {
  const ms = AGENT_LIST.find((a) => a.id === agent)?.models || [];
  return model || (ms.find((m) => m.default) || ms[0])?.id || '';
}
const fbName = (r) => (fbModelOf(r) ? modelLabel(r.agent, fbModelOf(r)) : shortLabel(r.agent));
// The model's usage limit while it is limited (state.blocks is keyed by agents.mjs limitScope), else null.
function fbLimit({ agent, model }) {
  const b = O.state?.blocks?.[agent || 'claude'];
  return b && b.until > Date.now() / 1000 ? b : null;
}
// A model's usage right now, for the fallback chip's dots: 'limited' (at its limit), 'high' (a plan window at 80%+),
// 'ok', or 'unknown' (signed out, or no reading yet). Antigravity limits are per model group (gemini / third-party).
const HEALTH_TEXT = { ok: 'usage left', high: 'near its limit', limited: 'at its limit', unknown: 'usage unknown' };
function modelHealth({ agent = 'claude', model }) {
  const a = AGENT_LIST.find((x) => x.id === agent);
  if (a && (!a.available || a.loggedIn === false)) return 'unknown';
  const group = agent === 'antigravity' ? (/gemini/i.test(fbModelOf({ agent, model })) ? 'gemini' : '3p') : null;
  const now = Date.now() / 1000;
  const blocked = Object.entries(O.state?.blocks || {}).some(([k, b]) => b.until > now && (k === agent || (group && k === `${agent}:${group}`)));
  if (blocked) return 'limited';
  const pcts = agent === 'claude' ? [M.usage?.session?.pct, M.usage?.weekly?.pct]
    : Object.entries(usageSlides.data?.[agent]?.status?.windows || {})
      .filter(([id, w]) => !w.stale && (!w.resetsAt || w.resetsAt > now) && (!group || id.startsWith(group)))
      .map(([, w]) => w.pct);
  const known = pcts.filter((p) => p != null);
  if (!known.length) return 'unknown';
  return Math.max(...known) >= 100 ? 'limited' : Math.max(...known) >= 80 ? 'high' : 'ok';
}
// The fallback chip names the list ("→ ● Astra → ● Sol", two at most, then "+N"), each with its usage dot.
function fbChipText(c, primary, list, what) {
  c.replaceChildren();
  c.classList.toggle('none', !list?.length);
  if (!list?.length) c.textContent = 'No fallbacks';
  for (const r of (list || []).slice(0, 2)) {
    const dot = el('span', `fb-dot ${modelHealth(r)}`);
    dot.setAttribute('aria-hidden', 'true');
    c.append(el('span', 'fb-arrow', '→'), dot, el('span', 'fb-name', fbName(r)));
  }
  if (list?.length > 2) c.append(el('span', 'fb-more', `+${list.length - 2}`));
  const named = (list || []).map((r) => `${fbName(r)} (${HEALTH_TEXT[modelHealth(r)]})`);
  c.setAttribute('aria-label', named.length ? `Fallbacks: ${named.join(', then ')}` : 'No fallbacks');
  c.title = named.length ? `If ${fbName(primary)} hits its limit, ${what} move to ${named.join(', then ')}`
    : `If ${fbName(primary)} hits its limit, ${what} wait for it to reset`;
}
// Hosts: primary {agent, model}; list() → [{agent, model}] | null; url: the PUT (null = the new-chat draft);
// apply(list) stores it locally; confirmedOf(res) → the list the server saved.
function chatFallbacks() {
  const cid = state.cid, convo = () => state.convos.find((c) => c.id === cid);
  return { what: 'queued tasks', primary: parsePick($('model').dataset.prev || 'claude|'),
    list: () => (cid ? convo()?.fallbacks : state.draftFallbacks) ?? null,
    url: cid ? `/api/convos/${cid}/fallbacks` : null,
    apply: (list) => {
      if (cid) { const c = convo(); if (c) c.fallbacks = list; } else { state.draftFallbacks = list; store.set('cw.fallbacks', JSON.stringify(list || [])); }
      renderFbChip();
    },
    confirmedOf: (c) => c.fallbacks ?? null };
}
// Reflection fallbacks (Settings, PUT /api/orch/reflect-settings): one list for every project. Reflect tasks move down it
// when their model is at its limit, and the work they queue snapshots it. Its primary is the reflection model: the
// Settings choice, else what a reflect task routes to (a 'reflect' route, else the chat's model).
function reflectPrimary() {
  const r = O.project?.reflect || {};
  return r.agent ? { agent: r.agent, model: r.model || '' } : O.project?.reflect_route || O.project?.work_route || { agent: 'claude', model: '' };
}
// Per project (Settings → This project): PUT /api/orch/projects/:id/reflect-settings.
function reflectFallbacks() {
  const r = () => O.project?.reflect || {};
  return { what: 'reflection tasks', primary: reflectPrimary(),
    list: () => r().fallbacks ?? null,
    url: O.project ? `/api/orch/projects/${O.project.id}/reflect-settings` : null,
    apply: (list) => { if (O.project) O.project.reflect = { ...r(), fallbacks: list }; renderReflectBtn(); },
    confirmedOf: (res) => res.reflect?.fallbacks ?? null };
}
// One task's own fallback snapshot (PATCH /api/orch/tasks/:id/fallbacks). reset: back to its chat's list when it differs.
function taskFallbacks(id) {
  const task = () => ({ ...(O.detail?.task.id === id ? O.detail.task : {}), ...(O.tasks.get(id) || {}) });
  const t = task(), queued = t.status === 'queued';
  const [agent, model] = queued && t.runs_on ? [t.runs_on, t.runs_model || null] : t.ran_agent ? [t.ran_agent, t.ran_model || null] : [t.agent || 'claude', t.model || null];
  const chat = () => state.convos.find((c) => c.id === O.detail?.project?.convo_id);
  const set = (list) => {
    const x = O.tasks.get(id);
    if (x) x.fallbacks = list;
    if (O.detail?.task.id === id) O.detail.task.fallbacks = list;
    refreshCards(id);
    if (O.drawer === id) renderDrawer();
  };
  return { what: 'this task', primary: { agent, model }, method: 'PATCH',
    sub: t.status === 'running' ? 'Changes apply from the next resume or limit event.' : '',
    empty: () => 'No fallbacks. This task waits for the reset.',
    list: () => task().fallbacks ?? null,
    url: `/api/orch/tasks/${id}/fallbacks`,
    apply: set,
    confirmedOf: (r) => r.task?.fallbacks ?? null,
    reset: () => { const c = chat(); return c && JSON.stringify(task().fallbacks || []) !== JSON.stringify(c.fallbacks || []) ? c.fallbacks ?? null : undefined; },
    // The drawer re-renders on every save, so focus returns to the fresh chip.
    focusBack: () => $('drBody').querySelector('.dr-model .dr-chip-btn') };
}
function renderFbChip() {
  const h = chatFallbacks();
  fbChipText($('fbChip'), h.primary, h.list(), h.what);
  // Non-Claude usage windows (the dots) come with the usage history; load them once if nothing has yet.
  if (h.list()?.some((r) => r.agent !== 'claude') && !usageSlides.at && !usageSlides.loading) loadSidebarUsage();
}
function renderReflectBtn() {
  const h = reflectFallbacks();
  fbChipText($('stReflectBtn'), h.primary, h.list(), h.what);
}
// Optimistic: shown and stored at once; PUTs run in order, and if the latest fails the last saved list comes back.
function fbSave(list) {
  const h = FB.host;
  if (!h) return;
  h.apply(list);
  if (h.url) {
    const seq = ++FB.seq, url = h.url;
    FB.local = { url, list };
    FB.pending++;
    FB.chain = FB.chain.then(() => api(url, h.method || 'PUT', { fallbacks: list })).then((r) => { h.confirmed = h.confirmedOf(r); }, (e) => {
      if (seq !== FB.seq) return;
      FB.local = { url, list: h.confirmed };
      h.apply(h.confirmed);
      toast(`Could not save fallbacks: ${e.message}`, { kind: 'error' });
    }).finally(() => { if (!--FB.pending) { FB.local = null; fbRender(); } });
  }
  fbRender();
}
function openFallbacks(host, anchor) {
  const m = $('fbModal');
  if (m.hidden) FB.lastFocus = anchor;
  FB.host = host;
  host.confirmed = host.list();
  FB.fe = { refresh: fbRender };
  m.hidden = false;
  fbRender();
  // A composer-style menu next to its button, on phones too (placeMenu); Esc or a click outside closes it.
  placeMenu(m.querySelector('.modal-panel'), anchor);
  (m.querySelector('#fbBody .fe-row') || m.querySelector('#fbBody .fe-add-btn'))?.focus();
}
function closeFallbacks() {
  $('fbModal').hidden = true;
  const back = FB.lastFocus?.isConnected ? FB.lastFocus : FB.host?.focusBack?.();
  FB.host = null;
  FB.fe = {};
  back?.focus?.();
}
$('fbChip').addEventListener('click', () => openFallbacks(chatFallbacks(), $('fbChip')));
$('fbModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeFallbacks(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('fbModal').hidden && !e.target.closest?.('.fe-add')) { e.stopImmediatePropagation(); closeFallbacks(); } }, true);

// ---------- reasoning effort (Claude and Codex only: agents that list `efforts` in /api/agents) ----------
// The composer's pill shows the chat's effort ('Effort: high'; the level word alone on phones) while the picked agent has
// levels, and opens #effPop, a composer menu holding a slider over the agent's levels (tick labels under it, a Default
// toggle above). Every change saves at once (PUT /api/convos/:id/effort). null = the model's default.
// A new chat keeps it as its draft and sends it with its first set_model. Tasks read the chat's effort live when a session
// starts (orchestrator taskEffort), so the toast says when it takes effect.
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// Levels read in title case wherever they are shown ('High', 'X-High'); the API and saved chats keep the lowercase ids.
const effortName = (l) => (l === 'xhigh' ? 'X-High' : l ? l[0].toUpperCase() + l.slice(1) : 'Default');
const EFFORT_HINT = {
  low: 'Lightest and fastest. Uses the least of your limit.',
  medium: 'Quick, with some thinking. Fine for routine edits.',
  high: 'Careful reasoning for most coding work.',
  xhigh: 'Deeper reasoning for hard problems. Slower, uses more of your limit.',
  max: 'Very deep reasoning. Slow, uses much more of your limit.',
  ultra: 'Deepest and slowest. Uses the most of your limit.',
};
// The top level always reads as the deepest, whichever it is.
const effortHint = (levels, l) => (l === levels.at(-1) ? EFFORT_HINT.ultra : EFFORT_HINT[l] || '');
const agentEntry = (id) => AGENT_LIST.find((a) => a.id === id);
const effortLevels = (agent) => agentEntry(agent)?.efforts || [];
const effortModel = (agent, model) => { const ms = agentEntry(agent)?.models || []; return (model && ms.find((m) => m.id === model || m.resolved === model)) || ms.find((m) => m.default) || ms[0] || null; };
// The levels this model takes (a discovered model may narrow its agent's, e.g. GPT-5.5 stops at xhigh).
function modelEfforts(agent, model) {
  const levels = effortLevels(agent), m = effortModel(agent, model);
  return m?.efforts?.length ? levels.filter((l) => m.efforts.includes(l)) : levels;
}
// Mirrors agents.mjs clampEffort: the level itself, else the nearest lower one in `levels`, else the lowest.
function clampEffortTo(levels, level) {
  const rank = EFFORT_ORDER.indexOf(level);
  if (!levels.length || rank < 0) return null;
  if (levels.includes(level)) return level;
  const lower = levels.filter((l) => EFFORT_ORDER.indexOf(l) < rank);
  return lower.length ? lower.at(-1) : levels[0];
}
// What 'Default' runs as: the model's own default level (Codex reports it; Claude's is high, per the Agent SDK).
const defaultEffort = (agent, model) => effortModel(agent, model)?.defaultEffort || (agent === 'claude' ? 'high' : null);
// The chat the composer edits: its agent/model (the picker) and effort (the open chat's, else the new-chat draft).
function composerEffort() {
  const { agent, model } = parsePick($('model').dataset.prev || 'claude|');
  return { agent, model: model || null, effort: (state.cid ? currentConvo()?.effort : state.draftEffort) ?? null };
}
const EF = { chain: Promise.resolve(), seq: 0, toast: null };
function renderEffChip() {
  const chip = $('effChip'), { agent, model, effort } = composerEffort();
  const levels = effortLevels(agent);
  chip.hidden = !levels.length;
  if (!levels.length) return;
  const shown = effort ? clampEffortTo(levels, effort) : null;
  $('effVal').textContent = effortName(shown);
  chip.classList.toggle('none', !shown);
  chip.setAttribute('aria-label', `Effort: ${effortName(shown)}`);
  const def = defaultEffort(agent, model);
  chip.title = shown ? `Reasoning effort: ${effortName(shown)}. ${effortHint(levels, shown)}` : `Reasoning effort: the model's default${def ? ` (${effortName(def)})` : ''}`;
}
function renderEff() {
  renderEffChip();
  if (CM.open?.menu !== $('effPop')) return;
  if (!effortLevels(composerEffort().agent).length) return closeMenu(false);
  syncEffMenu();
}
// Built once per open; syncEffMenu updates it in place so a drag or keyboard focus survives saves.
function buildEffMenu(menu) {
  menu.classList.add('eff-menu');
  const top = el('div', 'eff-top'), def = el('button', 'eff-def-btn', 'Default');
  def.type = 'button';
  def.id = 'effDefault';
  def.addEventListener('click', () => { effSave(null); $('effRange').focus(); });
  top.append(el('span', 'cm-head', 'Effort'), def);
  const range = el('input');
  range.type = 'range';
  range.id = 'effRange';
  range.min = '0';
  range.step = '1';
  range.setAttribute('aria-label', 'Effort');
  // Arrow keys, Home/End and dragging move it; `input` previews, `change` saves.
  range.addEventListener('input', () => syncEffMenu(effortLevels(composerEffort().agent)[Number(range.value)]));
  range.addEventListener('change', () => effSave(effortLevels(composerEffort().agent)[Number(range.value)] || null));
  const note = el('p', 'eff-note');
  note.id = 'effNote';
  const ticks = el('div', 'eff-ticks');
  ticks.id = 'effTicks';
  ticks.setAttribute('aria-hidden', 'true');
  menu.append(top, range, ticks, note);
  syncEffMenu();
}
// preview: a level being dragged to (not saved yet).
function syncEffMenu(preview) {
  const range = $('effRange');
  if (!range) return;
  const { agent, model, effort } = composerEffort(), levels = effortLevels(agent);
  const ok = modelEfforts(agent, model), def = defaultEffort(agent, model);
  const level = preview || (effort ? clampEffortTo(levels, effort) : null);
  const at = level || clampEffortTo(levels, def) || levels[Math.floor(levels.length / 2)];
  range.max = String(levels.length - 1);
  range.value = String(levels.indexOf(at));
  range.classList.toggle('is-default', !level);
  range.style.setProperty('--fill', `${levels.length > 1 ? (levels.indexOf(at) / (levels.length - 1)) * 100 : 0}%`);
  range.setAttribute('aria-valuetext', level ? `${effortName(level)}. ${effortHint(levels, level)}` : `Default, ${effortName(at)}`);
  range.title = level ? effortHint(levels, level) : `The model's own setting: ${effortName(at)}`;
  $('effDefault').setAttribute('aria-pressed', String(!level));
  $('effDefault').title = def ? `The model's own setting: ${effortName(def)}` : "The model's own setting";
  const runsAs = level && clampEffortTo(ok, level);
  $('effNote').hidden = !runsAs || runsAs === level;
  if (runsAs && runsAs !== level) $('effNote').textContent = `${modelName(agent, model)} runs this as ${effortName(runsAs)}`;
  const ticks = $('effTicks');
  ticks.textContent = '';
  ticks.style.setProperty('--n', String(Math.max(1, levels.length - 1)));
  levels.forEach((l, i) => {
    const b = el('button', 'eff-tick' + (l === at ? ' on' : '') + (ok.includes(l) ? '' : ' eff-off'), effortName(l));
    b.dataset.level = l;
    b.type = 'button';
    b.tabIndex = -1; // the slider has the keyboard; ticks are for pointers
    b.style.setProperty('--i', String(i));
    b.title = ok.includes(l) ? effortHint(levels, l) : `${modelName(agent, model)} runs this as ${effortName(clampEffortTo(ok, l))}`;
    b.onclick = () => { effSave(l); range.focus(); };
    ticks.append(b);
  });
}
function effToast(level) {
  EF.toast?.close?.();
  EF.toast = toast(`Effort set to ${level ? effortName(level) : 'the model default'}. Queued tasks use it when they start; running tasks switch at their next session.`);
}
// Optimistic: shown at once; PUTs run in order and only the latest one's result speaks (toast, or rollback on error).
function effSave(level) {
  const cid = state.cid;
  if (!cid) {
    state.draftEffort = level;
    store.set('cw.effort', level || '');
    renderEff();
    return effToast(level);
  }
  const c = currentConvo();
  if (!c || (c.effort ?? null) === level) return;
  const before = c.effort ?? null, seq = ++EF.seq;
  c.effort = level;
  renderEff();
  EF.chain = EF.chain.then(() => api(`/api/convos/${cid}/effort`, 'PUT', { effort: level })).then((r) => {
    if (seq !== EF.seq) return;
    const x = state.convos.find((y) => y.id === cid);
    if (x) x.effort = r.effort ?? null;
    effToast(r.effort ?? null);
    renderEff();
  }, (e) => {
    if (seq !== EF.seq) return;
    const x = state.convos.find((y) => y.id === cid);
    if (x) x.effort = before;
    renderEff();
    toast(`Could not save effort: ${e.message}`, { kind: 'error' });
  });
}
bindMenu($('effChip'), $('effPop'), buildEffMenu, () => {});
// Switching the picker between agents keeps the chat's effort at the nearest level the new agent takes (the server
// clamps the saved chat the same way on set_model; this keeps the draft and the pill in step).
function clampEffortForAgent(agent) {
  const levels = effortLevels(agent);
  if (!levels.length) return;
  if (state.cid) { const c = currentConvo(); if (c?.effort) c.effort = clampEffortTo(levels, c.effort); }
  else if (state.draftEffort) { state.draftEffort = clampEffortTo(levels, state.draftEffort); store.set('cw.effort', state.draftEffort || ''); }
}
function fbRender() {
  const h = FB.host;
  if (!h || $('fbModal').hidden) return;
  if (FB.fe.busy) { FB.fe.stale = true; return; } // a pressed/dragged row would be detached mid-gesture
  // Re-renders (save, live updates) keep keyboard focus on the same row.
  const focused = document.activeElement?.closest?.('#fbBody .fe-row')?.dataset.key;
  if (focused && !FB.fe.focusKey) FB.fe.focusKey = focused;
  const list = (FB.local?.url === h.url ? FB.local.list : h.list()) || [], name = fbName(h.primary);
  $('fbTitle').textContent = `If ${name} hits its limit`;
  $('fbSub').textContent = h.sub || ''; // the title says it; a sub only for what's specific (a running task, a custom list)
  // A task's own list that differs from its chat's can go back to the chat's.
  const back = !FB.pending && h.reset?.();
  if (back !== undefined && back !== false) {
    const rb = el('button', 'link-btn inline', "Reset to chat's list");
    rb.type = 'button';
    rb.onclick = () => fbSave(back);
    if ($('fbSub').textContent) $('fbSub').append(el('br'));
    $('fbSub').append(el('span', '', 'Custom list for this task · '), rb);
  }
  renderFallbackEditor($('fbBody'), { list, onChange: fbSave, ui: FB.fe,
    exclude: [{ agent: h.primary.agent, model: fbModelOf(h.primary) }], empty: h.empty ? h.empty(name) : `No fallbacks. ${h.what[0].toUpperCase()}${h.what.slice(1)} wait for the reset.` });
}
// Chats that had the old per-chat delegation flag on (#153 removed it; it lived in localStorage) with no list get an empty one.
function migrateAutoDelegate() {
  for (const c of state.convos) {
    if (store.get('cw.auto.' + c.id) == null) continue;
    if (store.get('cw.auto.' + c.id) === '1' && c.fallbacks == null) { c.fallbacks = []; api(`/api/convos/${c.id}/fallbacks`, 'PUT', { fallbacks: [] }).catch(() => {}); }
    store.del('cw.auto.' + c.id);
  }
  store.del('cw.auto');
}
// Reusable fallback-order editor. list: [{agent, model, label?}] in order. onChange(next) gets [{agent, model}].
// catalog: agents with models for '+ Add model' (AGENT_LIST shape); exclude: [{agent, model}] that can't be added;
// empty: the text for an empty list; ui: a host-owned object that keeps add-panel, search and focus state across
// re-renders. While a row is pressed or dragged ui.busy is set: the host should skip re-rendering, set ui.stale, and
// provide ui.refresh to catch up after.
function renderFallbackEditor(container, opts) {
  const { list, onChange, catalog = AGENT_LIST, exclude = [], empty = 'No fallbacks.', ui = {} } = opts;
  const rows = list || [];
  const plain = (xs) => xs.map(({ agent, model }) => ({ agent, model }));
  const name = (r) => r.label || modelLabel(r.agent, r.model);
  const change = (next) => { ui.rows = next; onChange(plain(next)); };
  ui.rows = rows;
  container.textContent = '';
  container.classList.add('fe');
  const ol = el('ol', 'fe-list');
  ol.setAttribute('aria-label', 'Fallback order. Alt+Up or Alt+Down moves the focused model; Delete removes it.');
  const move = (i, j) => {
    if (j < 0 || j >= rows.length || i === j) return;
    const next = [...rows], [r] = next.splice(i, 1);
    next.splice(j, 0, r);
    ui.focusKey = apKey(r);
    change(next);
  };
  const remove = (i) => {
    const r = rows[i], near = rows[i + 1] || rows[i - 1];
    ui.focusKey = near ? apKey(near) : null;
    ui.focusAdd = !near;
    change(rows.filter((_, j) => j !== i));
    toast(`Removed ${name(r)}`, { kind: 'success', action: 'Undo', run: () => {
      const cur = ui.rows || [];
      if (cur.some((x) => apKey(x) === apKey(r))) return;
      const next = [...cur];
      next.splice(Math.min(i, next.length), 0, r);
      ui.focusKey = apKey(r);
      change(next);
    } });
  };
  rows.forEach((r, i) => {
    const li = el('li', 'fe-row');
    li.tabIndex = 0;
    li.dataset.key = apKey(r);
    li.setAttribute('aria-label', `${i + 1}. ${name(r)}, ${shortLabel(r.agent)}${fbLimit(r) ? ', limited now' : ''}`);
    const grip = el('span', 'fe-grip');
    grip.innerHTML = '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></g></svg>';
    grip.title = 'Drag to reorder';
    const rm = el('button', 'fe-rm');
    rm.type = 'button';
    rm.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    rm.setAttribute('aria-label', `Remove ${name(r)}`);
    rm.title = 'Remove';
    rm.addEventListener('click', () => remove(i));
    li.append(grip, el('span', 'fe-pos', String(i + 1)), feMain(r), rm);
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(i, i + (e.key === 'ArrowUp' ? -1 : 1)); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); (e.key === 'ArrowUp' ? li.previousElementSibling : li.nextElementSibling)?.focus(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(i); }
    });
    li.addEventListener('pointerdown', (e) => feDrag(e, ol, li, i, ui, move));
    ol.append(li);
  });
  // A long-pressed row must not scroll the sheet on iOS (touchmove is the only cancelable hook there).
  ol.addEventListener('touchmove', (e) => { if (ui.dragging) e.preventDefault(); }, { passive: false });
  if (rows.length) container.append(ol);
  else container.append(el('p', 'fe-hint', empty));

  const foot = el('div', 'fe-foot');
  const addBtn = el('button', 'btn small fe-add-btn', '+ Add model');
  addBtn.type = 'button';
  addBtn.setAttribute('aria-expanded', String(!!ui.addOpen));
  addBtn.addEventListener('click', () => { ui.addOpen = !ui.addOpen; ui.search = ''; renderFallbackEditor(container, opts); });
  foot.append(addBtn);
  container.append(foot);
  if (ui.addOpen) {
    const panel = el('div', 'fe-add');
    const input = el('input', 'fe-search');
    input.type = 'search'; input.placeholder = 'Search models'; input.value = ui.search || '';
    input.setAttribute('aria-label', 'Search models');
    const results = el('div', 'fe-results');
    const taken = new Set([...rows, ...exclude].map(apKey));
    const fill = () => {
      results.textContent = '';
      const q = (ui.search || '').toLowerCase().trim();
      for (const a of catalog) {
        if (!a.available || a.loggedIn === false) continue;
        const ms = (a.models || []).filter((m) => !q || `${m.label} ${m.id} ${a.label}`.toLowerCase().includes(q));
        if (!ms.length) continue;
        results.append(el('h4', 'fe-group', shortLabel(a.id)));
        for (const m of ms) {
          const has = taken.has(`${a.id}/${m.id}`);
          const b = el('button', 'fe-opt');
          b.type = 'button'; b.disabled = has;
          b.append(el('span', 'fe-model', m.label || m.id), el('span', 'fe-agent', has ? 'Added' : ''));
          b.addEventListener('click', () => { ui.addOpen = false; ui.focusKey = `${a.id}/${m.id}`; change([...rows, { agent: a.id, model: m.id, label: m.label }]); });
          results.append(b);
        }
      }
      if (!results.children.length) results.append(el('p', 'fe-hint', q ? 'No models match.' : 'No signed-in agents have models.'));
    };
    input.addEventListener('input', () => { ui.search = input.value; fill(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); ui.addOpen = false; renderFallbackEditor(container, opts); container.querySelector('.fe-add-btn')?.focus(); }
      else if (e.key === 'Enter') { e.preventDefault(); results.querySelector('.fe-opt:not(:disabled)')?.click(); }
    });
    fill();
    panel.append(input, results);
    container.append(panel);
    if (!ui.focusKey) setTimeout(() => input.isConnected && document.activeElement !== input && input.focus(), 0);
  }
  if (ui.focusKey) {
    const key = ui.focusKey;
    ui.focusKey = null;
    [...ol.children].find((li) => li.dataset.key === key)?.focus();
  } else if (ui.focusAdd) {
    ui.focusAdd = false;
    addBtn.focus();
  }
}
// A row's text: model name, its agent in muted text, and a small dot while that model is limited.
function feMain(r) {
  const main = el('div', 'fe-main'), top = el('div', 'fe-name'), lim = fbLimit(r);
  top.append(el('span', 'fe-model', r.label || modelLabel(r.agent, r.model)), el('span', 'fe-agent', shortLabel(r.agent)));
  if (lim) {
    const dot = el('span', 'fe-lim');
    dot.title = `Limited until ${fmtUntil(lim.until)}`;
    top.append(dot);
  }
  main.append(top);
  return main;
}
// Drag a fallback row with Pointer Events: mouse/pen after 4px, touch after a 350 ms long-press (or at once on the
// handle). Rows in between slide to show the drop slot; the drop calls move(from, to).
function feDrag(e, ol, li, i, ui, move) {
  if (e.button || e.target.closest('button')) return;
  const touch = e.pointerType === 'touch', items = [...ol.children], y0 = e.clientY, id = e.pointerId;
  const step = items.length > 1 ? items[1].getBoundingClientRect().top - items[0].getBoundingClientRect().top : li.offsetHeight;
  let started = false, target = i, timer = 0;
  ui.busy = true;
  const start = () => {
    started = ui.dragging = true;
    ol.classList.add('dragging'); li.classList.add('fe-lift'); li.classList.remove('fe-press');
    try { li.setPointerCapture(id); } catch {}
  };
  const onMove = (ev) => {
    if (ev.pointerId !== id) return;
    const dy = ev.clientY - y0;
    if (!started) {
      if (touch) { if (Math.abs(dy) > 8) end(); return; }
      if (Math.abs(dy) < 4) return;
      start();
    }
    ev.preventDefault();
    target = Math.max(0, Math.min(items.length - 1, i + Math.round(dy / step)));
    li.style.transform = `translateY(${Math.max(-i * step - 8, Math.min((items.length - 1 - i) * step + 8, dy))}px)`;
    items.forEach((it, j) => { if (j !== i) it.style.transform = j > i && j <= target ? `translateY(${-step}px)` : j < i && j >= target ? `translateY(${step}px)` : ''; });
  };
  const end = (ev) => {
    if (ev && ev.pointerId !== id) return;
    clearTimeout(timer);
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    li.classList.remove('fe-press');
    ui.busy = false;
    const catchUp = () => { if (ui.stale) { ui.stale = false; ui.refresh?.(); } };
    if (!started) return catchUp();
    ui.dragging = false;
    ol.classList.remove('dragging'); li.classList.remove('fe-lift');
    items.forEach((it) => (it.style.transform = ''));
    if (ev?.type === 'pointerup' && target !== i) { ui.stale = false; move(i, target); }
    else { li.focus(); catchUp(); }
  };
  addEventListener('pointermove', onMove, { passive: false });
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
  if (!touch) return;
  if (e.target.closest('.fe-grip')) start();
  else { li.classList.add('fe-press'); timer = setTimeout(start, 350); }
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
  sel.value = val;
  renderPickChip();
}
function renderAgentPicker() {
  const sel = $('model'), keep = sel.dataset.prev || sel.value;
  sel.textContent = '';
  for (const a of AGENT_LIST) {
    const g = document.createElement('optgroup');
    g.label = !a.available ? `${a.label} (not installed)` : a.loggedIn === false ? `${a.label} (signed out)` : a.label;
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
  setPick(keep);
  refreshMenu($('modelPop'), buildModelMenu);
}
// The model menu: one group per usable agent (its Default, then its models), unusable agents last as faint headers.
// The <select> stays the source of truth: a pick sets its value and fires its change event.
function buildModelMenu(menu) {
  const sel = $('model');
  const groups = [...sel.children].filter((g) => g.tagName === 'OPTGROUP').sort((a, b) => a.disabled - b.disabled);
  for (const g of groups) {
    menu.append(el('div', 'cm-head' + (g.disabled ? ' off' : ''), g.label));
    if (g.disabled) continue; // signed out / not installed: the header says so
    const def = [...g.children].find((o) => / \(default\)$/.test(o.textContent));
    for (const o of g.children) {
      const isDef = o.value.endsWith('|');
      const label = isDef ? 'Default' : o.textContent.replace(/^[^·]+ · /, '').replace(/ \(default\)$/, '');
      const hint = isDef && def ? def.textContent.replace(/^[^·]+ · /, '').replace(/ \(default\)$/, '') : '';
      menu.append(menuOpt(label, { value: o.value, selected: o.value === sel.value, hint, title: o.title, disabled: o.disabled }));
    }
  }
}
bindMenu($('modelChip'), $('modelPop'), buildModelMenu, (v) => {
  const sel = $('model');
  sel.value = v;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
api('/api/agents').then((d) => { AGENT_LIST = d.agents || []; renderAgentPicker(); }).catch(() => {});
// Which model a task is on and what happens at a limit: the one vocabulary for cards, the drawer and the chat.
//   normal:    'Opus'                     (running, done, or queued with no fallbacks)
//   next:      'Opus · then Astra'        (queued with fallbacks; the full list is in `tip` and the drawer)
//   waiting:   'Waiting for Opus · 5:00 AM' (queued while its limit is hit and no fallback has usage)
//   delegated: 'Astra · moved from Opus (limit until 5:00 AM)'
// ctx: { blocks (state.blocks), name(agent, model), clock(epoch s), now (epoch s) }; defaults to the app's live state.
function modelStatus(t, ctx = modelCtx()) {
  const { blocks = {}, name, clock, now = Date.now() / 1000 } = ctx;
  const queued = t.status === 'queued';
  // Queued: the route it would take now (runs_on/runs_model); otherwise what it ran on, else what it was given.
  const [agent, model] = queued && t.runs_on ? [t.runs_on, t.runs_model || null]
    : t.ran_agent ? [t.ran_agent, t.ran_model || null] : [t.agent || 'claude', t.model || null];
  const cur = name(agent, model), key = `${agent}/${model}`;
  const list = (t.fallbacks || []).map((f) => ({ ...f, name: name(f.agent, f.model), current: `${f.agent}/${f.model}` === key }));
  const moves = t.moves || [];
  const move = moves[moves.length - 1] || null;
  const fromRaw = move ? move.from : t.delegated_from ? { agent: t.delegated_from.split('/')[0], model: t.delegated_from.split('/').slice(1).join('/') || null } : null;
  const from = fromRaw && name(fromRaw.agent, fromRaw.model);
  const lim = queued && blocks[t.limit_scope || agent];
  const tip = list.length ? `Fallbacks: ${list.map((f) => f.name).join(' → ')}` : 'No fallbacks: waits at a limit';
  const base = { model: cur, agent, from, list, until: null, tip };
  if (lim && lim.until > now) return { ...base, kind: 'waiting', until: lim.until, text: `Waiting for ${cur} · ${clock(lim.until)}` };
  if (from) {
    const why = move?.until ? ` (limit until ${clock(move.until)})` : move?.by === 'owner' ? ' (by you)' : move?.by === 'spread' ? ' (to run in parallel)' : '';
    return { ...base, kind: 'delegated', until: move?.until || null, text: `${cur} · moved from ${from}${why}` };
  }
  const next = queued && list.find((f) => !f.current);
  if (next) return { ...base, kind: 'next', next: next.name, text: `${cur} · then ${next.name}` };
  return { ...base, kind: 'normal', text: cur };
}
function modelCtx() {
  return { blocks: O.state?.blocks || {}, name: modelName, clock: (sec) => fmtWhen(sec * 1000), now: Date.now() / 1000 };
}
// A model's display name: its label from the CLI's list, else the agent's default model, else the agent.
function modelName(agent, model) {
  const a = AGENT_LIST.find((x) => x.id === agent);
  if (!model) { const d = a?.models.find((m) => m.default) || a?.models[0]; return d ? d.label || d.id : agentLabel(agent); }
  return modelLabel(agent, model);
}
const MOVED_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M5 5v6a4 4 0 0 0 4 4h10m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// The model chip: modelStatus text, tinted when it is not the primary (delegated) or waiting on a limit.
function modelChip(t, ms = modelStatus(t)) {
  const b = el('span', `tc-tag model ${ms.kind}`);
  if (ms.kind === 'delegated') b.innerHTML = MOVED_SVG;
  b.append(document.createTextNode(ms.text));
  b.title = [ms.tip, t.route_note].filter(Boolean).join(' — ');
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

$('folderBtn')?.addEventListener('click', openPicker);
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

// ---------- Splash ----------
// index.html opens on a splash with the app inert behind it. It lifts once the first connection has delivered what the
// first screen shows: the chat list, and the open chat's history when there is one. While the server is unreachable it
// says so and, after a few seconds, offers "Open anyway". Later reconnects never bring it back.
const splash = { need: new Set(['convos']), skipTimer: null };
function splashStatus(text) { if ($('splash')) $('splashStatus').textContent = text; }
function splashReady(what) {
  if (splash.need.delete(what) && !splash.need.size) hideSplash();
}
function hideSplash() {
  const s = $('splash');
  if (!s || s.classList.contains('done')) return;
  clearTimeout(splash.skipTimer);
  $('app').inert = false;
  s.classList.add('done');
  setTimeout(() => s.remove(), 400); // after the fade (instant when reduced motion turns transitions off)
  $('input').focus({ preventScroll: true });
}
$('splashSkip').addEventListener('click', hideSplash);
splash.skipTimer = setTimeout(() => { if ($('splash')) $('splashSkip').hidden = false; }, 8000);

// ---------- task completion sound ----------
const DEFAULT_TASK_SOUND = '/sounds/task-done.mp3';
const taskSound = new Audio(DEFAULT_TASK_SOUND);
taskSound.preload = 'auto';
taskSound.volume = 0.6;
const completionSound = { synced: false, statuses: new Map(), done: new Set(), lastPlayed: -Infinity, unlocking: null };
function resetCompletionSync() {
  completionSound.synced = false;
  completionSound.statuses.clear();
}
async function playTaskSound() {
  try {
    await completionSound.unlocking;
    taskSound.currentTime = 0;
    await taskSound.play();
  } catch {} // Browser autoplay policy may still disallow background audio.
}
function unlockTaskSound() {
  document.removeEventListener('pointerdown', unlockTaskSound);
  document.removeEventListener('keydown', unlockTaskSound);
  taskSound.muted = true;
  completionSound.unlocking = (async () => {
    try { await taskSound.play(); } catch {}
    taskSound.pause();
    taskSound.currentTime = 0;
    taskSound.muted = false;
  })();
}
document.addEventListener('pointerdown', unlockTaskSound);
document.addEventListener('keydown', unlockTaskSound);
$('stSound').checked = store.get('cw.taskSound') !== 'off';
$('stSound').addEventListener('change', (e) => store.set('cw.taskSound', e.target.checked ? 'on' : 'off'));
$('stSoundTest').addEventListener('click', playTaskSound);
// An uploaded MP3 (GET /api/settings/sound) replaces the default chime for every browser.
function setSoundInfo(sound) {
  taskSound.src = sound?.custom ? `/api/settings/sound?v=${sound.at}` : DEFAULT_TASK_SOUND;
  $('stSoundName').textContent = sound?.custom ? 'Your MP3' : 'Default chime';
  $('stSoundReset').hidden = !sound?.custom;
}
api('/api/settings').then((d) => setSoundInfo(d.sound)).catch(() => {});
$('stSoundUpload').addEventListener('click', () => $('stSoundFile').click());
$('stSoundFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > 2 * 1024 * 1024) return toast('That file is over 2 MB. Pick a shorter MP3.', { kind: 'error' });
  try {
    const r = await fetch('/api/settings/sound', { method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: f });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`);
    setSoundInfo(d.sound);
    toast('Sound updated');
    playTaskSound();
  } catch (err) { toast(err.message, { kind: 'error' }); }
});
$('stSoundReset').addEventListener('click', async () => {
  try { setSoundInfo((await api('/api/settings/sound', 'DELETE')).sound); }
  catch (err) { toast(err.message, { kind: 'error' }); }
});
function syncCompletionSound(tasks) {
  if (!completionSound.synced) completionSound.statuses.clear();
  for (const t of tasks || []) {
    completionSound.statuses.set(t.id, t.status);
    if (t.status === 'done') completionSound.done.add(t.id);
  }
  completionSound.synced = true;
}
function observeTaskCompletion(t) {
  const previous = completionSound.statuses.get(t.id);
  completionSound.statuses.set(t.id, t.status);
  // A review break that starts waiting for the owner chimes like a finished task.
  const review = t.status === 'awaiting_review' && completionSound.synced && previous && previous !== 'awaiting_review';
  if (!review) {
    if (t.status !== 'done' || completionSound.done.has(t.id)) return;
    completionSound.done.add(t.id);
    if (!completionSound.synced || !previous || previous === 'done' || !['work', 'reflect'].includes(t.kind)) return;
  }
  if (!$('stSound').checked || (document.visibilityState !== 'hidden' && document.hasFocus())) return;
  const now = performance.now();
  if (now - completionSound.lastPlayed < 3000) return;
  completionSound.lastPlayed = now;
  void playTaskSound();
}

// ---------- WebSocket ----------
let retry = 0; // failed attempts since the last open: 0 before the first open reads as "Connecting…"
// node: the machine the Connections window shows ('controller' or a worker id); remote: that worker's rows.
const CONN = { list: [], sig: '', drafts: {}, sent: {}, dismissed: {}, justDone: {}, lastFocus: null, node: 'controller', nodes: [], remote: [] };
function connect() {
  resetCompletionSync();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    retry = 0;
    splashStatus('Loading your chats…');
    renderConnFoot();
    send({ t: 'open', cid: state.cid });
    pollUpdates();
    refreshConnections();
    if (!$('serverModal').hidden) send({ t: 'metrics_sub', on: true });
    if (O.drawer) { send({ t: 'owatch', taskId: O.drawer, on: true }); loadDetail(); }
  };
  ws.onclose = (e) => {
    resetCompletionSync();
    updateLive();
    if (e.code === 4001) { location.href = '/login'; return; }
    // A failed upgrade usually means the login expired; check before retrying.
    fetch('/api/status').then((r) => { if (r.status === 401) location.href = '/login'; }).catch(() => {});
    const wait = Math.min(1000 * 2 ** retry++, 15000);
    setTimeout(connect, wait);
    splashStatus(`Can't reach the server yet · retrying in ${Math.round(wait / 1000)} s`);
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
  if (msg.t === 'oprojects') { applyProjectOrder(msg.order || []); renderConvoList(); return renderOrchBar(); }
  if (['otask', 'oproject', 'ostate', 'orun', 'oorder', 'olane'].includes(msg.t)) return onOrch(msg);
  if (msg.t === 'connections') return msg.node ? applyRemote(msg.node, msg.connections) : applyConnections(msg.connections);
  if (msg.t === 'cluster') {
    // An auto-drain or a failed self-update: the owner should see it now (it stays on the machine's card and in the log).
    if (msg.kind === 'notice') { toast(msg.text, { kind: 'warn', duration: 12000 }); return scheduleMachines(0); }
    scheduleMachines(msg.kind === 'resources' ? 600 : 0);
    if (msg.kind === 'resources') return; // only a worker's CPU/RAM reading changed
    if (!$('connsModal').hidden) loadConnNodes();
    return checkPairing();
  }
  if (msg.t === 'models') return api('/api/agents').then((d) => { AGENT_LIST = d.agents || []; renderAgentPicker(); }).catch(() => {});
  if (msg.t === 'status') { upd.pending = !!msg.restartPending; return renderUpdateBanner(); }
  if (msg.t === 'ext') return window.Ext?.changed(msg.kind); // skills/MCP/subagents/personas changed (ext.js)
  if (msg.t === 'convos') {
    const drChat = O.detail?.project?.convo_id, effortOf = () => state.convos.find((c) => c.id === drChat)?.effort ?? null;
    const drEffort = drChat ? effortOf() : null;
    state.convos = msg.convos;
    if (state.cid && !state.convos.find((c) => c.id === state.cid)) openConvo(null);
    renderConvoList();
    updateFolderChip();
    updateHeader();
    migrateAutoDelegate();
    renderFbChip();
    fbRender();
    renderEff();
    window.Ext?.renderChip(); // the persona chip follows the chat's persona
    if (drChat && O.drawer && effortOf() !== drEffort) renderDrawer(true); // its Effort row follows the chat's live effort
    renderUsage();
    if (!state.cid) splash.need.delete('history'); // no chat open (or it was deleted): nothing more to wait for
    splashReady('convos');
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
      splashReady('history');
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
    $('mTopCard'), // two cards wide, in the grid right after the six metric cards
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
// Subscription limits belong to agents, so two models sharing an agent share one slide.
const usageSlides = { agent: null, ids: [], data: null, loading: false, at: 0, error: false };
function runningUsageAgents() {
  const runs = O.state?.activeUsage || [...O.tasks.values()].filter((t) => t.status === 'running').map((t) => ({ agent: t.kind === 'plan' ? t.agent || 'claude' : t.ran_agent || t.agent || 'claude' }));
  const ids = new Set(runs.map((r) => r.agent));
  for (const c of state.convos) if (c.id === state.cid ? state.busy : c.busy) ids.add(c.agent || 'claude');
  return ids.size ? [...ids].sort() : [currentConvo()?.agent || 'claude'];
}
async function loadSidebarUsage() {
  if (usageSlides.loading) return;
  usageSlides.loading = true;
  try {
    usageSlides.data = (await api('/api/usage/history?range=6h')).agents;
    usageSlides.at = Date.now();
    usageSlides.error = false;
  } catch { usageSlides.error = true; }
  finally { usageSlides.loading = false; renderUsage(); }
}
function sidebarUsage() {
  if (usageSlides.agent === 'claude') return M.usage;
  const windows = Object.entries(usageSlides.data?.[usageSlides.agent]?.status?.windows || {});
  const active = windows.filter(([, w]) => !w.stale && (!w.resetsAt || w.resetsAt * 1000 > Date.now()));
  return {
    available: !!active.length,
    updatedAt: windows.length ? Math.max(...windows.map(([, w]) => w.t)) : null,
    windows: active.sort(([a], [b]) => byWin(a, b)).map(([id, w]) => ({ ...w, id, label: winLabel(id), resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null })),
  };
}
// Claude's card: 5-hour and Weekly, then each model-specific window the plan reports while it has a reading (the
// Opus/Sonnet weeklies, or model-scoped ones such as Fable), as extra rows.
function claudeCardWindows(u) {
  const rows = [{ ...u?.session, label: '5-hour' }, { ...u?.weekly, label: 'Weekly' }];
  for (const [label, w] of [['Opus', u?.weeklyOpus], ['Sonnet', u?.weeklySonnet], ...(u?.models || []).map((m) => [m.name, m])]) {
    if (!label || w?.pct == null || rows.some((r) => r.label.toLowerCase() === String(label).toLowerCase())) continue;
    rows.push({ pct: w.pct, resetsAt: w.resetsAt, label, tip: `${label}: its own limit, used on top of 5-hour and Weekly` });
  }
  return rows;
}
function renderUsage(fresh = false) {
  renderFbChip(); // its usage dots follow the same readings
  renderReflectBtn();
  const ids = runningUsageAgents();
  usageSlides.ids = ids;
  if (!ids.includes(usageSlides.agent)) usageSlides.agent = ids[0];
  const id = usageSlides.agent, u = sidebarUsage();
  const name = id === 'claude' ? 'Claude' : agentLabel(id);
  const title = `${name} limits${ids.length > 1 ? ` · ${ids.indexOf(id) + 1}/${ids.length}` : ''}`;
  blurSwap($('usageTitle'), title);
  $('usageCard').title = `${name} subscription limits · open usage over time`;
  $('usRefresh').setAttribute('aria-label', `Refresh ${name} usage limits`);
  const windows = id === 'claude' ? claudeCardWindows(u) : (u?.windows || []);
  // Two fixed rows; any windows past those get compact rows in #usMore.
  const more = $('usMore'), rows = [$('usSessionRow'), $('usWeeklyRow')];
  while (more.children.length < windows.length - 2) {
    const r = el('div', 'ms-row');
    r.append(el('span'), el('span', 'ms-bar'), el('span', 'ms-val'));
    r.children[1].append(el('i'));
    more.append(r);
  }
  while (more.children.length > Math.max(0, windows.length - 2)) more.lastChild.remove();
  rows.push(...more.children);
  rows.forEach((row, i) => {
    const w = windows[i], [lab, bar, val] = row.children;
    blurSwap(lab, w?.label || (i ? 'Weekly' : '5-hour'));
    blurSwap(val, w?.pct != null ? fmtPct(w.pct) : '–', fresh);
    setBar(bar.firstElementChild, w?.pct ?? 0);
    row.title = [w?.tip, w?.resetsAt ? fmtReset(w.resetsAt) : ''].filter(Boolean).join('\n');
  });
  let note;
  if (id === 'claude' && !u?.updatedAt) note = 'Checking plan limits…';
  else if (!u?.available) note = id === 'claude'
    ? (u?.error ? `Couldn't read limits: ${u.error}` : 'Plan limits unavailable')
    : usageSlides.error ? "Couldn't refresh limits" : limitsHidden(id) ? 'Limits not exposed by CLI' : 'No current limits reported by this agent';
  else {
    // Windows that reset together share a line ("Weekly and Fable reset Mon 3:00 AM · in 2d 4h").
    const byReset = new Map();
    for (const w of windows) if (w.resetsAt && w.pct != null) { const at = fmtResetAt(w.resetsAt); byReset.set(at, [...(byReset.get(at) || []), w.label]); }
    note = [...byReset].map(([at, labels]) => `${labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)} reset` : `${labels[0]} resets`} ${at}`).join('\n');
    if (u.extraUsage === true) note += ' ⚠ Extra usage is ON: it can bill beyond your plan';
  }
  $('usNote').title = note.trim();
  blurSwap($('usNote'), note.trim(), fresh);
  renderUsageAge();
}
setInterval(() => {
  if (document.hidden) return;
  const ids = runningUsageAgents();
  usageSlides.agent = ids[(ids.indexOf(usageSlides.agent) + 1) % ids.length];
  renderUsage();
  // Other agents' readings come from the usage log: read once, then only on refresh (no polling).
  if (ids.some((id) => id !== 'claude') && !usageSlides.at && !usageSlides.loading) loadSidebarUsage();
}, 3000);
function renderUsageAge() {
  const u = sidebarUsage();
  if ($('usRefresh').classList.contains('spin')) { blurSwap($('usAge'), 'checking…'); return; }
  if (!u?.updatedAt) { blurSwap($('usAge'), ''); return; }
  const m = Math.floor((Date.now() - u.updatedAt) / 60e3);
  blurSwap($('usAge'), m < 1 ? 'just now' : `${m}m ago`);
  $('usAge').title = `Checked ${new Date(u.updatedAt).toLocaleTimeString()}. ${usageSlides.agent === 'claude' ? 'Updates every 5 seconds.' : 'Updates when you press refresh.'}`;
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
$('usRefresh').addEventListener('click', () => {
  setRefreshing(true);
  // One agent per click: Claude answers over the socket; the others check their CLI, then the usage log is re-read.
  if (usageSlides.agent === 'claude') send({ t: 'usage_refresh' });
  else api(`/api/limits/${usageSlides.agent}/refresh`, 'POST').catch(() => {}).then(loadSidebarUsage).finally(() => setRefreshing(false));
});
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
    if (Date.now() - MC.at > 10e3) scheduleMachines(0); // the controller's own CPU/RAM (and elapsed times) on the Machines cards
  } else if (msg.t === 'mdetail') {
    M.data = msg.d;
  } else if (msg.t === 'usage') {
    M.usage = msg.usage;
    // Auto-refresh lands every 5 s: only a refresh the owner pressed replays the numbers' swap animation.
    const pressed = $('usRefresh').classList.contains('spin');
    setRefreshing(false);
    renderUsage(pressed);
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
  CA.ready = false; // the cluster diagram's first snapshot is drawn as it is, not replayed
  loadMachines();
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
  if (e.key === 'Escape' && !$('serverModal').hidden && $('machineModal').hidden && $('nodeModal').hidden) { e.stopImmediatePropagation(); closeServer(); }
}, true);
setInterval(() => { if (M.usage) renderUsage(); }, 30e3); // keep the "in 2h 9m" countdowns current

// ----- machines (cluster nodes) and the "Add machine" wizard -----
// One card per node from GET /api/cluster/nodes (cluster.mjs view + orchestrator `machines`: running tasks, work slots in
// use and the node's slot count). While Server details is open it re-reads on 'cluster' pushes (node changes, worker
// CPU/RAM readings), task changes and, for the controller's own numbers, its metric ticks (at most every 10 s).
// "Add machine": POST /api/cluster/pair → a one-time code, or {uses: N} → one code for N machines (valid 1 h), embedded in
// a one-line install command per OS (bin/install-worker*.sh, served at /install/…). GET /api/cluster/pair/:code then
// reports waiting → paired (node; a multi-use code: nodes, used) → node.connected; DELETE revokes the code.
const AM = { code: null, expiresAt: 0, uses: 1, pairing: null, err: '', timer: null, lastFocus: null };
const AM_USES = [1, 2, 3, 4, 5, 6, 8, 10];
// power: the Macs whose Power settings are open; stale: a render skipped while one of its menus was in use.
const MC = { nodes: [], at: 0, timer: null, loading: false, power: new Set(), stale: false };
const fmtGB = (b) => `${((b || 0) / 2 ** 30).toFixed(1)} GB`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const NODE_ST = { online: 'Online', draining: 'Draining', disabled: 'Disabled', updating: 'Updating', paused: 'Paused' };
const OS_NAME = { darwin: 'macOS', linux: 'Linux' };
const OS_ICON = { // SF Symbols style: laptopcomputer (macOS) and server.rack (Linux)
  darwin: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><rect x="5" y="5" width="14" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M2.5 18.5h19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  linux: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><rect x="4" y="4" width="16" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="4" y="13" width="16" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 7.5h.01M8 16.5h.01" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
};
async function loadMachines() {
  if (MC.loading) return;
  MC.loading = true;
  try { MC.nodes = (await api('/api/cluster/nodes')).nodes || []; MC.at = Date.now(); } catch { return; } finally { MC.loading = false; }
  renderMachines();
}
// Coalesces bursts (task updates, pushes) into one read while Server details is open.
function scheduleMachines(ms = 600) {
  if ($('serverModal').hidden || MC.timer) return;
  MC.timer = setTimeout(() => { MC.timer = null; if (!$('serverModal').hidden) loadMachines(); }, ms);
}
// Online / Draining / Disabled while connected; away: Asleep (a Mac that went silent), Shut down (bye), else Offline.
// Updating: waiting to be idle for its self-update, or restarting into it. Paused: its power policy takes no new tasks
// for now (on battery, running hot).
function nodeState(n) {
  if (!n.enabled) return { dot: '', label: 'Disabled' };
  if (['pending', 'sent'].includes(n.update?.state) && !n.draining) return { dot: 'warn', label: 'Updating' };
  if (!n.connected) return n.away === 'asleep' ? { dot: '', label: 'Asleep' } : n.away === 'bye' ? { dot: '', label: 'Shut down' } : { dot: 'off', label: 'Offline' };
  if (n.draining) return { dot: 'warn', label: 'Draining' };
  return n.status === 'paused' ? { dot: 'warn', label: 'Paused' } : { dot: 'on', label: 'Online' };
}
// 'Cluster: 3 machines · 7 cores · 14.2 GB free · 4 of 6 slots running': machines that are connected and enabled.
function machineSummary(nodes) {
  const up = nodes.filter((n) => n.connected && n.enabled), sum = (f) => up.reduce((a, n) => a + (f(n) || 0), 0);
  const used = sum((n) => n.used), slots = sum((n) => (n.draining || n.status === 'paused' ? n.used : Math.max(n.slots || 0, n.used)));
  const off = nodes.filter((n) => n.enabled && !n.connected).length, dis = nodes.filter((n) => !n.enabled).length;
  return [`Cluster: ${plural(up.length, 'machine')}`, plural(sum((n) => n.inventory?.cores), 'core'), `${fmtGB(sum((n) => n.resources?.memAvailable))} free`,
    `${used} of ${plural(slots, 'slot')} running`, off && `${off} offline`, dis && `${dis} disabled`].filter(Boolean).join(' · ');
}
function renderMachines() {
  caSync(MC.nodes);
  if (ND.id) ndRender();
  // A power menu in use isn't replaced under the owner's finger: the render waits until it loses focus.
  if (document.activeElement?.matches?.('#mMachines select')) { MC.stale = true; return; }
  MC.stale = false;
  const nodes = MC.nodes, sec = $('mcTitle').closest('.mc-sec'), body = sec.parentElement, first = nodes.some((n) => !n.local);
  // With workers the cluster leads Server details (above this server's charts); alone it sits at the bottom.
  if (first !== (body.firstElementChild === sec)) { if (first) body.prepend(sec); else body.append(sec); }
  sec.classList.toggle('first', first);
  $('mcSum').textContent = nodes.length ? machineSummary(nodes) : '';
  // Live re-renders keep keyboard focus on the same control of the same card.
  const f = document.activeElement, card = f?.closest?.('#mMachines .mc-node'), key = (b) => b.dataset.act || b.dataset.task || b.textContent;
  const was = card && f.tagName === 'BUTTON' && [card.dataset.node, key(f)];
  $('mMachines').replaceChildren(...nodes.map(machineCard));
  if (was) [...$('mMachines').querySelectorAll(`.mc-node[data-node="${CSS.escape(was[0])}"] button`)].find((b) => key(b) === was[1])?.focus({ preventScroll: true });
}
// A labelled meter: 'CPU  4 cores · load 1.20' over a bar (warn ≥ 75%, crit ≥ 90%).
function mcMeter(label, parts, pct) {
  const m = el('div', 'mc-meter'), d = el('div', 'detail');
  for (const p of parts) d.append(typeof p === 'string' ? document.createTextNode(p) : el('b', '', p.b));
  m.append(el('span', '', label), d);
  if (pct != null) {
    const bar = el('div', 'bar'), i = el('i', pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '');
    i.style.width = `${Math.max(2, Math.min(100, pct))}%`;
    bar.append(i);
    m.append(bar);
  }
  return m;
}
function machineCard(n) {
  const li = el('li', 'm-card mc-node'), st = nodeState(n), inv = n.inventory || {}, res = n.resources || {};
  li.dataset.node = n.id;
  if (!n.connected || !n.enabled) li.classList.add('away');
  const top = el('div', 'mc-top'), icon = el('span', 'mc-os'), id = el('div', 'mc-id'), name = el('span', 'mc-name', n.name);
  icon.innerHTML = OS_ICON[n.os] || OS_ICON.linux;
  icon.title = OS_NAME[n.os] || n.os || '';
  if (n.local) name.append(el('small', '', '(this server)'));
  const seen = n.local ? 'controller' : n.lastSeen ? `${n.connected ? 'seen' : 'last seen'} ${relTime(n.lastSeen)}` : 'never connected';
  id.append(name, el('span', 'mc-meta', [OS_NAME[n.os] || n.os, n.arch, seen].filter(Boolean).join(' · ')));
  const pill = el('span', 'mc-st');
  pill.append(el('span', `dot ${st.dot}`), document.createTextNode(st.label));
  top.append(icon, id, pill);
  li.append(top);

  const load = res.load?.[0];
  if (inv.cores) li.append(mcMeter('CPU', [{ b: String(inv.cores) }, ` ${inv.cores === 1 ? 'core' : 'cores'}`, ...(load != null ? [' · load ', { b: load.toFixed(2) }] : [])],
    load != null ? (load / inv.cores) * 100 : null));
  if (inv.mem && res.memAvailable != null) {
    const used = Math.max(0, inv.mem - res.memAvailable);
    li.append(mcMeter('RAM', [{ b: fmtGB(used) }, ' used · ', { b: fmtGB(res.memAvailable) }, ` free of ${fmtGB(inv.mem)}`], (used / inv.mem) * 100));
  }
  if (res.disk?.total) {
    const used = Math.max(0, res.disk.total - res.disk.free);
    li.append(mcMeter('Disk', [{ b: fmtGB(res.disk.free) }, ` free of ${fmtGB(res.disk.total)}`], (used / res.disk.total) * 100));
  }
  if (!inv.cores && res.memAvailable == null) li.append(el('p', 'mc-idle', 'No readings yet: they arrive once its worker connects.'));
  const pool = !n.local && poolLine(n);
  if (pool) li.append(pool);
  const health = machineHealth(n);
  if (health.length) li.append(...health);

  const ag = el('div', 'mc-agents'), signed = (inv.agents || []).filter((a) => a.signedIn);
  for (const a of signed) {
    const t = el('span', 'tc-tag on', agentLabel(a.id));
    if (a.account) t.title = `Signed in as ${a.account}`;
    ag.append(t);
  }
  if (!signed.length) ag.append(el('span', 'mc-idle', inv.agents ? 'No agents signed in' : 'Agents not reported yet'));
  li.append(ag);

  // Running tasks (plan tasks too, though they hold no work slot); tap one for its drawer.
  const run = el('div', 'mc-run'), h = el('h4');
  h.append(document.createTextNode('Running · '), el('b', '', `${n.used} of ${n.slots ?? 0}`), document.createTextNode(` ${n.slots === 1 ? 'slot' : 'slots'}`));
  run.append(h);
  const tasks = n.tasks || [];
  if (!tasks.length) run.append(el('p', 'mc-idle', n.connected && n.enabled && !n.draining ? 'Idle' : 'Nothing running'));
  const list = el('div', 'mc-tasks');
  for (const t of tasks) {
    const b = el('button', 'mc-task'), main = el('span');
    b.type = 'button';
    b.dataset.task = t.id;
    main.append(el('span', 't', displayTitle(t)), el('span', 's', [`#${t.id}`, t.project, `${shortLabel(t.agent)} · ${modelName(t.agent, t.model)}`,
      t.phase && t.phase !== 'running' ? PHASE_DOING[t.phase] : ''].filter(Boolean).join(' · ')));
    const e = el('span', t.waiting_for ? 'e wait' : 'e', t.waiting_for ? 'waiting' : fmtDur(Date.now() / 1000 - t.started_at));
    e.title = t.waiting_for ? `Waiting for ${t.waiting_for} to come back` : 'Running for';
    b.append(main, e);
    b.addEventListener('click', () => { closeServer(); openTask(t.id); });
    list.append(b);
  }
  if (tasks.length) run.append(list);
  li.append(run);
  li.append(machineControls(n));
  if (MC.power.has(n.id) && n.policy) li.append(powerPanel(n));
  return li;
}
// A worker's local cap (`node worker.mjs limit` on that machine, cap.mjs; the scheduler never gives it more), from its
// latest reading: 'Pooled: 4 cores · 8 GB (set on this Mac)'. Parts it doesn't cap show the machine's whole.
function poolLine(n) {
  const res = n.resources || {}, inv = n.inventory || {}, c = 'cap' in res ? res.cap : inv.cap;
  if (!c) return null;
  const cores = c.cpu ?? inv.cores, mem = c.mem ?? inv.mem;
  const parts = [cores != null && `${+Number(cores).toFixed(2)} ${cores === 1 ? 'core' : 'cores'}`, mem != null && `${+(mem / 2 ** 30).toFixed(1)} GB`,
    c.maxTasks != null && `at most ${plural(c.maxTasks, 'task')}`, c.onlyOnAc && 'on AC power only'].filter(Boolean);
  const p = el('p', 'mc-health mc-pool', `Pooled: ${parts.join(' · ')} (set on this ${n.os === 'darwin' ? 'Mac' : 'machine'})`);
  p.title = "This machine's own cap on what it lends the cluster (node worker.mjs limit, run on it). The scheduler never gives it more.";
  return p;
}
// A running remote task's step on its card ('installing deps'; nothing extra while the agent itself runs).
const PHASE_DOING = { queued: 'starting', cloning: 'cloning', fetching: 'fetching', installing: 'installing deps', checking: 'checking', committing: 'committing', pushing: 'pushing', done: 'finishing' };
// What the owner should know about a machine's health, one short line each: why it was drained automatically, why its
// power policy pauses it, an update (waiting, restarting, failed) or how far behind it is, its last error today, a Mac's
// battery and thermal state (and whether it is kept awake for its tasks), GitHub out of reach.
function machineHealth(n) {
  const out = [], res = n.resources || {}, line = (cls, text, title) => { const p = el('p', `mc-health ${cls}`, text); if (title) p.title = title; out.push(p); };
  if (n.drainReason) line('warn', `Drained automatically${n.drainedAt ? ` ${relTime(n.drainedAt)}` : ''}: ${n.drainReason}. Undrain it when that's fixed.`);
  if (n.slotsWhy) line('warn', `${n.slotsWhy}. It takes tasks once more memory is free.`);
  const paused = n.status === 'paused' ? res.intake?.reason : null;
  if (paused) line('warn', `${res.intake.text}. Its running tasks go on.`);
  const u = n.update;
  if (u?.state === 'pending') line('', n.draining ? 'Updates itself once its running tasks finish (it is draining meanwhile).' : 'Updates itself once its running tasks finish; it takes no new ones meanwhile.');
  else if (u?.state === 'sent') line('', 'Updating: pulling the latest agent-orch and restarting…');
  else if (u?.state === 'failed') line('bad', `Update failed: ${u.error}`);
  else if (n.outdated) line('warn', `${plural(n.behind, 'commit')} behind this server's agent-orch`);
  const e = n.lastError;
  if (e && Date.now() - e.at < 86400e3 && e.kind !== 'update') line('bad', `Error ${relTime(e.at)}: ${e.message}`, [e.kind, e.stderr || e.stack].filter(Boolean).join('\n\n'));
  const bat = res.battery, th = res.thermal;
  if (bat && paused !== 'battery') line(bat.pct < 20 && !bat.charging ? 'warn' : '', `Battery ${bat.pct}%${bat.charging ? ' · charging' : bat.source === 'ac' ? ' · on power' : ''}`);
  if (th?.pressure === 'throttled' && paused !== 'thermal') line('warn', th.speedLimit != null ? `Running hot: CPU limited to ${th.speedLimit}%` : 'Running hot: the CPU is throttled');
  if (res.awake && n.connected) line('', 'Kept awake while its tasks run');
  if (res.net && !res.net.ok && n.connected) line('warn', `Can't reach ${res.net.host === 'github.com' ? 'GitHub' : res.net.host}${res.net.error ? ` (${res.net.error})` : ''}: it can't clone or push`);
  return out;
}
// Rename, max parallel tasks, Drain, Disable and Remove. The controller's own slots follow its free memory (the owner
// only caps tasks across all machines, in Settings), so its card names no choice; it can't be disabled or removed.
function machineControls(n) {
  const ctl = el('div', 'mc-ctl'), slots = el('span', 'mc-slots', 'Max tasks');
  if (n.local) {
    const auto = el('span', 'mc-auto', 'Auto');
    auto.title = "Follows this server's free memory. Settings → Parallel tasks caps tasks across all machines.";
    slots.append(auto);
  } else {
    const seg = el('span', 'seg-sm');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', `Max parallel tasks on ${n.name}`);
    for (const v of [null, 1, 2, 3, 4, ...(n.maxSlots > 4 ? [n.maxSlots] : [])]) {
      const b = el('button', '', v == null ? 'Auto' : String(v));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(v === n.maxSlots));
      if (v == null) b.title = n.os === 'darwin' ? `Sized from its cores (one kept for you) and free RAM (${n.policy?.reserveGB ?? 3} GB kept for you)` : 'Sized from its cores and free RAM';
      b.addEventListener('click', () => { if (v !== n.maxSlots) patchNode(n, { maxSlots: v }); });
      seg.append(b);
    }
    slots.append(seg);
  }
  const btn = (text, act, run, cls = '') => {
    const b = el('button', `btn small${cls}`, text);
    b.type = 'button';
    b.dataset.act = act;
    b.addEventListener('click', run);
    ctl.append(b);
    return b;
  };
  ctl.append(slots);
  btn('Rename', 'rename', () => {
    const name = prompt(`Rename ${n.name}`, n.name)?.trim();
    if (name && name !== n.name) patchNode(n, { name });
  });
  const drain = btn('Drain', 'drain', () => patchNode(n, { draining: !n.draining }));
  drain.setAttribute('aria-pressed', String(n.draining));
  drain.title = n.draining ? 'Draining: it takes no new tasks. Press to take tasks again.' : 'Take no new tasks; running ones finish here';
  // A Mac's power policy: battery, keep-awake, heat and the RAM kept for its owner (powerPanel).
  if (!n.local && n.os === 'darwin' && n.policy) {
    const open = MC.power.has(n.id);
    const pw = btn('Power', 'power', () => { if (open) MC.power.delete(n.id); else MC.power.add(n.id); renderMachines(); });
    pw.setAttribute('aria-expanded', String(open));
    pw.title = 'When this Mac takes tasks on battery or when hot, whether it stays awake for them, and the RAM kept for you';
  }
  const moving = n.used ? ` Its ${plural(n.used, 'running task')} go${n.used === 1 ? 'es' : ''} back to the queue now.` : '';
  // Update: a worker behind this server's agent-orch (outdated ones update on their own), or one whose update failed,
  // pulls the latest agent-orch and restarts once idle.
  if (!n.local && n.connected && (n.update?.state === 'failed' || ((n.outdated || n.behind > 0) && !n.update))) {
    const up = btn('Update', 'update', async () => {
      try { await api(`/api/cluster/nodes/${encodeURIComponent(n.id)}/update`, 'POST'); toast(`${n.name} updates itself once its running tasks finish`); } catch (e) { toast(e.message, { kind: 'error' }); }
      loadMachines();
    });
    up.title = 'Pull the latest agent-orch on it and restart its worker, once its running tasks finish';
  }
  if (!n.local) {
    btn(n.enabled ? 'Disable' : 'Enable', 'disable', () => {
      if (n.enabled && moving && !confirm(`Disable ${n.name}?${moving}`)) return;
      patchNode(n, { enabled: !n.enabled });
    });
    btn('Remove', 'remove', async () => {
      if (!confirm(`Remove ${n.name}? Its token is revoked and it disconnects.${moving} Adding it back needs a new pairing code.`)) return;
      try { await api(`/api/cluster/nodes/${encodeURIComponent(n.id)}`, 'DELETE'); toast(`Removed ${n.name}`); } catch (e) { toast(e.message, { kind: 'error' }); }
      loadMachines();
    }, ' danger');
  }
  return ctl;
}
async function patchNode(n, body) {
  try { await api(`/api/cluster/nodes/${encodeURIComponent(n.id)}`, 'PATCH', body); } catch (e) { toast(e.message, { kind: 'error' }); }
  loadMachines();
}
// A Mac's power policy (power.mjs; its worker enforces it, and the scheduler keeps to its RAM reserve): a menu per
// setting, saved as soon as it changes. A value set another way (the API) shows as an extra option.
const POWER_ROWS = [
  ['minBattery', 'New tasks on battery', [[null, 'Never: AC power only'], [25, 'Above 25%'], [50, 'Above 50%'], [75, 'Above 75%'], [0, 'At any charge']], (v) => `Above ${v}%`],
  ['keepAwake', 'Keep awake while tasks run', [['ac', 'On AC power'], ['always', 'Always'], ['never', 'Never']]],
  ['thermal', 'Pause new tasks when hot', [['heavy', 'At heavy pressure'], ['moderate', 'From moderate pressure'], ['off', 'Never']]],
  ['reserveGB', 'RAM kept free for you', [1, 2, 3, 4, 6, 8].map((g) => [g, `${g} GB`]), (v) => `${v} GB`],
];
function powerPanel(n) {
  const box = el('div', 'mc-power');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', `Power settings for ${n.name}`);
  for (const [key, label, options, other = String] of POWER_ROWS) {
    const row = el('label', 'mc-prow'), sel = el('select'), cur = n.policy[key];
    sel.dataset.act = `policy-${key}`;
    for (const [v, text] of options.some(([v]) => v === cur) ? options : [...options, [cur, other(cur)]]) {
      const o = el('option', '', text);
      o.value = JSON.stringify(v);
      o.selected = v === cur;
      sel.append(o);
    }
    sel.addEventListener('change', () => patchNode(n, { policy: { [key]: JSON.parse(sel.value) } }));
    sel.addEventListener('blur', () => { if (MC.stale) setTimeout(renderMachines, 0); });
    row.append(el('span', '', label), sel);
    box.append(row);
  }
  box.append(el('p', 'mc-pnote', 'Running tasks go on either way. A closed lid still sleeps the Mac; its tasks then move to another machine.'));
  return box;
}

// ----- cluster diagram (Server details → Machines, above the cards) -----
// One SVG drawn by one requestAnimationFrame loop: the head (this server) in the middle and the workers around it (a
// vertical list under 640px), each with CPU (outer) and RAM (inner) ring gauges, its OS icon and its running tasks as
// chips. It moves on data the page already gets: a worker's newer reading (resources.at, sent every heartbeat) pulses it
// and its link; lane activity (olane, one push per tool call) sends particles up the link of that task's machine, at
// most 6 a second per link; a task that shows up on a machine travels there from the head as a chip, and one that leaves
// returns and merges into the head (a check when it finished, a cross when it failed). Phase changes cross-fade on the
// chip. Offline machines turn grey with a dashed link, asleep Macs wear a moon and draining ones an amber ring. The loop
// runs only while something moves, Server details is open, the diagram in view and the page visible (at most 60 fps),
// and never reads layout; with reduced motion every change is a static swap. Colours are theme variables (app.css .ca-*).
const SVGNS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs, parent) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  parent?.append(n);
  return n;
};
const CA_CHIP = 132, CA_ROW = 26; // a resting chip's width; the spacing of a machine's chip seats
// The step a chip shows (remote jobs report phases; a task on this server just runs) and its dot's tone.
const CA_PHASE = { queued: 'starting', cloning: 'cloning', fetching: 'fetching', installing: 'installing', running: 'running', checking: 'checking', committing: 'committing', pushing: 'pushing', done: 'finishing' };
const CA_TONE = { running: 'run', checking: 'check', committing: 'check', finishing: 'check', pushing: 'push', waiting: 'wait' };
// nodes: id → view (its group, place, link); chips: task id → chip; anims: what moves now; seen: node id → its newest
// reading's time; status: task id → its last pushed status; emit: node id → particle throttle; ready: the first
// snapshot since Server details opened is drawn (later changes animate).
const CA = { wrap: null, svg: null, g: {}, w: 0, h: 0, list: false, key: '', head: null, nodes: new Map(), chips: new Map(), anims: new Set(),
  seen: new Map(), status: new Map(), emit: new Map(), raf: 0, last: 0, ready: false, inView: true, asked: 0, mark: null, markPath: null, markAnim: null, markTimer: 0 };

function caBuild() {
  if (CA.svg) return;
  CA.wrap = $('caWrap');
  CA.svg = sv('svg', { class: 'ca', role: 'group' }, CA.wrap);
  for (const k of ['links', 'glow', 'dots', 'nodes', 'chips', 'marks']) CA.g[k] = sv('g', { class: `ca-${k}` }, CA.svg);
  for (const k of ['glow', 'dots', 'chips', 'marks']) CA.g[k].setAttribute('aria-hidden', 'true');
  CA.mark = sv('g', { class: 'ca-mark', opacity: 0 }, CA.g.marks);
  sv('circle', { r: 10 }, CA.mark);
  CA.markPath = sv('path', {}, CA.mark);
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w && w !== CA.w) { CA.w = w; caLayout(); }
  }).observe(CA.wrap);
  // Scrolled out of view (Server details scrolls): nothing moves until it's back.
  new IntersectionObserver(([e]) => { CA.inView = e.isIntersecting; if (!CA.inView) caFlush(); }).observe(CA.wrap);
  // A chip opens its task's drawer; a machine its detail.
  CA.svg.addEventListener('click', (e) => {
    const chip = e.target.closest('.ca-chip'), node = e.target.closest('.ca-node');
    if (chip) { closeServer(); openTask(Number(chip.dataset.task)); } else if (node) openNode(node.dataset.node);
  });
  CA.svg.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('ca-node')) { e.preventDefault(); openNode(e.target.dataset.node); }
  });
}
function caClear() {
  caFlush();
  for (const v of CA.nodes.values()) { v.g.remove(); v.link?.remove(); v.glow?.remove(); }
  for (const c of CA.chips.values()) c.g.remove();
  CA.nodes.clear(); CA.chips.clear(); CA.seen.clear();
  CA.key = ''; CA.head = null; CA.ready = false;
}
// A new snapshot of GET /api/cluster/nodes (renderMachines): the machines, their readings and running tasks.
function caSync(nodes) {
  if ($('serverModal').hidden) return; // drawn only while Server details is open; the next open starts fresh
  const head = nodes.find((n) => n.local);
  if (!head || !nodes.some((n) => !n.local)) { if (CA.wrap) { CA.wrap.hidden = true; caClear(); } return; } // alone: just its card
  caBuild();
  CA.wrap.hidden = false;
  if (!CA.w) CA.w = Math.round(CA.wrap.clientWidth); // until the ResizeObserver's first report
  const ids = new Set(nodes.map((n) => n.id));
  for (const [id, v] of CA.nodes) if (!ids.has(id)) { v.g.remove(); v.link?.remove(); v.glow?.remove(); CA.nodes.delete(id); CA.seen.delete(id); }
  for (const n of nodes) {
    const v = CA.nodes.get(n.id) || caNode(n);
    v.n = n;
    CA.nodes.set(n.id, v);
  }
  CA.head = CA.nodes.get(head.id);
  if (`${CA.w}|${[...ids].join(',')}` !== CA.key) caLayout();
  else for (const v of CA.nodes.values()) caPaint(v);
  // Heartbeats: a worker's newer reading (not on the first look).
  for (const n of nodes) {
    if (n.local) continue;
    const at = n.resources?.at || 0, prev = CA.seen.get(n.id);
    CA.seen.set(n.id, at);
    if (CA.ready && prev != null && at > prev && n.connected) caBeat(CA.nodes.get(n.id));
  }
  if (ND.id && ND.at && Date.now() - ND.at > 10e3) ndMetrics(); // an open detail's charts follow along
  caChips(nodes);
  const up = nodes.filter((n) => !n.local && n.connected && n.enabled).length;
  CA.svg.setAttribute('aria-label', `Cluster diagram: this server in the middle and ${plural(nodes.length - 1, 'worker')} around it, ${up} online`);
  CA.ready = true;
}

// ---- machines
function caNode(n) {
  const g = sv('g', { class: 'ca-node', 'data-node': n.id, tabindex: '0', role: 'button' }, CA.g.nodes);
  const v = { n, g, x: 0, y: 0, r: 0, side: 'below', beats: 0, rc: 0, rr: 0 };
  v.title = sv('title', {}, g);
  v.halo = sv('circle', { class: 'ca-halo' }, g);
  v.focus = sv('circle', { class: 'ca-focus' }, g);
  v.drain = sv('circle', { class: 'ca-drain' }, g);
  v.plate = sv('circle', { class: 'ca-plate' }, g);
  v.cpuT = sv('circle', { class: 'ca-track' }, g);
  v.cpu = sv('circle', { class: 'ca-gauge', transform: 'rotate(-90)' }, g);
  v.ramT = sv('circle', { class: 'ca-track' }, g);
  v.ram = sv('circle', { class: 'ca-gauge', transform: 'rotate(-90)' }, g);
  v.icon = sv('g', { class: 'ca-icon' }, g);
  v.moon = sv('g', { class: 'ca-moon' }, g); // SF Symbols style moon.fill on a badge
  sv('circle', { r: 9 }, v.moon);
  sv('path', { d: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z', transform: 'translate(-6.3 -6.3) scale(.52)' }, v.moon);
  v.name = sv('text', { class: 'ca-name' }, g);
  v.sub = sv('text', { class: 'ca-sub' }, g);
  v.more = sv('text', { class: 'ca-more' }, g);
  if (!n.local) {
    v.link = sv('path', { class: 'ca-link' }, CA.g.links);
    v.glow = sv('path', { class: 'ca-glow', pathLength: '1' }, CA.g.glow);
  }
  return v;
}
// Places: the head in the middle and the workers on an ellipse around it (odd counts start at the top, even ones
// straddle it), labels and chips on the outer side, the drawing centred; under 640px a vertical list, the head on top,
// every worker linked to it by a bus down the left edge.
function caLayout() {
  const W = CA.w, all = [...CA.nodes.values()], head = CA.head, workers = all.filter((v) => v !== head);
  if (!W || !head) return;
  CA.key = `${W}|${all.map((v) => v.n.id).join(',')}`;
  CA.list = W < 640;
  if (CA.list) {
    let y = 6;
    for (const v of [head, ...workers]) {
      const h = v === head ? 84 : 76;
      Object.assign(v, { r: v === head ? 26 : 22, side: 'right', x: 70, y: y + h / 2 });
      y += h;
    }
    CA.h = y + 4;
    for (const v of workers) v.poly = caPoly(caElbow(v, head, 28));
  } else {
    const n = workers.length, rx = Math.max(150, Math.min(W / 2 - 180, n === 1 ? 250 : 170 + 45 * n)), ry = Math.max(96, Math.min(150, rx * 0.46));
    Object.assign(head, { r: 34, side: 'below', x: 0, y: 0 });
    workers.forEach((v, i) => {
      const a = n === 1 ? 0 : -Math.PI / 2 + (2 * Math.PI / n) * (i + (n % 2 ? 0 : 0.5)), c = Math.cos(a), s = Math.sin(a);
      Object.assign(v, { r: 26, x: rx * c, y: ry * s, side: c > 0.3 ? 'right' : c < -0.3 ? 'left' : s < 0 ? 'above' : 'below' });
    });
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const v of all) {
      const [a, b, c, d] = caBox(v);
      x0 = Math.min(x0, v.x + a); x1 = Math.max(x1, v.x + b); y0 = Math.min(y0, v.y + c); y1 = Math.max(y1, v.y + d);
    }
    const dx = Math.round(W / 2 - (x0 + x1) / 2), dy = Math.round(14 - y0);
    for (const v of all) { v.x += dx; v.y += dy; }
    CA.h = Math.round(y1 - y0 + 28);
    for (const v of workers) v.poly = caPoly([[v.x, v.y], [head.x, head.y]]);
  }
  CA.svg.setAttribute('viewBox', `0 0 ${W} ${CA.h}`);
  CA.svg.setAttribute('height', CA.h);
  for (const v of all) {
    caShape(v);
    caPaint(v);
    if (v.poly) {
      const d = caD(caCut(v.poly, v.r + 3, v.poly.len - head.r - 3));
      v.link.setAttribute('d', d);
      v.glow.setAttribute('d', d);
    }
  }
  caSeats(false); // resting chips move to their new seats at once; travelling ones land there
}
// A machine's extent around its centre [left, right, top, bottom]: glyph, labels, two chip seats and a '+N'.
function caBox(v) {
  const r = v.r, w = CA_CHIP + 40, low = 33 + CA_ROW + 11;
  if (v.side === 'right') return [-r, r + 10 + w, -r, Math.max(r, low)];
  if (v.side === 'left') return [-(r + 10 + w), r, -r, Math.max(r, low)];
  if (v.side === 'above') return [-w / 2 - 20, w / 2 + 20, -(r + 48 + CA_ROW + 11), r + 6];
  return [-w / 2 - 20, w / 2 + 20, -r - 6, r + 51 + CA_ROW + 11];
}
// Seat k of a machine's chips, in drawing coordinates (the list layout has one per row).
function caSeat(v, k) {
  const r = v.r, w = CA_CHIP / 2;
  const [dx, dy] = CA.list ? [r + 12 + w, 25] : v.side === 'right' ? [r + 10 + w, 33 + CA_ROW * k] : v.side === 'left' ? [-(r + 10 + w), 33 + CA_ROW * k]
    : v.side === 'above' ? [0, -r - 48 - CA_ROW * k] : [0, r + 51 + CA_ROW * k];
  return [v.x + dx, v.y + dy];
}
// Geometry that follows the machine's size and side: plate, rings, badges and where its labels sit.
function caShape(v) {
  const r = v.r;
  v.g.setAttribute('transform', `translate(${v.x} ${v.y})`);
  for (const [c, rad] of [[v.plate, r], [v.halo, r], [v.drain, r + 4.5], [v.focus, r + 8]]) c.setAttribute('r', rad);
  v.rc = r - 4; v.rr = r - 10;
  for (const c of [v.cpuT, v.cpu]) c.setAttribute('r', v.rc);
  for (const c of [v.ramT, v.ram]) c.setAttribute('r', v.rr);
  v.moon.setAttribute('transform', `translate(${(r * 0.74).toFixed(1)} ${(-r * 0.74).toFixed(1)})`);
  const [nx, ny, sy, anchor] = CA.list ? [r + 12, -8, 7, 'start'] : v.side === 'right' ? [r + 10, -3, 12, 'start'] : v.side === 'left' ? [-(r + 10), -3, 12, 'end']
    : v.side === 'above' ? [0, -r - 24, -r - 9, 'middle'] : [0, r + 17, r + 31, 'middle'];
  for (const [t, y] of [[v.name, ny], [v.sub, sy]]) { t.setAttribute('x', nx); t.setAttribute('y', y); t.setAttribute('text-anchor', anchor); }
}
const caCpu = (n) => {
  const c = n.resources?.cpu, l = n.resources?.load?.[0], k = n.inventory?.cores;
  return Array.isArray(c) && c.length ? c.reduce((a, b) => a + b, 0) / c.length : l != null && k ? Math.min(100, (l / k) * 100) : null;
};
const caRam = (n) => {
  const m = n.inventory?.mem, a = n.resources?.memAvailable;
  return m && a != null ? Math.max(0, Math.min(100, ((m - a) / m) * 100)) : null;
};
// A ring gauge: the used share of the ring, from the top, clockwise (warn ≥ 75%, crit ≥ 90%, like the cards' bars).
function caGauge(c, r, pct) {
  const len = 2 * Math.PI * r, p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  c.style.strokeDasharray = `${((len * p) / 100).toFixed(1)} ${len.toFixed(1)}`;
  c.setAttribute('class', `ca-gauge${p < 0.5 ? ' zero' : p >= 90 ? ' crit' : p >= 75 ? ' warn' : ''}`);
}
// State, readings and words: offline/asleep/disabled grey, a moon, an amber ring, the gauges and the label lines.
function caPaint(v) {
  const n = v.n, st = nodeState(n), off = !n.connected || !n.enabled, asleep = !n.connected && n.away === 'asleep';
  v.g.setAttribute('class', `ca-node${n.local ? ' head' : ''}${off ? ' off' : ''}${asleep ? ' asleep' : ''}${n.draining ? ' draining' : ''}`);
  v.link?.setAttribute('class', off ? 'ca-link off' : 'ca-link');
  const cpu = caCpu(n), ram = caRam(n);
  if (v.rc) { caGauge(v.cpu, v.rc, cpu); caGauge(v.ram, v.rr, ram); }
  const s = v.r <= 22 ? 14 : v.r <= 26 ? 18 : 24, k = `${n.os}|${s}`;
  if (v.icon.dataset.k !== k) {
    v.icon.innerHTML = OS_ICON[n.os] || OS_ICON.linux;
    const i = v.icon.firstElementChild;
    for (const [a, val] of [['width', s], ['height', s], ['x', -s / 2], ['y', -s / 2]]) i.setAttribute(a, val);
    v.icon.dataset.k = k;
  }
  v.name.textContent = n.name.length > 20 ? `${n.name.slice(0, 19)}…` : n.name;
  const pct = [cpu != null && `CPU ${Math.round(cpu)}%`, ram != null && `RAM ${Math.round(ram)}%`].filter(Boolean).join(' · ');
  v.sub.textContent = n.local ? ['Head', pct].filter(Boolean).join(' · ') : !n.enabled ? 'Disabled'
    : !n.connected ? `${st.label} · ${n.lastSeen ? `seen ${relTime(n.lastSeen)}` : 'never connected'}` : st.label === 'Online' ? pct || 'Online' : [st.label, pct].filter(Boolean).join(' · ');
  const tasks = n.tasks?.length || 0;
  const label = `${n.name}${n.local ? ' (this server, the head)' : ''}: ${st.label}${pct ? `, ${pct}` : ''}, ${tasks ? `${plural(tasks, 'task')} running` : 'nothing running'}. Show details`;
  v.g.setAttribute('aria-label', label);
  v.title.textContent = label;
}

// ---- links: polylines from a worker's centre to the head's
function caPoly(pts) {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, lens, len: lens[lens.length - 1] };
}
function caAt(p, s) {
  s = Math.max(0, Math.min(p.len, s));
  let i = 1;
  while (i < p.pts.length - 1 && p.lens[i] < s) i++;
  const a = p.pts[i - 1], b = p.pts[i], t = (s - p.lens[i - 1]) / (p.lens[i] - p.lens[i - 1] || 1);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
// The stretch of a polyline between two distances along it.
function caCut(p, s0, s1) {
  const out = [caAt(p, s0)];
  for (let i = 1; i < p.pts.length - 1; i++) if (p.lens[i] > s0 && p.lens[i] < s1) out.push(p.pts[i]);
  out.push(caAt(p, s1));
  return out;
}
const caD = (pts) => pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('');
// The list layout's link: left from the worker to the bus at x = b, up it and right into the head (rounded corners).
function caElbow(v, head, b) {
  const rc = 10, pts = [[v.x, v.y], [b + rc, v.y]];
  for (let i = 1; i <= 6; i++) { const a = Math.PI / 2 + (Math.PI / 2) * (i / 6); pts.push([b + rc + rc * Math.cos(a), v.y - rc + rc * Math.sin(a)]); }
  for (let i = 0; i <= 6; i++) { const a = Math.PI + (Math.PI / 2) * (i / 6); pts.push([b + rc + rc * Math.cos(a), head.y + rc + rc * Math.sin(a)]); }
  pts.push([head.x, head.y]);
  return pts;
}
// A link's inner corners, head → worker (out) or worker → head.
const caRoute = (v, out) => (v.poly ? (out ? v.poly.pts.slice(1, -1).reverse() : v.poly.pts.slice(1, -1)) : []);

// ---- the loop: time-based animations {dur, step(u), done()}; nothing runs (or queues) unseen
const caEase = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const caBack = (u) => 1 + 2.70158 * (u - 1) ** 3 + 1.70158 * (u - 1) ** 2; // overshoots, then settles
const caCanMove = () => !!CA.svg && CA.inView && !CA.wrap.hidden && !reduceMotion.matches && !document.hidden && !$('serverModal').hidden;
function caAnim(a) {
  a.t0 = performance.now();
  if (!caCanMove()) { a.step(1); a.done?.(); return null; } // a static change: straight to the end state
  a.step(0); // drawn at its start now, not a frame late
  CA.anims.add(a);
  CA.raf ||= requestAnimationFrame(caFrame);
  return a;
}
const caStop = (a) => { if (a) CA.anims.delete(a); }; // leaves it where it is; its done() doesn't run
function caFrame(ts) {
  CA.raf = 0;
  if (!caCanMove()) return caFlush(); // hidden, closed or reduced motion: jump to the end states
  if (ts - CA.last < 1000 / 60 - 2) { CA.raf = requestAnimationFrame(caFrame); return; } // at most 60 fps (120 Hz screens)
  CA.last = ts;
  for (const a of [...CA.anims]) {
    if (!CA.anims.has(a)) continue; // stopped by another one this frame
    const u = Math.max(0, Math.min(1, (ts - a.t0) / a.dur));
    a.step(u);
    if (u >= 1) { CA.anims.delete(a); a.done?.(); }
  }
  if (CA.anims.size) CA.raf ||= requestAnimationFrame(caFrame);
}
function caFlush() {
  cancelAnimationFrame(CA.raf);
  CA.raf = 0;
  for (let i = 0; i < 5 && CA.anims.size; i++) for (const a of [...CA.anims]) { CA.anims.delete(a); a.step(1); a.done?.(); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) caFlush(); });

// ---- pulses and particles
function caPulse(v, strength = 1) {
  caStop(v.pulse);
  v.pulse = caAnim({ dur: 950, step: (u) => {
    v.halo.setAttribute('r', (v.r + 2 + 14 * (1 - (1 - u) ** 3)).toFixed(1));
    v.halo.setAttribute('opacity', (u >= 1 ? 0 : (1 - u) * 0.55 * strength).toFixed(3));
  } });
}
// A heartbeat: the machine pulses and a glow runs up its link; the head pulses softly when it lands.
function caBeat(v) {
  if (!v) return;
  v.g.dataset.beats = String(++v.beats);
  if (!caCanMove()) return;
  caPulse(v);
  if (!v.glow) return;
  caStop(v.glowAnim);
  v.glowAnim = caAnim({ dur: 1000, step: (u) => {
    v.glow.style.strokeDashoffset = (0.18 - 1.2 * caEase(u)).toFixed(3);
    v.glow.style.opacity = (0.8 * (u < 0.15 ? u / 0.15 : u > 0.85 ? (1 - u) / 0.15 : 1)).toFixed(3);
  }, done: () => { if (CA.head) caPulse(CA.head, 0.35); } });
}
// Lane activity (olane): a particle up the task's link, at most 6 a second per link (one waits; the rest fold into it).
// While jobs stream, the machines are re-read at most every 5 s so their chips show the current phase.
function caEvent(taskId) {
  const c = CA.chips.get(taskId), v = c && !c.leaving ? CA.nodes.get(c.node) : null;
  if (!v?.poly || !v.n.connected || !caCanMove()) return;
  if (Date.now() - CA.asked > 5000) { CA.asked = Date.now(); scheduleMachines(0); }
  const e = CA.emit.get(v.n.id) || { at: 0, timer: 0 };
  CA.emit.set(v.n.id, e);
  if (e.timer) return;
  const fire = () => { e.timer = 0; e.at = performance.now(); if (CA.nodes.get(v.n.id) === v && v.poly && caCanMove()) caParticle(v); };
  const wait = 1000 / 6 - (performance.now() - e.at);
  if (wait <= 0) fire(); else e.timer = setTimeout(fire, wait);
}
function caParticle(v) {
  const p = v.poly, s0 = v.r + 3, s1 = p.len - CA.head.r - 3;
  const dot = sv('circle', { class: 'ca-pt', r: CA.list ? 2.2 : 2.6, opacity: 0 }, CA.g.dots);
  caAnim({ dur: Math.max(700, Math.min(1400, 450 + (s1 - s0) * 2)), step: (u) => {
    const [x, y] = caAt(p, s0 + (s1 - s0) * u * u * (3 - 2 * u));
    dot.setAttribute('cx', x.toFixed(1));
    dot.setAttribute('cy', y.toFixed(1));
    dot.setAttribute('opacity', (u < 0.15 ? u / 0.15 : u > 0.8 ? (1 - u) / 0.2 : 1).toFixed(3));
  }, done: () => dot.remove() });
}

// ---- task chips
function caChip(t, node) {
  const g = sv('g', { class: 'ca-chip', 'data-task': t.id }, CA.g.chips);
  const c = { id: t.id, t, node, g, x: 0, y: 0, e: 1, s: 1, o: 0, pa: 1, pb: 0, flip: false, phase: null, slot: 0, hidden: false, fresh: true, from: null, motion: null, leaving: false };
  c.bg = sv('rect', { y: -11, height: 22, rx: 11 }, g);
  c.dot = sv('circle', { class: 'ca-cd', r: 3.5 }, g);
  c.idText = sv('text', { class: 'ca-cid', y: 4 }, g);
  c.idText.textContent = `#${t.id}`;
  c.ta = sv('text', { class: 'ca-ph', y: 4, 'text-anchor': 'end' }, g);
  c.tb = sv('text', { class: 'ca-ph', y: 4, 'text-anchor': 'end' }, g);
  c.cw = 30 + 6.6 * String(t.id).length; // packed for travel: the dot and '#id'
  return c;
}
// A chip where it is: e 0 = packed for travel, 1 = resting with its step; s its scale, o its opacity.
function caDraw(c) {
  const w = c.cw + (CA_CHIP - c.cw) * c.e, l = -w / 2;
  c.g.setAttribute('transform', `translate(${c.x.toFixed(1)} ${c.y.toFixed(1)})${c.s !== 1 ? ` scale(${c.s.toFixed(3)})` : ''}`);
  c.g.setAttribute('opacity', c.o.toFixed(3));
  c.g.style.visibility = c.o < 0.02 ? 'hidden' : '';
  c.bg.setAttribute('x', l.toFixed(1));
  c.bg.setAttribute('width', w.toFixed(1));
  c.dot.setAttribute('cx', (l + 11).toFixed(1));
  c.idText.setAttribute('x', (l + 19).toFixed(1));
  for (const [t, f] of [[c.ta, c.pa], [c.tb, c.pb]]) { t.setAttribute('x', (-l - 10).toFixed(1)); t.setAttribute('opacity', (c.e * c.e * f).toFixed(3)); }
}
function caPhaseOf(c) {
  if (c.t.waiting_for) return 'waiting';
  return c.t.phase ? CA_PHASE[c.t.phase] || c.t.phase : CA.nodes.get(c.node)?.n.local ? 'running' : 'starting';
}
// A new step cross-fades in over the old one.
function caSetPhase(c, word, animate) {
  if (c.phase === word) return;
  const first = c.phase == null, next = c.flip ? c.ta : c.tb, kc = c.flip ? 'pb' : 'pa', kn = c.flip ? 'pa' : 'pb';
  c.phase = word;
  c.flip = !c.flip;
  next.textContent = word;
  c.dot.setAttribute('class', `ca-cd ${CA_TONE[word] || 'setup'}`);
  c.g.dataset.phase = word;
  caStop(c.fade);
  if (first || !animate) { c[kc] = 0; c[kn] = 1; if (!first) caDraw(c); return; }
  const a0 = c[kc], b0 = c[kn];
  c.fade = caAnim({ dur: 450, step: (u) => { const k = caEase(u); c[kc] = a0 * (1 - k); c[kn] = b0 + (1 - b0) * k; caDraw(c); } });
}
// Tasks per machine from the snapshot: new ones are dispatched, gone ones merge back, moved ones travel via the head.
function caChips(nodes) {
  const want = new Map();
  for (const n of nodes) for (const t of n.tasks || []) want.set(t.id, [t, n.id]);
  for (const c of [...CA.chips.values()]) if (!want.has(c.id) && !c.leaving) caLeave(c);
  for (const [id, [t, node]] of want) {
    let c = CA.chips.get(id);
    if (c?.leaving) { caStop(c.motion); c.g.remove(); c = null; } // it came back before it got home
    if (!c) CA.chips.set(id, (c = caChip(t, node)));
    else if (c.node !== node) { c.from = c.node; c.node = node; }
    c.t = t;
    caSetPhase(c, caPhaseOf(c), CA.ready);
  }
  caSeats(true);
}
// Each machine's chips, oldest first, take its seats (two; one in the list layout); the rest fold into '+N'.
function caSeats(animate) {
  const rows = CA.list ? 1 : 2;
  for (const v of CA.nodes.values()) {
    const mine = [...CA.chips.values()].filter((c) => c.node === v.n.id && !c.leaving).sort((a, b) => (a.t.started_at || 0) - (b.t.started_at || 0) || a.id - b.id);
    mine.forEach((c, k) => { c.slot = Math.min(k, rows - 1); c.hidden = k >= rows; });
    const over = mine.length - rows;
    v.more.textContent = over > 0 ? `+${over}` : '';
    if (over > 0) {
      const [x, y] = caSeat(v, rows - 1), left = !CA.list && v.side === 'left';
      v.more.setAttribute('x', (x - v.x + (left ? -1 : 1) * (CA_CHIP / 2 + 8)).toFixed(1));
      v.more.setAttribute('y', (y - v.y + 4).toFixed(1));
      v.more.setAttribute('text-anchor', left ? 'end' : 'start');
    }
    for (const c of mine) caGo(c, animate);
  }
}
function caGo(c, animate) {
  const v = CA.nodes.get(c.node), head = CA.head;
  if (!v || !head) return;
  const [sx, sy] = caSeat(v, c.slot), o = c.hidden ? 0 : 1, moving = animate && CA.ready && caCanMove();
  if (c.fresh) {
    // Dispatched: packed at the head, along the link, unpacking onto its seat.
    c.fresh = false;
    if (moving) return caTravel(c, [[head.x, head.y], ...(v === head ? [] : [...caRoute(v, true), [v.x, v.y]]), [sx, sy]],
      (u) => ({ e: u < 0.78 ? 0 : caEase((u - 0.78) / 0.22), s: 0.6 + 0.4 * Math.min(1, u / 0.15), o: Math.min(1, u / 0.1) * (o || Math.max(0, 1 - (u - 0.85) / 0.15)) }));
  } else if (c.from != null) {
    // Moved to another machine: home through the head, then out again.
    const from = CA.nodes.get(c.from);
    c.from = null;
    if (moving && from) return caTravel(c, [[c.x, c.y], ...(from === head ? [] : [[from.x, from.y], ...caRoute(from, false)]), [head.x, head.y], ...(v === head ? [] : [...caRoute(v, true), [v.x, v.y]]), [sx, sy]],
      (u, e0) => ({ e: u < 0.2 ? e0 * (1 - u / 0.2) : u > 0.8 ? (u - 0.8) / 0.2 : 0, s: 1, o: 1 }));
  } else if (c.motion) return; // it lands on its current seat when it arrives (caPlace)
  else if (moving && (Math.abs(c.x - sx) > 0.5 || Math.abs(c.y - sy) > 0.5 || c.o !== o)) {
    const o0 = c.o;
    return caTravel(c, [[c.x, c.y], [sx, sy]], (u) => ({ e: 1, s: 1, o: o0 + (o - o0) * u }), 380);
  }
  caPlace(c);
}
function caTravel(c, pts, prof, dur, done) {
  caStop(c.motion);
  const p = caPoly(pts), e0 = c.e;
  c.motion = caAnim({ dur: dur || Math.max(900, Math.min(1800, 650 + p.len * 1.6)), step: (u) => {
    [c.x, c.y] = caAt(p, caEase(u) * p.len);
    Object.assign(c, prof(u, e0));
    caDraw(c);
  }, done: () => { c.motion = null; (done || caPlace)(c); } });
}
function caPlace(c) {
  const v = CA.nodes.get(c.node);
  if (!v || c.leaving) return;
  [c.x, c.y] = caSeat(v, c.slot);
  Object.assign(c, { e: 1, s: 1, o: c.hidden ? 0 : 1 });
  caDraw(c);
}
// Gone from its machine: it packs up, travels home and merges into the head, which checks it off when it finished
// (a cross when it failed; nothing when it was only put back in the queue).
function caLeave(c) {
  c.leaving = true;
  const head = CA.head, v = CA.nodes.get(c.node);
  const home = () => {
    c.g.remove();
    if (CA.chips.get(c.id) === c) CA.chips.delete(c.id);
    const st = CA.status.get(c.id) ?? O.tasks.get(c.id)?.status;
    caMerged(st === 'done' ? 'ok' : st === 'failed' ? 'bad' : null);
  };
  if (!CA.ready || !head) { caStop(c.motion); c.g.remove(); CA.chips.delete(c.id); return; }
  caTravel(c, [[c.x, c.y], ...(v && v !== head ? [[v.x, v.y], ...caRoute(v, false)] : []), [head.x, head.y]],
    (u, e0) => ({ e: e0 * Math.max(0, 1 - u / 0.2), s: u > 0.82 ? 1 - (0.65 * (u - 0.82)) / 0.18 : 1, o: (c.hidden ? 0.001 : 1) * (u > 0.86 ? (1 - u) / 0.14 : 1) }), 0, home);
}
function caMerged(kind) {
  const head = CA.head;
  if (!head) return;
  caPulse(head, 0.6);
  if (!kind) return;
  const m = CA.mark, x = head.x + head.r * 0.74, y = head.y - head.r * 0.74;
  m.setAttribute('class', `ca-mark ${kind}`);
  CA.markPath.setAttribute('d', kind === 'ok' ? 'M-4.4 .2l2.8 2.8 5.8-5.9' : 'M-3.2-3.2l6.4 6.4M3.2-3.2l-6.4 6.4');
  const put = (s, o) => { m.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${s.toFixed(3)})`); m.setAttribute('opacity', o.toFixed(3)); };
  caStop(CA.markAnim);
  clearTimeout(CA.markTimer);
  if (!caCanMove()) { put(1, 1); CA.markTimer = setTimeout(() => put(1, 0), 1600); return; } // static: shown, then gone
  CA.markAnim = caAnim({ dur: 1700, step: (u) => put(u < 0.18 ? Math.max(0, caBack(u / 0.18)) : 1, u > 0.8 ? (1 - u) / 0.2 : 1) });
}
// Every otask push: how a chip that leaves its machine ends (checked off, crossed out or just home).
function caTask(t) {
  CA.status.set(t.id, t.status);
  if (CA.status.size > 500) CA.status.delete(CA.status.keys().next().value);
}

// ----- a machine's detail (tap it in the diagram) -----
// Its telemetry as charts (GET /api/cluster/nodes/:id/metrics?range=: CPU, memory, load, disk; a hover readout), what
// runs there with each remote run's phase timeline (the task's latest run, as in its drawer), and its log tail on
// demand (GET /api/cluster/nodes/:id/logs?tail=200, fetched over the worker's socket).
const ND_RANGES = ['15m', '1h', '6h', '24h'];
// els: the sheet's parts (charts grid, running list, log section, log button), built per open.
const ND = { id: null, range: ND_RANGES.includes(store.get('cw.nd.range')) ? store.get('cw.nd.range') : '1h', samples: null, err: '', at: 0, seq: 0,
  runs: new Map(), taskKey: '', log: null, lastFocus: null, draws: [], els: {} };
// [key, title, value of a sample, format, top of the scale]
const ND_CHARTS = [
  ['cpu', 'CPU', (s) => s.cpu, fmtPct, () => 100],
  ['mem', 'Memory used', (s, n) => (n.inventory?.mem && s.mem != null ? Math.max(0, (1 - s.mem / n.inventory.mem) * 100) : null), fmtPct, () => 100],
  ['load', 'Load (1 min)', (s) => s.load, (v) => v.toFixed(2), (n, vals) => Math.max(n.inventory?.cores || 1, ...vals) * 1.15],
  ['disk', 'Disk free', (s) => s.disk, (v) => fmtBytes(v), (n, vals) => Math.max(n.resources?.disk?.total || 0, ...vals) * 1.05],
];
const ndNode = () => MC.nodes.find((n) => n.id === ND.id);
function openNode(id) {
  if (!MC.nodes.some((n) => n.id === id)) return;
  Object.assign(ND, { id, samples: null, err: '', at: 0, runs: new Map(), taskKey: '', log: null, lastFocus: document.activeElement });
  $('nodeModal').hidden = false;
  ndBuild();
  ndRender();
  ndMetrics();
  $('nodeModal').querySelector('[data-close].icon-btn').focus();
}
function closeNode() {
  if ($('nodeModal').hidden) return;
  $('nodeModal').hidden = true;
  ND.id = null;
  ND.lastFocus?.focus?.({ preventScroll: true });
}
$('nodeModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeNode(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('nodeModal').hidden) { e.stopImmediatePropagation(); closeNode(); }
}, true);
function ndBuild() {
  const body = $('ndBody'), row = el('div', 'range-row'), pick = el('div', 'range-picker');
  pick.setAttribute('role', 'group');
  pick.setAttribute('aria-label', 'Chart time range');
  for (const r of ND_RANGES) {
    const b = el('button', '', r);
    b.type = 'button';
    b.dataset.range = r;
    b.setAttribute('aria-pressed', String(r === ND.range));
    b.addEventListener('click', () => {
      if (r === ND.range) return;
      ND.range = r;
      store.set('cw.nd.range', r);
      for (const x of pick.children) x.setAttribute('aria-pressed', String(x.dataset.range === r));
      ndMetrics();
    });
    pick.append(b);
  }
  row.append(el('span', '', 'Charts show'), pick);
  const grid = el('div', 'nd-grid');
  grid.id = 'ndCharts';
  ND.draws = ND_CHARTS.map(([key, title, get, fmt, top]) => {
    const card = el('div', 'm-card nd-chart'), headRow = el('div', 'tile-top'), host = el('div'), val = el('span', 'nd-val', '–');
    card.dataset.chart = key;
    headRow.append(el('h3', '', title), val);
    card.append(headRow, host);
    grid.append(card);
    return ndChart(host, val, get, fmt, top);
  });
  const run = section('Running here'), log = section('Log');
  run.id = 'ndRun';
  log.id = 'ndLog';
  ND.els = { charts: grid, run, log };
  body.replaceChildren(row, grid, run, log);
  ndLogRender();
}
function ndRender() {
  const n = ndNode();
  if (!n) return closeNode(); // removed meanwhile
  const st = nodeState(n);
  $('ndTitle').textContent = n.name;
  $('ndSub').textContent = [n.local ? 'This server · the head' : null, OS_NAME[n.os] || n.os, n.arch, st.label,
    !n.local && (n.lastSeen ? `${n.connected ? 'seen' : 'last seen'} ${relTime(n.lastSeen)}` : 'never connected')].filter(Boolean).join(' · ');
  // What runs here: tap for the drawer; a remote run's phase timeline under it (re-read when its phase moves on).
  const tasks = n.tasks || [], key = tasks.map((t) => `${t.id}:${t.phase || ''}:${t.waiting_for || ''}`).join(',');
  if (key !== ND.taskKey) {
    ND.taskKey = key;
    for (const t of tasks) if (!n.local) ndLoadRun(t.id);
  }
  const box = ND.els.run;
  box.replaceChildren(box.firstElementChild);
  if (!tasks.length) box.append(el('p', 'nd-note', n.connected && n.enabled && !n.draining ? 'Idle: nothing running here.' : 'Nothing running here.'));
  for (const t of tasks) {
    const wrap = el('div', 'nd-task'), b = el('button', 'mc-task'), main = el('span');
    b.type = 'button';
    main.append(el('span', 't', displayTitle(t)), el('span', 's', [`#${t.id}`, t.project, `${shortLabel(t.agent)} · ${modelName(t.agent, t.model)}`,
      t.phase && t.phase !== 'running' ? PHASE_DOING[t.phase] : ''].filter(Boolean).join(' · ')));
    const e = el('span', t.waiting_for ? 'e wait' : 'e', t.waiting_for ? 'waiting' : fmtDur(Date.now() / 1000 - t.started_at));
    if (!t.waiting_for) e.dataset.started = t.started_at;
    b.append(main, e);
    b.addEventListener('click', () => { closeNode(); closeServer(); openTask(t.id); });
    wrap.append(b);
    const tl = ND.runs.get(t.id) && timelineSection(ND.runs.get(t.id), true);
    if (tl) wrap.append(tl);
    box.append(wrap);
  }
}
async function ndLoadRun(id) {
  const node = ND.id;
  try {
    const d = await api(`/api/orch/task/${id}`), r = d.runs.at(-1);
    if (ND.id !== node || !r) return;
    ND.runs.set(id, { phases: r.phases, errors: r.errors, outcome: r.outcome });
    ndRender();
  } catch {}
}
async function ndMetrics() {
  const id = ND.id, seq = ++ND.seq, grid = ND.els.charts;
  grid?.classList.add('loading'); // the charts keep their frame while the new range loads
  try {
    const d = await api(`/api/cluster/nodes/${encodeURIComponent(id)}/metrics?range=${ND.range}`);
    if (seq !== ND.seq || ND.id !== id) return;
    ND.samples = d.samples || [];
    ND.err = '';
  } catch (e) {
    if (seq !== ND.seq) return;
    ND.err = e.message;
  }
  ND.at = Date.now();
  grid?.classList.remove('loading');
  ND.draws.forEach((draw) => draw());
}
// A single-series chart of the node's samples across the chosen range: line, a faint area, and a crosshair readout.
function ndChart(host, val, get, fmt, top) {
  host.className = 'sline';
  host.innerHTML = '<svg aria-hidden="true"><line class="base"/><path class="area"/><path class="line"/><line class="cross" hidden/><circle class="pt" r="4" hidden/></svg><div class="tip" hidden></div>';
  const svg = host.querySelector('svg'), [base, area, line, cross, pt] = svg.children, tip = host.querySelector('.tip');
  const label = el('div', 'sline-label'), [lFrom, lStat] = [el('span'), el('span', 'stat')];
  label.append(lFrom, lStat, el('span', '', 'now'));
  host.after(label);
  let hoverX = null, pts = [];
  function draw() {
    const n = ndNode(), w = host.clientWidth, h = host.clientHeight, end = Date.now(), start = end - RANGE_MS[ND.range], span = end - start;
    if (!n || !w) return;
    lFrom.textContent = RANGE_AGO[ND.range];
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    for (const [k, v] of [['x1', 0], ['x2', w], ['y1', h - 0.5], ['y2', h - 0.5]]) base.setAttribute(k, v);
    pts = (ND.samples || []).map((s) => [s.t, get(s, n)]).filter(([t, v]) => v != null && Number.isFinite(v) && t >= start);
    const last = pts.at(-1)?.[1];
    val.textContent = last != null ? fmt(last) : '–';
    if (pts.length < 2) {
      line.setAttribute('d', '');
      area.setAttribute('d', '');
      lStat.textContent = ND.err || (ND.samples ? 'collecting…' : 'loading…');
      cross.setAttribute('hidden', ''); pt.setAttribute('hidden', ''); tip.hidden = true;
      return;
    }
    const vals = pts.map((p) => p[1]), max = top(n, vals) || 1;
    const x = (t) => ((t - start) / span) * w, y = (v) => h - 1 - Math.min(v / max, 1) * (h - 6);
    // A gap in the readings (the machine was away) breaks the line instead of bridging it.
    const steps = pts.slice(1).map((p, i) => p[0] - pts[i][0]).sort((a, b) => a - b), gap = Math.max(60e3, 3 * steps[Math.floor(steps.length / 2)]);
    let d = '', ad = '', from = 0;
    const closeRun = (i) => { if (i > from) ad += `L${x(pts[i - 1][0]).toFixed(1)},${h}L${x(pts[from][0]).toFixed(1)},${h}Z`; };
    pts.forEach(([t, v], i) => {
      const brk = i === 0 || t - pts[i - 1][0] > gap;
      if (brk && i) { closeRun(i); from = i; }
      const seg = `${brk ? 'M' : 'L'}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      d += seg;
      ad += seg;
    });
    closeRun(pts.length);
    line.setAttribute('d', d);
    area.setAttribute('d', ad);
    lStat.textContent = `avg ${fmt(vals.reduce((a, b) => a + b, 0) / vals.length)} · peak ${fmt(Math.max(...vals))}`;
    if (hoverX == null) { cross.setAttribute('hidden', ''); pt.setAttribute('hidden', ''); tip.hidden = true; return; }
    const tAt = start + (hoverX / w) * span;
    let i = 0;
    for (let k = 1; k < pts.length; k++) if (Math.abs(pts[k][0] - tAt) < Math.abs(pts[i][0] - tAt)) i = k;
    const cx = x(pts[i][0]), cy = y(pts[i][1]);
    cross.removeAttribute('hidden'); pt.removeAttribute('hidden');
    for (const [k, v] of [['x1', cx], ['x2', cx], ['y1', 0], ['y2', h]]) cross.setAttribute(k, v);
    pt.setAttribute('cx', cx); pt.setAttribute('cy', cy);
    tip.hidden = false;
    tip.textContent = `${fmt(pts[i][1])} · ${new Date(pts[i][0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: span <= 3600e3 ? '2-digit' : undefined })}`;
    tip.style.left = `${Math.max(70, Math.min(w - 70, cx))}px`;
  }
  host.addEventListener('pointermove', (e) => { hoverX = e.clientX - host.getBoundingClientRect().left; draw(); });
  host.addEventListener('pointerleave', () => { hoverX = null; draw(); });
  return draw;
}
// The worker's log tail, fetched when asked (this server logs to its journal instead).
function ndLogRender() {
  const box = ND.els.log, n = ndNode();
  if (!box || !n) return;
  box.replaceChildren(box.firstElementChild);
  if (n.local) {
    const p = el('p', 'nd-note', 'This server writes its log to the system journal: ');
    p.append(el('code', '', 'journalctl -u agent-orch -n 200'));
    box.append(p);
    return;
  }
  const L = ND.log, row = el('div', 'nd-logbar'), b = el('button', 'btn small', L?.lines ? 'Refresh' : 'View logs');
  b.type = 'button';
  b.id = 'ndLogs';
  b.disabled = !!L?.loading;
  ND.els.logBtn = b;
  b.addEventListener('click', ndLogs);
  row.append(b);
  if (L?.loading) row.append(el('span', 'nd-note', 'Fetching the last 200 lines…'));
  else if (L?.lines) row.append(el('span', 'nd-note', `Last ${plural(L.lines.length, 'line')} · fetched ${new Date(L.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`));
  box.append(row);
  if (L?.error) box.append(el('p', 'nd-note bad', L.error));
  if (L?.lines) {
    const pre = el('pre', 'dr-pre nd-log', L.lines.join('\n') || '(empty)');
    box.append(pre);
    requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; }); // newest lines in view
  }
}
async function ndLogs() {
  const id = ND.id;
  ND.log = { ...ND.log, loading: true, error: '' };
  ndLogRender();
  try {
    const d = await api(`/api/cluster/nodes/${encodeURIComponent(id)}/logs?tail=200`);
    if (ND.id !== id) return;
    ND.log = { lines: d.lines, at: d.at || Date.now() };
  } catch (e) {
    if (ND.id !== id) return;
    ND.log = { ...ND.log, loading: false, error: e.message };
  }
  ndLogRender();
  ND.els.logBtn?.focus({ preventScroll: true });
}
// Live times while the detail is open: elapsed per task and the running step of each timeline.
setInterval(() => {
  if (!ND.id) return;
  for (const n of document.querySelectorAll('#ndBody .mc-task .e[data-started]')) n.textContent = fmtDur(Date.now() / 1000 - Number(n.dataset.started));
  for (const n of document.querySelectorAll('#ndBody .tl-bar i[data-since]')) n.style.flexGrow = String(Math.max(1, Date.now() - Number(n.dataset.since)));
  for (const n of document.querySelectorAll('#ndBody .tl-steps [data-since]')) n.textContent = `${fmtDur((Date.now() - Number(n.dataset.since)) / 1000)}…`;
}, 1000);
addEventListener('resize', () => { if (ND.id) ND.draws.forEach((d) => d()); });

const installCmd = (os, code) => {
  const o = location.origin;
  return os === 'mac' ? `curl -fsSL ${o}/install/worker-macos.sh | sudo bash -s -- --controller ${o} --code ${code} --agents claude,codex`
    : `curl -fsSL ${o}/install/worker-linux.sh | bash -s -- --controller ${o} --code ${code} --agents claude,codex`;
};
// How many machines the code pairs: one (a one-time code, valid 10 min) or several in one go (one code, valid 1 h).
function amUsesPicker() {
  const row = el('label', 'am-uses'), sel = el('select');
  sel.id = 'amUses';
  for (const n of AM_USES) {
    const o = el('option', '', n === 1 ? '1 machine' : `${n} machines`);
    o.value = String(n);
    o.selected = n === AM.uses;
    sel.append(o);
  }
  sel.addEventListener('change', () => newPairing(Number(sel.value)));
  row.append(el('span', '', 'Add'), sel, el('span', 'am-hint', AM.uses > 1 ? 'one code for all of them, valid 1 hour' : 'one-time code, valid 10 minutes'));
  return row;
}
// A multi-use code's machines so far, each with where it is: connected, or waiting for its worker to start.
function amPairedList(list) {
  const ul = el('ul', 'am-list');
  for (const n of list) {
    const li = el('li');
    li.append(el('span', `dot ${n.connected ? 'on' : 'wait'}`), el('span', 'am-name', n.name), el('span', 'am-state', n.connected ? 'Connected' : 'Waiting for its worker…'));
    ul.append(li);
  }
  return ul;
}
function renderAddMachine() {
  const body = $('amBody'), p = AM.pairing, multi = AM.uses > 1, node = !multi && p?.node, refocus = document.activeElement?.id === 'amUses';
  const paired = multi ? p?.nodes || [] : [], open = multi ? (p?.state ?? 'waiting') === 'waiting' && AM.expiresAt > Date.now() : !node;
  const picker = amUsesPicker(), nodes = [picker];
  if (AM.err) nodes.push(el('p', 'cn-err', AM.err));
  if (!AM.code) {
    body.replaceChildren(...nodes, el('p', 'am-note', AM.err ? '' : 'Getting a pairing code…'));
    if (refocus) picker.querySelector('select').focus();
    return;
  }
  if (open) {
    nodes.push(el('p', 'am-note', multi ? `Run the same line on each machine, up to ${AM.uses}. Each one pairs as a machine of its own and names itself after its model and host name, like “MacBook Pro (Sanat-MBP-2)”; rename any of them later.`
      : 'Run one line on the new machine. It installs Node 22 and the worker, signs in to GitHub if needed, pairs with this server and starts at boot.'));
    for (const [os, label, note] of [['linux', 'Linux VPS (systemd)', ''], ['mac', 'macOS (launchd)', 'Runs as a separate standard user, agentorch, so agents can’t see your files. It starts at boot and keeps the Mac awake only while tasks run on power.']]) {
      const cmd = installCmd(os, AM.code), pre = el('pre', 'am-cmd copy-cmd');
      pre.dataset.copy = cmd;
      pre.title = 'Click to copy';
      pre.append(el('code', '', cmd));
      const wrap = el('div');
      wrap.append(el('p', 'am-os', label), pre);
      if (note) wrap.append(el('p', 'am-note', note));
      nodes.push(wrap);
    }
  }
  const st = el('div', 'am-status');
  st.setAttribute('role', 'status');
  const expired = p?.state === 'expired' || (!node && AM.expiresAt && AM.expiresAt < Date.now()), valid = fmtDur(Math.max(0, Math.round((AM.expiresAt - Date.now()) / 1000)));
  const [dot, text] = multi ? (p?.state === 'paired' ? [paired.every((n) => n.connected) ? 'on' : 'wait', `All ${AM.uses} machines paired`]
    : p?.state === 'revoked' ? ['off', `Code revoked: ${paired.length} of ${AM.uses} paired`]
      : expired ? ['off', `This code expired: ${paired.length} of ${AM.uses} paired`]
        : ['wait', `Waiting for machines: ${paired.length} of ${AM.uses} paired (code ${AM.code}, valid ${valid})`])
    : node?.connected ? ['on', `Connected: ${node.name}`]
      : node ? ['wait', `Paired: ${node.name}. Waiting for its worker to start…`]
        : expired ? ['off', 'This code expired.']
          : p?.state === 'revoked' ? ['off', 'This code was revoked.']
            : ['wait', `Waiting for the machine to connect… (code ${AM.code}, valid ${valid})`];
  st.append(el('span', `dot ${dot}`), el('span', '', text));
  nodes.push(st);
  if (paired.length) nodes.push(amPairedList(paired));
  if (node) nodes.push(el('p', 'am-next', `Next: sign the agents in on ${node.name}. Claude Code and Codex use that machine’s own login, so run \`claude\` and \`codex login --device-auth\` there once; signing in from here comes next.`));
  if (paired.length) nodes.push(el('p', 'am-next', 'Next: sign the agents in on each machine: Connections lists every machine at the top.'));
  const acts = el('div', 'am-acts');
  if (multi && open) {
    const revoke = el('button', 'btn danger', 'Revoke code');
    revoke.type = 'button';
    revoke.title = 'No more machines can pair with this code; the ones that did stay';
    revoke.addEventListener('click', revokePairing);
    acts.append(revoke);
  }
  if (expired || node || (multi && !open)) {
    const again = el('button', 'btn', node ? 'Add another' : 'New code');
    again.type = 'button';
    again.addEventListener('click', () => newPairing());
    acts.append(again);
  }
  const done = el('button', `btn${node?.connected || paired.some((n) => n.connected) ? ' primary' : ''}`, node || paired.length ? 'Done' : 'Close');
  done.type = 'button';
  done.addEventListener('click', closeAddMachine);
  acts.append(done);
  nodes.push(acts);
  body.replaceChildren(...nodes);
  if (refocus) picker.querySelector('select').focus();
}
// A new code for `uses` machines. The code it replaces is revoked when no machine used it.
async function newPairing(uses = AM.uses) {
  const old = AM.code, p = AM.pairing;
  if (old && !p?.node && !p?.used) api(`/api/cluster/pair/${encodeURIComponent(old)}`, 'DELETE').catch(() => {});
  Object.assign(AM, { code: null, pairing: null, err: '', uses });
  renderAddMachine();
  try {
    const r = await api('/api/cluster/pair', 'POST', uses > 1 ? { uses } : undefined);
    Object.assign(AM, { code: r.code, expiresAt: r.expiresAt, pairing: uses > 1 ? { state: 'waiting', uses, used: 0, nodes: [] } : null });
  } catch (e) { AM.err = e.message; }
  renderAddMachine();
}
async function revokePairing() {
  if (!AM.code) return;
  try { AM.pairing = await api(`/api/cluster/pair/${encodeURIComponent(AM.code)}`, 'DELETE'); toast('Code revoked: no more machines can pair with it'); } catch (e) { toast(e.message, { kind: 'error' }); }
  renderAddMachine();
}
// Re-reads the code's state (the 'cluster' push usually arrives first; the 4 s timer also ticks the countdown) until it
// settles: its machine connected, or a multi-use code done pairing with every machine connected.
async function checkPairing() {
  const p = AM.pairing, settled = AM.uses > 1 ? p && p.state !== 'waiting' && p.nodes?.every((n) => n.connected) : p?.node?.connected;
  // Not while the machine-count menu is in use: a render would close it.
  if ($('machineModal').hidden || !AM.code || settled || document.activeElement?.id === 'amUses') return;
  try { AM.pairing = await api(`/api/cluster/pair/${encodeURIComponent(AM.code)}`); } catch { return; }
  renderAddMachine();
}
function openAddMachine() {
  AM.lastFocus = document.activeElement;
  $('machineModal').hidden = false;
  // A multi-use code still pairing is shown again (close and reopen between Macs); otherwise a new one-time code.
  if (AM.code && AM.uses > 1 && AM.pairing?.state === 'waiting' && AM.expiresAt > Date.now()) { renderAddMachine(); checkPairing(); } else newPairing(1);
  clearInterval(AM.timer);
  AM.timer = setInterval(checkPairing, 4000); // the 'cluster' push usually gets here first; this also ticks the countdown
  $('machineModal').querySelector('[data-close].icon-btn').focus();
}
function closeAddMachine() {
  $('machineModal').hidden = true;
  clearInterval(AM.timer);
  if (!$('serverModal').hidden) loadMachines();
  AM.lastFocus?.focus?.();
}
$('addMachine').addEventListener('click', openAddMachine);
$('machineModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeAddMachine(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('machineModal').hidden) { e.stopImmediatePropagation(); closeAddMachine(); }
}, true);

// ---------- usage window ----------
// Per-agent plan windows, tokens and limit hits over time (GET /api/usage/history, see usage.mjs).
const U = { range: { '6h': 1, '24h': 1, '7d': 1, '30d': 1 }[store.get('cw.urange')] ? store.get('cw.urange') : '24h', data: null, err: '', at: 0, lastFocus: null, draws: [] };
const USAGE_AGENTS = ['claude', 'codex'];
const WIN_NAMES = { five_hour: '5-hour', seven_day: 'Weekly', '5h': '5-hour', weekly: 'Weekly' };
const SERIES = ['var(--accent)', 'var(--chart-2)', 'var(--chart-3)', 'var(--faint)'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// claude five_hour/seven_day_opus, codex 5h/weekly.
function winLabel(w) {
  if (WIN_NAMES[w]) return WIN_NAMES[w];
  let m = w.match(/^seven_day_(.+)$/);
  if (m) return `Weekly ${cap(m[1].replace(/_/g, ' '))}`;
  m = w.match(/^(.+)-(5h|weekly)$/);
  if (m) return `${cap(m[1].replace(/-/g, ' '))} · ${WIN_NAMES[m[2]]}`;
  return cap(w.replace(/_/g, ' '));
}
const winRank = (w) => (/(^|-)5h$|five_hour/.test(w) ? 0 : /(^|-)weekly$|^seven_day$/.test(w) ? 1 : 2);
const byWin = (a, b) => winRank(a) - winRank(b) || a.localeCompare(b);
// A limit scope (state.blocks key / task limit_scope: 'claude', 'codex') as a name.
const limitName = (id) => (id === 'claude' ? 'Claude' : agentLabel(id));
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
  const hit = (label, at) => { const c = el('span', 'ug-chip crit', `${label} · ${at ? `until ${fmtWhen(at * 1000)}` : 'reset time unknown'}`); box.append(c); return c; };
  if (a.status.blocked) hit('Limit hit', a.status.resetsAt);
  for (const w of Object.keys(a.status.windows).sort(byWin)) {
    const s = a.status.windows[w], reset = s.resetsAt ? s.resetsAt * 1000 : null;
    const c = el('span', `ug-chip ${reset && reset <= now ? '' : level(s.pct)[0]}`,
      reset && reset <= now ? `${winLabel(w)} · reset ${fmtWhen(reset)}` : `${winLabel(w)} ${Math.round(s.pct)}% · ${reset ? `resets ${fmtWhen(reset)}` : 'reset time unknown'}${s.stale ? ' · stale' : ''}`);
    c.title = `Read ${fmtWhen(s.t)}${s.stale ? ' (older than the window)' : ''}`;
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
  const [lFrom, lStat, lNow] = [el('span', '', U.data?.range === '6h' ? fmtWhen(U.data.from) : RANGE_AGO[U.range] || `${U.range} ago`), el('span', 'stat'), el('span', '', 'now')];
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
  rows.sort((x, y) => (x.hit || x.cleared).t - (y.hit || y.cleared).t);
  if (!rows.length) return el('p', 'na', 'No limits hit in this range.');
  const ul = el('ul', 'm-list ug-limits');
  for (const r of rows.reverse()) {
    const li = el('li');
    const { window: win } = r.hit || r.cleared;
    const what = win ? winLabel(win) : '';
    li.append(el('span', 'k', `${r.hit ? `Hit ${fmtWhen(r.hit.t)}` : 'Hit before this range'}${what ? ` · ${what}` : ''}`));
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
  } else lc.append(el('p', 'na', limitsHidden(id) ? 'Limits not exposed by CLI' : 'No window readings in this range.'));
  const bc = col(d.bucketMs >= 864e5 ? 'Tokens per day' : d.bucketMs < 3600e3 ? 'Tokens per 15 min' : 'Tokens per hour');
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
  $('usageModal').querySelector('[data-close].icon-btn').focus();
}
function closeUsage(restoreFocus = true) {
  $('usageModal').hidden = true;
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
const kindLabel = (t) => (t.kind === 'reflect' ? 'Reflection' : t.kind === 'plan' ? 'Planner' : t.kind === 'review' ? 'Review break' : t.source === 'reflection' ? 'Task · from reflection' : 'Task');

function taskState(t) {
  const nowS = Date.now() / 1000;
  if (t.kind === 'review') { // a checkpoint (flag glyph): it never runs, it waits for the owner
    if (t.status === 'awaiting_review') return { cls: 'review awaiting', label: `Waiting for your review${t.review?.task ? ` of #${t.review.task}` : ''}` };
    if (t.status === 'queued') return { cls: 'review', label: 'Wait for your review' };
    if (t.status === 'done') return { cls: 'review done', label: 'Approved' };
  }
  switch (t.status) {
    case 'running':
      return { cls: 'running', label: `${t.kind === 'reflect' ? 'Looking through the project' : 'Running'} · ${fmtDur(nowS - (t.started_at || nowS))}` };
    case 'done':
      return { cls: 'done', label: t.summary ? `Done · ${t.summary}` : 'Done' };
    case 'failed': {
      const m = /^blocked: #(\d+)/.exec(t.summary || '');
      return { cls: 'failed', label: m ? `Blocked because #${m[1]} failed` : `Failed${t.summary ? ` · ${t.summary}` : ''}` };
    }
    case 'paused': // the owner stopped it: session and worktree kept, the scheduler skips it until Resume
      return { cls: 'paused', label: 'Paused by you' };
    case 'needs_integration': // its branch conflicted with main; an integrator task merges it (worktrees.mjs)
      return { cls: 'waiting', label: `Needs integration${t.summary ? ` · ${t.summary}` : ''}` };
    case 'cancelled': {
      const m = /^cancelled with #(\d+)/.exec(t.summary || '');
      return { cls: 'cancelled', label: m ? `Cancelled with #${m[1]}` : 'Cancelled' };
    }
  }
  const ms = modelStatus(t);
  if (ms.kind === 'waiting') return { cls: 'limited', label: ms.text };
  if (O.project && O.project.id === t.project_id && O.project.status === 'paused') return { cls: 'waiting', label: 'Paused' };
  const waitsFor = taskDeps(t).filter((d) => O.tasks.get(d)?.status !== 'done');
  if (waitsFor.length) return { cls: 'waiting', label: `Waits for ${waitsFor.map((d) => `#${d}`).join(', ')}` };
  if (t.not_before > nowS) return { cls: 'waiting', label: `Retrying at ${fmtClock(t.not_before)}` };
  return { cls: 'queued', label: `Queued${t.continuations ? ' · continuing' : t.attempts ? ` · attempt ${t.attempts + 1}` : ''}` };
}

// Every prerequisite of a task (it starts once all are done); older views only carry depends_on.
function taskDeps(t) { return t?.deps || (t?.depends_on ? [t.depends_on] : []); }

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
  title.textContent = title.title = displayTitle(t);
  sub.textContent = '';
  sub.append(el('span', 'id', `#${t.id}`));
  const info = parallelInfo(t);
  if (info.group) sub.append(el('span', 'lane-group', ` · Group ${info.group}`));
  if (info.integrates.length) sub.append(el('span', '', ` · Integrates ${info.integrates.map(id => `#${id}`).join(' ')}`));
  // A queued task with prerequisites shows them ('after #N, #M'), so the queue's dependencies are visible.
  const deps = t.status === 'queued' ? taskDeps(t) : [];
  if (deps.length) {
    sub.append(document.createTextNode(' · '));
    const a = el('span', 'tc-after', 'after ');
    a.title = `Starts after ${deps.map((d) => `#${d}`).join(' and ')}`;
    deps.forEach((d, i) => {
      const link = el('span', '', `#${d}`);
      link.setAttribute('role', 'link');
      link.addEventListener('click', (e) => { e.stopPropagation(); showTask(d); });
      a.append(...(i ? [document.createTextNode(', ')] : []), link);
    });
    sub.append(a);
  }
  // A limit wait is spelled out by the model chip; the sub line keeps just the time (the chip is clipped on phones).
  const wait = s.cls === 'limited' && modelStatus(t);
  sub.append(document.createTextNode(` · ${wait ? `Waiting until ${fmtWhen(wait.until * 1000)}` : deps.length && s.label.startsWith('Waits for #') ? 'Waiting' : s.label}`));
  const where = taskMachine(t);
  if (where) sub.append(el('span', 'tc-node', ` · ${where}`));
  tags.textContent = '';
  const open = t.status === 'queued' || t.status === 'running';
  if (open && t.urgency === 'urgent') tags.append(el('span', 'tc-tag urgent', 'Urgent'));
  if (open && t.urgency === 'background') tags.append(el('span', 'tc-tag', 'Later'));
  if (open && t.deadline) tags.append(el('span', 'tc-tag due', `Due ${fmtDue(t.deadline)}`));
  if (t.kind !== 'plan' && t.kind !== 'review') tags.append(modelChip(t));
  if (t.kind === 'work' && ['running', 'paused'].includes(t.status)) tags.append(cardControl(t));
  if (canAddBreak(t)) {
    const rb = el('span', 'tc-tag tc-rb');
    rb.innerHTML = `${FLAG_SVG}<span class="rb-t">+ Review break</span>`;
    rb.setAttribute('role', 'button');
    rb.setAttribute('aria-label', '+ Review break');
    rb.tabIndex = 0;
    rb.title = 'Stop after this task and wait for your review before anything that depends on it runs';
    const go = (e) => { e.stopPropagation(); e.preventDefault(); addReviewBreak(t.id); };
    rb.addEventListener('click', go);
    rb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
    rb.addEventListener('pointerdown', (e) => e.stopPropagation()); // not a queue drag
    tags.append(rb);
  }
  b.classList.toggle('review-card', t.kind === 'review');
  b.classList.toggle('active', O.drawer === id);
  // Waiting checkpoints in the chat and the queue get their review panel right under the card.
  if (b.isConnected) syncReviewPanel(b, t); else queueMicrotask(() => b.isConnected && syncReviewPanel(b, O.tasks.get(id)));
}
// A running work task's card pauses it; a paused one's resumes it (the card itself is a button, so this is a role=button span).
function cardControl(t) {
  const paused = t.status === 'paused', busy = TC.busy.has(t.id);
  const c = el('span', `tc-tag tc-ctl${paused ? ' resume' : ''}`, busy ? (paused ? 'Resuming…' : 'Pausing…') : paused ? 'Resume' : 'Pause');
  c.setAttribute('role', 'button');
  c.setAttribute('aria-label', `${paused ? 'Resume' : 'Pause'} #${t.id}`);
  c.setAttribute('aria-disabled', String(busy));
  c.tabIndex = 0;
  c.title = paused ? 'Continue the same session where it stopped' : 'Stop the agent now; its session and worktree are kept';
  const go = (e) => { e.stopPropagation(); e.preventDefault(); if (!busy) taskControl(t.id, paused ? 'resume' : 'pause'); };
  c.addEventListener('click', go);
  c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
  c.addEventListener('pointerdown', (e) => e.stopPropagation()); // not a queue drag
  return c;
}
// POST /api/orch/tasks/:id/pause | resume | handoff. Pause and handoff answer once the run has stopped.
const TC = { busy: new Set() };
async function taskControl(id, what, body) {
  TC.busy.add(id);
  refreshCards(id);
  if (O.drawer === id) renderDrawer();
  try {
    const r = await api(`/api/orch/tasks/${id}/${what}`, 'POST', body);
    if (r.task) O.tasks.set(r.task.id, { ...(O.tasks.get(r.task.id) || {}), ...r.task });
    const done = { pause: `#${id} paused`, resume: `#${id} resumed`, handoff: `#${id} handed off to ${body ? fbName(body) : 'another agent'}` }[what];
    toast(r.note || (r.pending ? `#${id} is still stopping; it will be ${what === 'pause' ? 'paused' : 'handed off'} when it does` : done), { kind: r.note || r.warning ? 'info' : 'success' });
    if (r.warning) toast(r.warning, { kind: 'info' });
    return r;
  } catch (e) {
    toast(e.message, { kind: 'error' });
    throw e;
  } finally {
    TC.busy.delete(id);
    refreshCards(id);
    scheduleQueue();
    if (O.drawer === id) loadDetail();
  }
}
const FLAG_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// '+ Review break' fits after a queued or running work task that doesn't already have one waiting.
const canAddBreak = (t) => t.kind === 'work' && ['queued', 'running'].includes(t.status)
  && ![...O.tasks.values()].some((r) => r.kind === 'review' && ['queued', 'awaiting_review'].includes(r.status) && taskDeps(r).includes(t.id));
async function addReviewBreak(id) {
  try {
    const r = await api(`/api/orch/tasks/${id}/checkpoint`, 'POST', {});
    if (r.task) O.tasks.set(r.task.id, r.task);
    refreshCards(id);
    scheduleQueue();
    toast(`Review break added after #${id}`, { kind: 'success' });
  } catch (e) { toast(e.message, { kind: 'error' }); }
}
function syncReviewPanel(b, t) {
  const next = b.nextElementSibling, has = next?.classList.contains('rv-panel') ? next : null;
  const show = t?.status === 'awaiting_review' && b.parentElement?.closest('.task-cards, .q-review');
  if (!show) { has?.remove(); return; }
  const sig = JSON.stringify(t.review || null);
  if (has?.dataset.sig === sig) return;
  const p = reviewPanel(t);
  p.dataset.sig = sig;
  if (has) has.replaceWith(p); else b.after(p);
}
// What the owner reviews: the reviewed task's summary, changed files and screenshots, then Approve / Request changes.
function reviewPanel(t) {
  const p = el('div', 'rv-panel');
  const r = t.review || {};
  if (r.task) {
    const head = el('div', 'rv-head');
    head.append(el('span', 'id', `#${r.task}`), document.createTextNode(` ${r.title || ''}`));
    p.append(head);
  }
  if (r.summary) p.append(el('div', 'rv-summary', r.summary));
  if (r.files?.length) {
    const d = el('details', 'rv-files');
    d.append(el('summary', '', `${r.files.length} file${r.files.length === 1 ? '' : 's'} changed${r.commit ? ` · ${String(r.commit).slice(0, 8)}` : ''}`));
    const ul = el('ul');
    for (const f of r.files) { const li = el('li'); li.append(el('b', `rv-st ${f.status}`, f.status), document.createTextNode(` ${f.path}`)); ul.append(li); }
    d.append(ul);
    p.append(d);
  } else if (r.task) p.append(el('div', 'muted', r.commit ? 'Changed files are loading…' : 'No commit recorded for this task.'));
  if (r.shots?.length) p.append(shotGrid(r.shots.slice(-4)));
  const row = el('div', 'rv-actions');
  const ok = el('button', 'btn small primary', 'Approve & continue');
  const change = el('button', 'btn small', 'Request changes');
  const form = el('form', 'rv-change');
  form.hidden = true;
  const note = el('textarea');
  note.rows = 3;
  note.placeholder = 'What should change? A fix task is queued before anything else continues.';
  note.setAttribute('aria-label', 'Requested changes');
  const send = el('button', 'btn small primary', 'Queue the fix');
  form.append(note, send);
  const busy = (on) => { for (const x of [ok, change, send]) x.disabled = on; };
  ok.type = change.type = 'button';
  ok.onclick = async () => {
    busy(true);
    try { const res = await api(`/api/orch/tasks/${t.id}/approve`, 'POST', {}); if (res.task) { O.tasks.set(t.id, res.task); refreshCards(t.id); scheduleQueue(); } }
    catch (e) { busy(false); toast(e.message, { kind: 'error' }); }
  };
  change.onclick = () => { form.hidden = !form.hidden; if (!form.hidden) note.focus(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!note.value.trim()) return note.focus();
    busy(true);
    try {
      const res = await api(`/api/orch/tasks/${t.id}/request-changes`, 'POST', { note: note.value.trim() });
      if (res.task) { O.tasks.set(t.id, res.task); refreshCards(t.id); scheduleQueue(); }
      toast(`Queued #${res.fix} with your changes; the review comes back after it`, { kind: 'success' });
    } catch (err) { busy(false); toast(err.message, { kind: 'error' }); }
  };
  row.append(ok, change);
  p.append(row, form);
  return p;
}
// The machine a running task is on ('on vps-2', 'waiting for Mac mini (Mac asleep)'); tasks on the controller say
// 'on this server' only once the cluster has workers (MC.nodes, read when the Queue or Server details opens).
function taskMachine(t) {
  if (t.status !== 'running' || t.kind === 'plan') return '';
  if (t.waiting_for) return `waiting for ${t.waiting_for}`;
  if (t.node_name) return `on ${t.node_name}`;
  return MC.nodes.some((n) => !n.local) ? 'on this server' : '';
}
const refreshCards = (id) => document.querySelectorAll(`.tcard[data-task="${id}"]`).forEach((b) => fillCard(b, id));
const refreshAllCards = () => document.querySelectorAll('.tcard[data-task]').forEach((b) => fillCard(b, Number(b.dataset.task)));

function applyOrchSnapshot(s) {
  syncCompletionSound(s?.tasks);
  O.project = s?.project || null;
  if (s?.state) O.state = s.state;
  for (const t of s?.tasks || []) O.tasks.set(t.id, t);
  renderUsage();
  renderOrchBar();
  renderUpdateBanner();
  refreshAllCards();
  scheduleQueue();
}

function onOrch(msg) {
  if (msg.t === 'olane') return caEvent(msg.taskId); // live lane activity: particles on the cluster diagram (no lanes in the Queue)
  if (msg.t === 'otask' || msg.t === 'ostate') scheduleMachines(); // running tasks per machine
  if (msg.t === 'otask') {
    caTask(msg.task);
    observeTaskCompletion(msg.task);
    if (FB.local?.url === `/api/orch/tasks/${msg.task.id}/fallbacks`) msg.task.fallbacks = FB.local.list; // a save still in flight
    O.tasks.set(msg.task.id, msg.task);
    syncSidebarRunning();
    renderUsage();
    refreshCards(msg.task.id);
    for (const other of O.tasks.values()) if (taskDeps(other).includes(msg.task.id)) refreshCards(other.id);
    if (O.drawer === msg.task.id) { renderDrawerHead(); scheduleDetail(); }
    if (msg.task.project_id === O.project?.id) scheduleQueue();
  } else if (msg.t === 'oorder') {
    for (const r of msg.order || []) { const t = O.tasks.get(r.id); if (t) t.position = r.position; }
    if (msg.project_id === O.project?.id) scheduleQueue();
  } else if (msg.t === 'oproject') {
    const c = currentConvo();
    if (msg.project && c && msg.project.path === c.cwd) {
      O.project = msg.project;
      renderOrchBar();
      fbRender();
      refreshAllCards();
    }
  } else if (msg.t === 'ostate') {
    O.state = msg.state;
    renderUsage();
    fbRender();
    renderOrchBar();
    renderUpdateBanner();
    refreshAllCards();
  } else if (msg.t === 'orun' && O.drawer === msg.taskId && O.detail) {
    appendRunEntry(msg.runId, msg.e);
  }
}

// ----- the status bar above the chat
let obTogglePending = null;
function renderOrchBar() {
  renderConnFoot(); // routing rules decide whether a signed-out agent warrants the footer's warning
  syncSidebarRunning();
  renderSettings();
  const on = $('mode').value === 'orchestrator';
  $('orchBar').hidden = !on;
  if (!on) return;
  const p = O.project, s = O.state || {};
  const paused = (obTogglePending && obTogglePending.id === p?.id ? obTogglePending.status : p?.status) === 'paused';
  const running = p?.counts?.running || 0, queued = p?.counts?.queued || 0;
  // One short word; detail belongs in the Queue modal (.agent-orch/CONTEXT.md: the bar stays minimal).
  const status = paused ? 'Paused' : running ? 'Running' : queued ? 'Waiting' : 'Idle';
  blurSwap($('obStatus'), status);
  $('obState').dataset.state = status.toLowerCase();
  $('obState').title = s.pacing ? `Pacing: ${s.pacing}` : '';
  $('obQueueCount').hidden = !queued;
  $('obQueueCount').textContent = queued ? String(queued) : '';
  $('obQueue').setAttribute('aria-label', queued ? `Queue, ${queued} queued` : 'Queue');
  $('obPause').hidden = !p;
  $('obQueue').hidden = !p;
  if (p) {
    $('obPause').querySelector('.ob-label').textContent = paused ? 'Resume' : 'Pause';
    $('obPause').setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    $('obPause').classList.toggle('primary', paused);
    $('obPause').disabled = obTogglePending?.id === p.id;
    $('obPause').setAttribute('aria-busy', String(obTogglePending?.id === p.id));
  }
}
setInterval(() => { refreshAllCards(); renderOrchBar(); if (O.drawer) renderDrawerHead(); }, 15000);

async function orchProject(fields) {
  if (!O.project) return;
  try { await api(`/api/orch/project/${O.project.id}`, 'POST', fields); }
  catch (e) { add(el('div', 'notice error', e.message)); }
}
async function saveParallel(fields) {
  try {
    const result = await api('/api/orch/parallel', 'PUT', fields);
    O.state = result.state; renderOrchBar();
  } catch (e) { toast(e.message, { kind: 'error' }); renderOrchBar(); }
}
$('obPause').addEventListener('click', async () => {
  const p = O.project;
  if (!p || obTogglePending) return;
  const status = p.status === 'paused' ? 'active' : 'paused';
  obTogglePending = { id: p.id, status };
  renderOrchBar();
  try {
    await api(`/api/orch/project/${p.id}`, 'POST', { status });
    if (O.project?.id === p.id) O.project.status = status;
  } catch (e) { toast(e.message, { kind: 'error' }); }
  finally { obTogglePending = null; renderOrchBar(); }
});
// ----- Settings (sidebar gear): sound and parallel tasks for every project; the open project's reflection and options
function openSettings() {
  if ($('settingsModal').hidden) ST.lastFocus = document.activeElement;
  $('settingsModal').hidden = false;
  renderSettings();
  $('settingsModal').querySelector('.icon-btn[data-close]').focus();
}
function closeSettings() {
  $('settingsModal').hidden = true;
  ST.lastFocus?.focus?.();
}
const ST = { lastFocus: null };
$('settingsBtn').addEventListener('click', openSettings);
$('settingsModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settingsModal').hidden && $('fbModal').hidden) { e.stopImmediatePropagation(); closeSettings(); } }, true);
function renderSettings() {
  if ($('settingsModal').hidden) return;
  const s = O.state || {}, p = O.project;
  renderParallel(s);
  renderReflectModel();
  renderReflectBtn();
  $('stProject').hidden = !p;
  if (!p) return;
  $('stProjectTitle').textContent = `This project · ${p.path.split('/').pop()}`;
  // Never overwrite what the owner is typing (renderSettings runs on every state push).
  if (document.activeElement !== $('stDirection') && !DIR.timer && !DIR.saving) { $('stDirection').value = p.reflect_direction || ''; fitDirection(); }
}
// Reflection model: every discovered model of a signed-in agent; '' = routes, else Claude. Not rebuilt while open.
function renderReflectModel() {
  const sel = $('stReflectModel');
  if (document.activeElement === sel) return;
  const r = O.project?.reflect || {}, cur = r.agent ? `${r.agent}\n${r.model || ''}` : '';
  sel.replaceChildren(new Option('Default', ''));
  for (const a of AGENT_LIST) {
    if (!a.models?.length || !a.available || a.loggedIn === false) continue;
    const g = document.createElement('optgroup');
    g.label = a.label;
    for (const m of a.models) g.append(new Option(m.label || m.id, `${a.id}\n${m.id}`));
    sel.append(g);
  }
  if (cur && ![...sel.options].some((o) => o.value === cur)) sel.append(new Option(`${r.agent} · ${r.model || 'default'} (unavailable)`, cur));
  sel.value = cur;
}
$('stReflectModel').addEventListener('change', async (e) => {
  const [agent, model] = e.target.value.split('\n');
  try {
    if (!O.project) return;
    const d = await api(`/api/orch/projects/${O.project.id}/reflect-settings`, 'PUT', { model: agent ? { agent, model } : null });
    if (d.project && O.project?.id === d.project.id) O.project = d.project;
  } catch (err) { toast(err.message, { kind: 'error' }); }
  e.target.blur();
  renderSettings();
});
// Parallel tasks: what can run right now (state.capacity: this server's memory-guarded slots plus online workers') and
// how many run; the owner can only cap it lower ('' = no limit, else maxTasks).
function renderParallel(s) {
  const sel = $('stParallel');
  // A server that predates state.capacity (not restarted since this page's code changed): show what it does report.
  const c = s.capacity || (s.parallel && { running: s.workRunning ?? s.running ?? 0, max: s.slots ?? 0, controller: s.slots ?? 0,
    controllerMax: s.slots ?? 0, workers: 0, pacing: null, cap: s.parallel.maxTasks ?? null });
  sel.disabled = !c;
  if (!c) { $('stParHint').textContent = 'Checking what can run…'; if (!sel.options.length) sel.append(new Option('No limit', '')); return; }
  const tight = c.controller < c.controllerMax ? ` of ${c.controllerMax}, needs more free memory` : '';
  const where = c.workers ? ` (this server ${c.controller}${tight}, workers ${c.workers})` : tight ? ` (this server ${c.controller}${tight})` : '';
  const bits = [`${c.running} running`, `up to ${c.max} can run now${where}`];
  if (c.pacing != null && c.pacing < c.max) bits.push(`usage pacing allows ${c.pacing}`);
  if (!c.max) bits[1] = 'none can start now: memory is low';
  $('stParHint').textContent = bits.join(' · ');
  if (document.activeElement === sel) return; // not rebuilt while the owner is choosing
  const opts = [new Option(`No limit${c.max ? ` (${c.max})` : ''}`, '')];
  const top = Math.max(c.max - 1, c.cap || 0, 1);
  for (let n = 1; n <= top; n++) opts.push(new Option(`At most ${n}`, String(n)));
  sel.replaceChildren(...opts);
  sel.value = c.cap ? String(c.cap) : '';
}
$('stParallel').addEventListener('change', (e) => { saveParallel({ maxTasks: e.target.value ? Number(e.target.value) : null }); e.target.blur(); });
// Reflection direction (per project, optional): saved as you type (debounced) and on blur; blank = the reflector decides.
const DIR = { timer: null, saving: false };
// The box grows with its text (CSS caps it; past that it scrolls).
function fitDirection() { const b = $('stDirection'); b.style.height = 'auto'; b.style.height = `${b.scrollHeight + 2}px`; }
async function saveDirection() {
  clearTimeout(DIR.timer); DIR.timer = null;
  const p = O.project, text = $('stDirection').value.trim();
  if (!p || text === (p.reflect_direction || '')) return;
  DIR.saving = true;
  $('stDirSaved').textContent = 'Saving…';
  try {
    await api(`/api/orch/project/${p.id}`, 'POST', { reflectDirection: text });
    if (O.project?.id === p.id) O.project.reflect_direction = text || null;
    $('stDirSaved').textContent = text ? 'Saved. The next reflection follows it.' : 'Cleared. Reflection decides on its own.';
  } catch (e) { $('stDirSaved').textContent = `Couldn't save: ${e.message}`; }
  finally { DIR.saving = false; }
}
$('stDirection').addEventListener('input', () => { fitDirection(); clearTimeout(DIR.timer); DIR.timer = setTimeout(saveDirection, 900); $('stDirSaved').textContent = ''; });
$('stDirection').addEventListener('blur', () => { if (DIR.timer) saveDirection(); });
// A preset fills an empty box, or adds a line to what's there (once).
document.querySelector('.st-presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dir]');
  if (!b) return;
  const box = $('stDirection'), cur = box.value.trim(), add = b.dataset.dir;
  if (!cur.includes(add)) box.value = cur ? `${cur}\n${add}` : add;
  fitDirection();
  saveDirection();
});
// Reflection fallbacks: the same sheet as a chat's, saved for every project (no fetch).
$('stReflectBtn').addEventListener('click', () => openFallbacks(reflectFallbacks(), $('stReflectBtn')));

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
  if (e.key === 'Escape' && O.drawer && $('settingsModal').hidden && $('pickerModal').hidden && $('serverModal').hidden && $('connsModal').hidden && $('usageModal').hidden && $('queueModal').hidden && !e.target.closest?.('.dr-due')) {
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
    if (FB.local?.url === `/api/orch/tasks/${id}/fallbacks`) d.task.fallbacks = FB.local.list; // a save still in flight
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
  if (e.k === 'phases' || e.k === 'errors') run[e.k] = e[e.k]; // a remote run's timeline / worker errors, whole
  else if (e.k === 'end') run.outcome = e.outcome;
  else if (e.k !== 'start') run.entries.push(e);
  if (!drawerFrame) drawerFrame = requestAnimationFrame(() => { drawerFrame = 0; renderDrawer(true); });
}

function renderDrawerHead() {
  const id = O.drawer;
  const t = O.tasks.get(id) || O.detail?.task;
  $('drGlyph').className = `tc-glyph ${t ? taskState(t).cls : 'queued'}`;
  $('drKicker').textContent = t ? `#${t.id} · ${kindLabel(t)}` : `#${id}`;
  $('drTitle').textContent = t ? displayTitle(t) : 'Loading…';
}

// The Model row: one chip with the model and its fallbacks in order ("Opus → GPT-6-Sol"), bold on the one it's on once
// it has moved. On a queued or running work task the chip opens the fallback sheet; with no fallbacks an "Add fallback"
// chip of the same style sits beside it.
function modelSection(t) {
  const ms = modelStatus(t), c = section('Model');
  const editable = t.kind === 'work' && ['queued', 'running'].includes(t.status);
  const start = ms.from || ms.model;
  const chain = [{ name: start, current: !ms.from }, ...ms.list.filter((f) => f.name !== start || f.current).map((f) => ({ name: f.name, current: !!ms.from && f.current }))]
    .filter((x, i, a) => a.findIndex((y) => y.name === x.name) === i);
  const row = el('div', 'dr-model');
  const chip = el(editable ? 'button' : 'span', `tc-tag model ${ms.kind}${editable ? ' dr-chip-btn' : ''}`);
  if (ms.kind === 'delegated') chip.innerHTML = MOVED_SVG;
  const names = el('span'); // one inline run: a flex chip would trim the spaces around each arrow
  chain.forEach((x, i) => {
    if (i) names.append(document.createTextNode(' → '));
    names.append(x.current && chain.length > 1 ? el('strong', '', x.name) : document.createTextNode(x.name));
  });
  chip.append(names);
  chip.title = [ms.kind === 'waiting' || ms.kind === 'delegated' ? ms.text : '', chain.length > 1 ? 'Fallbacks at a limit, in order' : '', t.route_note].filter(Boolean).join(' — ');
  row.append(chip);
  if (editable) {
    chip.type = 'button';
    chip.setAttribute('aria-label', `${chain.map((x) => x.name).join(', then ')}. Edit fallbacks`);
    chip.onclick = () => openFallbacks(taskFallbacks(t.id), chip);
    if (chain.length === 1) {
      const add = el('button', 'tc-tag model normal dr-chip-btn', 'Add fallback'); // the model chip's own style
      add.type = 'button';
      add.title = `Pick models to move this task to if ${ms.model} hits its limit`;
      add.onclick = () => openFallbacks(taskFallbacks(t.id), add);
      row.append(add);
    }
  }
  c.append(row);
  if (ms.kind === 'waiting' || ms.kind === 'delegated') c.append(el('div', 'dr-check', ms.text));
  // Remote runs (cluster workers) name their machine; the controller's own runs don't.
  if (t.waiting_for) c.append(el('div', 'dr-check', `Waiting for ${t.waiting_for} to come back`));
  else if (t.node_name) c.append(el('div', 'dr-check', `${t.status === 'running' ? 'Running' : 'Ran'} on ${t.node_name}`));
  if (t.moves?.length) {
    const ul = el('ul', 'dr-events');
    for (const m of t.moves) {
      const li = el('li');
      li.append(el('time', '', fmtClock(m.at)), el('span', '', m.by === 'owner'
        ? `You moved it from ${modelName(m.from.agent, m.from.model)} → ${modelName(m.to.agent, m.to.model)}`
        : m.by === 'spread' ? `${modelName(m.from.agent, m.from.model)} was busy → moved to ${modelName(m.to.agent, m.to.model)} to run in parallel`
        : `${modelName(m.from.agent, m.from.model)} hit its limit → moved to ${modelName(m.to.agent, m.to.model)}`));
      ul.append(li);
    }
    c.append(ul);
  }
  return c;
}

function section(title) {
  const s = el('section', 'dr-sec');
  if (title) s.append(el('h3', '', title));
  return s;
}

// A remote run's timeline (job.phase from its worker): one thin bar whose segments take each step's share of the time
// (a 2px gap between them; the step in progress in the running blue, done ones neutral, the step it failed in red),
// then the same steps as text, which carries every value (the bar's hover titles only repeat it; a step cut short when
// the run stopped says so), the latest progress hints while the agent runs, and the errors the worker reported with
// their stderr or stack. The step in progress counts up live (the ticker below).
const PHASE_NAME = { queued: 'Queued', cloning: 'Clone', fetching: 'Fetch', installing: 'Install', running: 'Agent', checking: 'Check', committing: 'Commit', pushing: 'Push' };
const ERROR_KIND = { agent_crash: 'Agent crashed', setup_failed: 'Setup failed', install_failed: 'Install failed', push_failed: 'Push failed', check_crashed: 'Check crashed' };
function timelineSection(run, live) {
  const phases = run.phases || [], errors = run.errors || [];
  if (!phases.length && !errors.length) return null;
  const c = section('Timeline');
  const steps = phases.filter((p) => p.phase !== 'done'), end = phases.find((p) => p.phase === 'done');
  const ms = (p) => p.ms ?? Math.max(0, Date.now() - p.at);
  if (steps.length) {
    const bar = el('div', 'tl-bar'), list = el('ol', 'tl-steps');
    steps.forEach((p, i) => {
      const last = i === steps.length - 1, cur = live && !end && last && p.ms == null;
      const bad = last && end && end.outcome !== 'ok';
      const seg = el('i', cur ? 'cur' : bad ? 'bad' : ''), name = PHASE_NAME[p.phase] || p.phase;
      seg.style.flex = `${Math.max(1, ms(p))} 0 3px`;
      seg.title = `${name} · ${fmtDur(ms(p) / 1000)}${p.cut ? ' · stopped' : ''}`;
      const li = el('li', cur ? 'cur' : bad ? 'bad' : ''), time = el('span', 't', `${fmtDur(ms(p) / 1000)}${cur ? '…' : p.cut ? ' · stopped' : ''}`);
      if (cur) { time.dataset.since = p.at; seg.dataset.since = p.at; }
      li.append(el('span', 'n', name), time);
      bar.append(seg);
      list.append(li);
    });
    if (end) list.append(el('li', end.outcome === 'ok' ? 'end' : 'end bad', end.outcome === 'ok' ? 'Done' : OUTCOME_TEXT[end.outcome] || end.outcome.replace(/_/g, ' ')));
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `Time per step: ${steps.map((p) => `${PHASE_NAME[p.phase] || p.phase} ${fmtDur(ms(p) / 1000)}`).join(', ')}`);
    c.append(bar, list);
  }
  const hint = steps.findLast((p) => p.progress)?.progress;
  if (hint && (live || hint.tools)) {
    const words = [`${hint.tools} tool call${hint.tools === 1 ? '' : 's'}`, `${hint.files} file${hint.files === 1 ? '' : 's'} edited`];
    c.append(el('div', 'dr-check tl-hint', live && hint.last ? `${words.join(' · ')} · last: ${hint.last}` : words.join(' · ')));
  }
  for (const e of errors.slice(-3)) {
    const head = `${ERROR_KIND[e.kind] || e.kind.replace(/_/g, ' ')}${e.count > 1 ? ` (${e.count}×)` : ''}: ${e.message}`, tail = e.stderr || e.stack;
    if (!tail) { c.append(el('div', 'tl-err', head)); continue; }
    const d = el('details', 'tl-err');
    d.append(el('summary', '', head), el('pre', 'dr-pre err', tail));
    c.append(d);
  }
  return c;
}
// The step in progress counts up while its drawer is open: its time, and its segment's share of the bar.
setInterval(() => {
  if (!O.drawer) return;
  for (const n of document.querySelectorAll('#drBody .tl-bar i[data-since]')) n.style.flexGrow = String(Math.max(1, Date.now() - Number(n.dataset.since)));
  for (const n of document.querySelectorAll('#drBody .tl-steps [data-since]')) n.textContent = `${fmtDur((Date.now() - Number(n.dataset.since)) / 1000)}…`;
}, 1000);

// The drawer's 'Order' links: what a task starts after and what follows it.
function orderSection(d) {
  const after = d.after || (d.dependsOn ? [d.dependsOn] : []);
  if (!after.length && !d.followers.length) return null;
  const c = section('Order');
  const links = el('div', 'dr-links');
  if (after.length) links.append(el('div', 'dr-check', after.length > 1 ? `Starts after all ${after.length} of` : 'Starts after'));
  for (const a of after) { O.tasks.set(a.id, { ...(O.tasks.get(a.id) || {}), ...a }); links.append(taskCard(a.id)); }
  if (d.followers.length) {
    links.append(el('div', 'dr-check', 'Then'));
    for (const f of d.followers) { O.tasks.set(f.id, { ...(O.tasks.get(f.id) || {}), ...f }); links.append(taskCard(f.id)); }
  }
  c.append(links);
  return c;
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
  const sum = el('div', 'dr-summary', st.cls === 'limited' ? 'Waiting for the limit to reset' : st.label); // the Model row says which
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
  if (t.kind === 'work' && ['running', 'paused'].includes(t.status)) {
    const paused = t.status === 'paused', busy = TC.busy.has(t.id);
    const pr = el('button', `btn small${paused ? ' primary' : ''}`, busy ? (paused ? 'Resuming…' : 'Pausing…') : paused ? 'Resume' : 'Pause');
    pr.disabled = busy;
    pr.title = paused ? 'Continue the same session, on the same agent, in the same worktree' : 'Stop the agent now; its session and worktree are kept until you resume';
    pr.onclick = () => taskControl(t.id, paused ? 'resume' : 'pause').catch(() => {});
    row.append(pr);
    const ho = el('button', 'btn small', 'Hand off…');
    ho.disabled = busy;
    ho.title = 'Stop this session and continue in the same worktree on another agent or model';
    ho.onclick = () => openDelegate(t.id);
    row.append(ho);
  }
  if (canAddBreak(t)) {
    const rb = el('button', 'btn small', '+ Review break');
    rb.title = 'Stop after this task and wait for your review before anything that depends on it runs';
    rb.onclick = () => addReviewBreak(t.id);
    row.append(rb);
  }
  if (t.kind === 'review' && ['queued', 'awaiting_review'].includes(t.status)) {
    const rm = el('button', 'btn small danger', 'Remove break');
    rm.title = 'What waits for this review goes ahead without it';
    rm.onclick = () => orchAction('cancel');
    row.append(rm);
  } else if (isOpen || t.status === 'needs_integration' || t.status === 'paused') {
    const cancel = el('button', 'btn small danger', 'Cancel');
    cancel.onclick = () => { if (confirm(`Cancel #${t.id}? Tasks waiting on it are cancelled too.`)) orchAction('cancel'); };
    row.append(cancel);
  } else if (t.status === 'failed' || t.status === 'cancelled') {
    const retry = el('button', 'btn small primary', 'Retry');
    retry.onclick = () => orchAction('retry');
    row.append(retry);
  }
  if (t.status === 'awaiting_review') top.append(reviewPanel(t));
  if (row.children.length) top.append(row);
  if (O.err) top.append(el('div', 'dr-err', O.err));
  body.append(top);
  if (t.kind === 'review') { // a checkpoint has no model, instructions or output of its own
    const c = section('');
    c.append(el('div', 'muted', 'A review break never runs an agent. When the task before it finishes, it waits here: approve to continue the queue, or request changes to queue a fix first.'));
    body.append(c);
    const order = orderSection(d);
    if (order) body.append(order);
    body.scrollTop = keep;
    return;
  }

  // Model: the same text as the card's chip, the ordered fallbacks (current one marked) and every move.
  if (t.kind !== 'plan') body.append(modelSection(t));
  // A worker's steps for the latest run (runs.phases): where the time went, what it's doing now, what failed.
  const lastRun = d.runs.at(-1), tl = lastRun && timelineSection(lastRun, t.status === 'running' && !lastRun.outcome);
  if (tl) body.append(tl);

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
  else if (t.status === 'needs_integration' && d.task.result) s3.append(el('pre', 'dr-pre', d.task.result));
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
  // Every screenshot, oldest first, as a compact gallery (the drawer's .shots are small tiles; see app.css).
  const shots = d.runs.flatMap((r) => r.entries.filter((e) => e.k === 'image'));
  if (shots.length) s3.append(el('div', 'dr-shots-head', `Screenshots · ${shots.length}`), shotGrid(shots));
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
  const order = orderSection(d);
  if (order) more.append(order);
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
    const effort = effortLevels(run.agent).length ? ` · ${effortName(run.effort)} effort` : '';
    container.append(el('div', 'out-run', `${how} ${fmtClock(run.started_at)}${effort}${run.outcome ? ` · ${OUTCOME_TEXT[run.outcome] || run.outcome}` : ''}`));
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

// Consecutive tool calls fold into one muted line in Claude Code's words ("Read 4 files, ran a command ›"); open it for
// one row per call, and open a row for the exact command and what it printed.
const aOrN = (n, one, many = `${one}s`) => (n === 1 ? `a ${one}` : `${n} ${many}`);
const PAST = { run: 'ran', check: 'checked', list: 'listed', install: 'installed', show: 'showed', find: 'found', read: 'read', create: 'created',
  remove: 'removed', delete: 'deleted', start: 'started', stop: 'stopped', kill: 'killed', build: 'built', test: 'tested', fetch: 'fetched',
  search: 'searched', count: 'counted', print: 'printed', copy: 'copied', move: 'moved', verify: 'verified', update: 'updated', add: 'added',
  make: 'made', write: 'wrote', open: 'opened', view: 'viewed', inspect: 'inspected', compare: 'compared', wait: 'waited', restart: 'restarted',
  commit: 'committed', push: 'pushed', pull: 'pulled', clone: 'cloned', download: 'downloaded', generate: 'generated', apply: 'applied',
  measure: 'measured', take: 'took', capture: 'captured', load: 'loaded', save: 'saved', send: 'sent', fix: 'fixed', clean: 'cleaned',
  query: 'queried', confirm: 'confirmed', validate: 'validated', scan: 'scanned', get: 'got', look: 'looked', rerun: 'reran', lint: 'linted' };
function toolGroupSummary(items) {
  // One command with a description (Claude's Bash tool writes one) reads as that sentence, in the past tense.
  const d = items.length === 1 && items[0].e.name === 'Bash' && String(items[0].e.input?.description || '').trim();
  if (d) {
    const [w, ...rest] = d.split(' '), past = PAST[w.toLowerCase()];
    if (past) return [past[0].toUpperCase() + past.slice(1), ...rest].join(' ');
  }
  const kinds = new Map();
  const kindOf = (n) => ({ Bash: 'run', Read: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write', Grep: 'search', Glob: 'search',
    WebSearch: 'web', WebFetch: 'fetch', TodoWrite: 'plan', Task: 'agent', Agent: 'agent', Skill: 'skill' })[n] || 'tool';
  for (const { e } of items) { const k = kindOf(e.name); if (!kinds.has(k)) kinds.set(k, []); kinds.get(k).push(e); }
  const files = (es) => new Set(es.map((e) => e.input?.file_path || e.id)).size;
  const parts = [...kinds].map(([k, es]) => {
    const n = es.length;
    switch (k) {
      case 'run': return `ran ${aOrN(n, 'command')}`;
      case 'read': return `read ${aOrN(files(es), 'file')}`;
      case 'edit': return `edited ${aOrN(files(es), 'file')}`;
      case 'write': return `wrote ${aOrN(files(es), 'file')}`;
      case 'search': return n === 1 ? 'searched the code' : `ran ${n} searches`;
      case 'web': return n === 1 ? 'searched the web' : `ran ${n} web searches`;
      case 'fetch': return `fetched ${aOrN(n, 'page')}`;
      case 'plan': return 'updated the plan';
      case 'agent': return `ran ${aOrN(n, 'subagent')}`;
      case 'skill': return `used ${aOrN(n, 'skill')}`;
      default: return `used ${aOrN(n, 'tool')}`;
    }
  });
  const text = parts.join(', ');
  return text[0].toUpperCase() + text.slice(1);
}
function groupNode(group) {
  const box = el('div', 'out-tools');
  group.refresh = () => {
    const open = O.expanded.has(group.key);
    box.className = 'out-tools' + (open ? ' open' : '');
    box.textContent = '';
    const failed = group.items.filter((i) => i.res?.isError).length;
    const running = group.items.some((i) => !i.res);
    const head = el('button');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    head.append(el('span', 'n', toolGroupSummary(group.items)));
    if (failed) head.append(el('span', 'fail', `· ${failed} failed`));
    else if (running) head.append(el('span', 'live', '· running'));
    head.insertAdjacentHTML('beforeend', CHEVRON_SVG);
    head.onclick = () => { if (!O.expanded.delete(group.key)) O.expanded.add(group.key); group.refresh(); };
    box.append(head);
    if (!open) return;
    const list = el('div', 'out-calls');
    for (const { e, res } of group.items) {
      const key = `${group.key}:${e.id}`;
      const rowOpen = O.expanded.has(key);
      const row = el('div', 'out-row' + (res?.isError ? ' err' : '') + (rowOpen ? ' open' : ''));
      const rb = el('button');
      rb.type = 'button';
      rb.setAttribute('aria-expanded', String(rowOpen));
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
      list.append(row);
    }
    box.append(list);
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
function renderDelegate() {
  const body = $('dgBody'), d = DG.data;
  body.textContent = '';
  const t = O.tasks.get(DG.id) || d?.task;
  const handoff = !!t && t.status !== 'queued';
  $('dgTitle').textContent = `${handoff ? 'Hand off' : 'Delegate'} #${DG.id}`;
  $('dgSub').textContent = t ? displayTitle(t) : '';
  if (handoff) body.append(el('p', 'muted', 'Stops the current session. The new agent continues in the same worktree, with the work so far, the last messages and the git diff.'));
  if (DG.err) body.append(el('div', 'dr-err', DG.err));
  if (!d) { if (!DG.err) body.append(el('div', 'out-live', 'Loading…')); return; }
  const cur = el('div', 'dg-row current');
  const ch = el('div', 'dg-head');
  ch.append(el('span', 'dg-name', `Now: ${d.current.agent} · ${d.current.label || d.current.model || 'default model'}`), dgStatus(d.current));
  cur.append(ch);
  body.append(cur);
  if (!d.candidates.length) body.append(el('p', 'muted', 'No other signed-in agent or model to move it to.'));
  for (const r of d.candidates) {
    const row = el('button', `dg-row${r.status === 'available' ? '' : ' limited'}`);
    row.type = 'button';
    row.disabled = DG.busy;
    const h = el('div', 'dg-head');
    h.append(el('span', 'dg-name', `${r.agent} · ${r.label || r.model}`));
    h.append(dgStatus(r));
    row.append(h);
    row.onclick = () => pickDelegate(r);
    body.append(row);
  }
}
async function pickDelegate(r) {
  if (DG.busy) return;
  DG.busy = true;
  renderDelegate();
  try {
    const t = O.tasks.get(DG.id) || DG.data?.task;
    const res = t && t.status !== 'queued' ? await taskControl(DG.id, 'handoff', { agent: r.agent, model: r.model })
      : await api(`/api/orch/tasks/${DG.id}/delegate`, 'POST', { agent: r.agent, model: r.model });
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

// ----- the queue sheet: the project's running and queued tasks, queued ones in manual order. A queued card drags
// with Pointer Events (mouse: after a 5 px move; touch: a ~350 ms long-press, so a swipe still scrolls) or moves with
// Alt+↑/↓. Its queued dependents move with it as one block: POST /api/orch/tasks/:id/move, 409 if it would go ahead
// of a prerequisite (the UI also greys those slots out).
const Q = { press: null, drag: null, busy: false, lastFocus: null, noClick: false, timer: 0 };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const queuedTasks = () => [...O.tasks.values()].filter((t) => t.status === 'queued' && t.project_id === O.project?.id)
  .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.id - b.id);
// The queue as a tree: each task with a queued prerequisite sits right under the first one (siblings in queue order).
// Returns [{t, depth, parent}] in display order.
function queueTree(queued) {
  const ids = new Set(queued.map((t) => t.id)), kids = new Map(), out = [], seen = new Set();
  const parentOf = (t) => taskDeps(t).find((d) => d !== t.id && ids.has(d)) ?? null;
  for (const t of queued) {
    const p = parentOf(t);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(t);
  }
  const walk = (t, depth, parent) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push({ t, depth, parent });
    for (const k of kids.get(t.id) || []) walk(k, depth + 1, t.id);
  };
  for (const t of kids.get(null) || []) walk(t, 0, null);
  for (const t of queued) walk(t, 0, null); // a depends_on cycle: show what's left flat
  return out;
}
// toast(msg, {kind: 'info'|'success'|'warn'|'error', action: 'Undo', run, duration}): stacked, non-blocking notices in #toasts
// (bottom-right on desktop, top on phones). 4 s (6 s with an action) unless `duration`; hover/focus pauses, × or a sideways
// swipe dismisses, and only the newest TOAST_MAX stay up.
const TOAST_MAX = 3;
function toast(msg, { kind = 'info', action, run, duration } = {}) {
  const box = $('toasts');
  const t = el('div', `toast toast-${kind}`);
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  t.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  t.append(el('div', 'toast-msg', msg));
  let left = duration ?? (action ? 6000 : 4000), started = 0, timer = 0, closed = false;
  const holds = new Set();
  const close = (swiped) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    t.style.height = `${t.offsetHeight}px`;
    t.offsetHeight; // commit the height so it can collapse
    t.classList.add('toast-out');
    if (swiped) t.classList.add('toast-swiped');
    t.style.height = '0px';
    const done = () => t.remove();
    t.addEventListener('transitionend', (e) => { if (e.target === t && e.propertyName === 'height') done(); });
    setTimeout(done, 400);
  };
  const hold = (why, on) => {
    if (closed) return;
    const was = holds.size;
    on ? holds.add(why) : holds.delete(why);
    if (!was && holds.size) { clearTimeout(timer); left -= Date.now() - started; }
    else if (was && !holds.size) { started = Date.now(); timer = setTimeout(close, Math.max(left, 1500)); }
  };
  if (action) {
    const b = el('button', 'toast-act', action);
    b.type = 'button';
    b.addEventListener('click', () => { close(); run(); });
    t.append(b);
  }
  const x = el('button', 'toast-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', 'Dismiss');
  x.addEventListener('click', () => close());
  t.append(x);
  t.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') hold('hover', true); });
  t.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hold('hover', false); });
  t.addEventListener('focusin', () => hold('focus', true));
  t.addEventListener('focusout', (e) => { if (!t.contains(e.relatedTarget)) hold('focus', false); });
  let sw = null; // touch swipe: follow the finger sideways, dismiss past 64px
  t.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || e.target.closest('button')) return;
    sw = { id: e.pointerId, x: e.clientX, dx: 0 };
    hold('swipe', true);
  });
  t.addEventListener('pointermove', (e) => {
    if (sw?.id !== e.pointerId) return;
    sw.dx = e.clientX - sw.x;
    t.style.transform = `translateX(${sw.dx}px)`;
    t.style.opacity = String(Math.max(0.2, 1 - Math.abs(sw.dx) / 240));
  });
  const endSwipe = (e) => {
    if (sw?.id !== e.pointerId) return;
    const dx = sw.dx;
    sw = null;
    if (Math.abs(dx) > 64) { t.style.setProperty('--swipe', `${Math.sign(dx) * 120}%`); t.style.transform = ''; t.style.opacity = ''; return close(true); }
    t.style.transform = t.style.opacity = '';
    hold('swipe', false);
  };
  t.addEventListener('pointerup', endSwipe);
  t.addEventListener('pointercancel', endSwipe);
  t.close = close;
  box.style.setProperty('--toast-lift', `${toastLift()}px`);
  box.append(t);
  const live = [...box.children].filter((c) => !c.classList.contains('toast-out'));
  for (const old of live.slice(0, -TOAST_MAX)) old.close();
  started = Date.now();
  timer = setTimeout(close, left);
  return t;
}
// Desktop toasts sit 16px from the bottom-right corner, raised above the composer when its box reaches into that corner.
function toastLift() {
  if (matchMedia('(max-width: 600px)').matches) return 0;
  const c = document.querySelector('#composer .box');
  const r = c?.getBoundingClientRect();
  if (!r || !r.width || r.right < innerWidth - 16 - 360) return 0;
  return Math.max(0, innerHeight - r.top - 4);
}
// Projects with a running task: state lanes cover every project, loaded tasks cover the open one before a server restart.
function runningProjectIds() {
  const ids = new Set((O.state?.lanes || []).map((l) => l.project_id).filter(Boolean));
  for (const t of O.tasks.values()) if (t.status === 'running') ids.add(t.project_id);
  return ids;
}
let sidebarRunKey = '';
function syncSidebarRunning() {
  const key = [...runningProjectIds()].sort().join(',');
  if (key !== sidebarRunKey) { sidebarRunKey = key; renderConvoList(); }
}
function parallelInfo(t) {
  const deps = taskDeps(t);
  const integrates = t.integrates ? (Array.isArray(t.integrates) ? t.integrates : [t.integrates]) : deps.length > 1 ? deps : [];
  const parent = [...O.tasks.values()].find(p => p.project_id === t.project_id && taskDeps(p).length > 1 && taskDeps(p).includes(t.id));
  return { group: t.parallel_group || (parent ? `#${parent.id}` : integrates.length > 1 ? `#${t.id}` : ''), integrates };
}
function openQueue() {
  if ($('queueModal').hidden) Q.lastFocus = document.activeElement;
  $('queueModal').hidden = false;
  if (!MC.at) loadMachines().then(renderQueue); // which machines exist, for the running tasks' 'on <machine>'
  renderQueue();
  $('queueModal').querySelector('.q-card, [data-close].icon-btn').focus();
}
function closeQueue(refocus = true) {
  if (Q.drag) endDrag(false);
  $('queueModal').hidden = true;
  if (refocus) Q.lastFocus?.focus?.();
}
$('obQueue').addEventListener('click', openQueue);
$('queueModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeQueue(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('queueModal').hidden) return;
  e.stopImmediatePropagation();
  if (Q.drag) endDrag(false);
  else closeQueue();
}, true);
function scheduleQueue() { clearTimeout(Q.timer); Q.timer = setTimeout(renderQueue, 120); }
function renderQueue() {
  if ($('queueModal').hidden || Q.drag || Q.busy) return;
  const body = $('qBody');
  const focused = document.activeElement?.closest?.('#qBody .tcard')?.dataset.task; // keeps keyboard focus across re-renders
  body.textContent = '';
  const running = [...O.tasks.values()].filter((t) => t.status === 'running' && t.project_id === O.project?.id);
  const queued = queuedTasks();
  const reviews = [...O.tasks.values()].filter((t) => t.status === 'awaiting_review' && t.project_id === O.project?.id);
  if (reviews.length) {
    body.append(el('h3', 'dg-group', 'Waiting for your review'));
    const box = el('div', 'q-list q-review');
    for (const t of reviews) box.append(queueCard(t.id, false));
    body.append(box);
  }
  if (running.length) {
    body.append(el('h3', 'dg-group', 'Running'));
    const box = el('div', 'q-list');
    for (const t of running) box.append(queueCard(t.id, false));
    body.append(box);
  }
  const paused = [...O.tasks.values()].filter((t) => t.status === 'paused' && t.project_id === O.project?.id);
  if (paused.length) {
    body.append(el('h3', 'dg-group', 'Paused'));
    const box = el('div', 'q-list');
    for (const t of paused) box.append(queueCard(t.id, false));
    body.append(box);
  }
  body.append(el('h3', 'dg-group', `Up next · ${queued.length}`));
  if (!queued.length) body.append(el('p', 'muted', 'Nothing queued.'));
  const list = el('div', 'q-list');
  list.id = 'qList';
  for (const { t, depth, parent } of queueTree(queued)) {
    const b = queueCard(t.id, queued.length > 1);
    if (parent != null) {
      b.classList.add('q-child');
      b.dataset.parent = parent;
      b.style.marginLeft = `${Math.min(depth, 3) * 16}px`;
    }
    list.append(b);
  }
  body.append(list);
  qLines();
  if (focused) body.querySelector(`.tcard[data-task="${focused}"]`)?.focus({ preventScroll: true });
}
// Each dependent's connector reaches up to its parent card's bottom edge (titles wrap, so measure).
function qLines() {
  const list = $('qList');
  if (!list || $('queueModal').hidden) return;
  for (const c of list.querySelectorAll('.q-child')) {
    const p = list.querySelector(`.tcard[data-task="${c.dataset.parent}"]`);
    if (p) c.style.setProperty('--q-up', `${c.offsetTop - (p.offsetTop + p.offsetHeight)}px`);
  }
}
new ResizeObserver(() => { if (!Q.drag) qLines(); }).observe($('qBody'));
function queueCard(id, movable) {
  const b = taskCard(id);
  b.addEventListener('click', () => closeQueue(false)); // taskCard's own handler opens the drawer
  if (movable) {
    b.classList.add('q-card');
    b.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    b.insertAdjacentHTML('afterbegin', '<span class="q-grip" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14"><g fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g></svg></span>');
  }
  return b;
}
// 'after #N': jump to the prerequisite's card in the open queue, else open it in the drawer.
function showTask(id) {
  const card = !$('queueModal').hidden && $('qBody').querySelector(`.tcard[data-task="${id}"]`);
  if (!card) return openTask(id);
  card.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  card.classList.remove('q-flash');
  void card.offsetWidth;
  card.classList.add('q-flash');
}

// The block that moves with `id` (it plus its queued dependents, in list order), the rest, the block's current slot
// among the rest, and the first valid slot: every prerequisite outside the block must stay above it.
function qContext(id) {
  const cards = [...$('qList').querySelectorAll('.q-card')];
  const ids = new Set([id, ...(O.tasks.get(id)?.dependents || [])]);
  const block = cards.filter((c) => ids.has(Number(c.dataset.task)));
  const rest = cards.filter((c) => !ids.has(Number(c.dataset.task)));
  const lead = cards.findIndex((c) => Number(c.dataset.task) === id);
  const slot = rest.filter((c) => cards.indexOf(c) < lead).length;
  let minSlot = 0, blocker = null;
  const ups = new Set();
  for (const c of block) {
    for (const up of O.tasks.get(Number(c.dataset.task))?.prereqs || []) {
      const i = rest.findIndex((r) => Number(r.dataset.task) === up);
      if (i >= 0) ups.add(up);
      if (i >= 0 && i + 1 > minSlot) { minSlot = i + 1; blocker = up; }
    }
  }
  // Drop slots follow the tree: the block goes between its siblings' subtrees (same parent), never inside another.
  const parent = block[0]?.dataset.parent ?? null, under = (c, anc) => {
    for (let x = c; x; x = x.dataset.parent && rest.find((r) => r.dataset.task === x.dataset.parent)) if (x === anc) return true;
    return false;
  };
  const sibs = rest.filter((c) => (c.dataset.parent ?? null) === parent);
  const slots = sibs.map((c) => rest.indexOf(c));
  const last = sibs[sibs.length - 1];
  if (last) slots.push(rest.findLastIndex((c) => under(c, last)) + 1);
  if (!slots.includes(slot)) slots.push(slot);
  slots.sort((a, b) => a - b);
  return { cards, block, rest, slot, minSlot, blocker, ups, slots };
}
const nearestSlot = (slots, want) => slots.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
const qTops = () => new Map([...$('qBody').querySelectorAll('.tcard[data-task]')].map((c) => [c.dataset.task, c.getBoundingClientRect().top]));
// FLIP: cards slide from where they were (`before`: id → top) to where the re-render put them.
function qFlip(before) {
  if (reducedMotion.matches) return;
  const moves = [];
  for (const c of $('qBody').querySelectorAll('.tcard[data-task]')) {
    const b = before.get(c.dataset.task);
    const dy = b == null ? 0 : b - c.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) moves.push([c, dy]);
  }
  for (const [c, dy] of moves) { c.style.transition = 'none'; c.style.transform = `translateY(${dy}px)`; }
  void $('qBody').offsetHeight;
  for (const [c] of moves) {
    c.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1)';
    c.style.transform = '';
    c.addEventListener('transitionend', () => (c.style.transition = ''), { once: true });
  }
}
// Move `id`'s block to `slot` among the rest: reorder optimistically, then ask the server; on an error (409:
// a prerequisite) slide back and say why.
async function qMove(id, ctx, slot, before = qTops()) {
  const { rest } = ctx;
  const where = slot < rest.length ? { before: Number(rest[slot].dataset.task) } : { after: Number(rest[rest.length - 1].dataset.task) };
  const prev = queuedTasks().map((t) => [t.id, t.position]);
  const restIds = rest.map((c) => Number(c.dataset.task));
  const order = [...restIds.slice(0, slot), ...ctx.block.map((c) => Number(c.dataset.task)), ...restIds.slice(slot)];
  order.forEach((tid, i) => { const t = O.tasks.get(tid); if (t) t.position = i + 1; });
  const rerender = (tops) => {
    renderQueue();
    qFlip(tops);
    if (document.activeElement?.dataset?.task === String(id)) document.activeElement.scrollIntoView({ block: 'nearest' });
  };
  rerender(before);
  Q.busy = true;
  try {
    const r = await api(`/api/orch/tasks/${id}/move`, 'POST', where);
    for (const p of r.order || []) { const t = O.tasks.get(p.id); if (t) t.position = p.position; }
    Q.busy = false;
    rerender(qTops());
  } catch (e) {
    for (const [tid, pos] of prev) { const t = O.tasks.get(tid); if (t) t.position = pos; }
    Q.busy = false;
    rerender(qTops());
    toast(e.message, { kind: 'error' });
  }
}

function qPointerDown(e) {
  const card = e.target.closest('.q-card');
  if (!card || Q.busy || Q.drag || Q.press || (e.pointerType === 'mouse' && e.button !== 0) || e.target.closest('.tc-after')) return;
  const p = { card, id: Number(card.dataset.task), x: e.clientX, y: e.clientY, pid: e.pointerId, touch: e.pointerType !== 'mouse', timer: 0 };
  Q.press = p;
  if (p.touch) {
    card.classList.add('q-pressing');
    p.timer = setTimeout(() => { if (Q.press === p) startDrag(p); }, 350);
  }
}
function cancelPress() {
  if (!Q.press) return;
  clearTimeout(Q.press.timer);
  Q.press.card.classList.remove('q-pressing');
  Q.press = null;
}
function startDrag(p) {
  clearTimeout(p.timer);
  p.card.classList.remove('q-pressing');
  const ctx = qContext(p.id);
  if (!ctx.rest.length) { cancelPress(); return toast(`#${p.id}'s dependents move with it, so there's nothing to reorder it against`, { kind: 'warn' }); }
  if (ctx.slots.length < 2) { cancelPress(); return toast(`#${p.id} has no sibling to reorder against: it stays under #${ctx.block[0].dataset.parent}`, { kind: 'warn' }); }
  navigator.vibrate?.(10);
  const list = $('qList'), rect = p.card.getBoundingClientRect(), before = qTops();
  const ghost = el('div', 'q-ghost');
  const stack = el('div', `q-stack${ctx.block.length > 1 ? ' stacked' : ''}`);
  const face = p.card.cloneNode(true);
  face.classList.remove('active', 'q-pressing');
  face.removeAttribute('data-task');
  stack.append(face);
  const meta = el('div', 'q-meta');
  if (ctx.block.length > 1) meta.append(el('span', 'q-more', `+${ctx.block.length - 1} dependent${ctx.block.length > 2 ? 's' : ''}`));
  const hint = el('span', 'q-hint');
  meta.append(hint);
  ghost.append(stack, meta);
  ghost.style.width = `${rect.width}px`;
  document.body.append(ghost);
  const d = Q.drag = { ...p, ...ctx, list, ghost, hint, x: p.x, y: p.y, left: rect.left, offY: p.y - rect.top, h: rect.height,
    gap: rect.height + (parseFloat(getComputedStyle(list).rowGap) || 0), raf: 0 };
  for (const c of d.block) c.classList.add('q-hide');
  list.classList.add('dragging');
  list.style.paddingBottom = `${d.gap}px`;
  const listTop = list.getBoundingClientRect().top;
  d.geo = d.rest.map((c) => ({ top: c.offsetTop, h: c.offsetHeight }));
  d.rest.forEach((c, k) => {
    c.classList.toggle('q-nodrop', k < d.minSlot);
    c.classList.toggle('q-prereq', d.ups.has(Number(c.dataset.task)));
    if (reducedMotion.matches) return;
    c.style.transition = 'none';
    c.style.transform = `translateY(${before.get(c.dataset.task) - (listTop + c.offsetTop)}px)`;
  });
  void list.offsetHeight;
  qShift(d);
  dragMove();
  const scroll = () => {
    if (Q.drag !== d) return;
    const r = $('qBody').getBoundingClientRect(), edge = Math.min(64, r.height / 4);
    const v = d.y < r.top + edge ? -(r.top + edge - d.y) / edge : d.y > r.bottom - edge ? (d.y - (r.bottom - edge)) / edge : 0;
    if (v) { $('qBody').scrollTop += Math.max(-1, Math.min(1, v)) * 14; dragMove(); }
    d.raf = requestAnimationFrame(scroll);
  };
  d.raf = requestAnimationFrame(scroll);
}
function qShift(d) {
  d.rest.forEach((c, k) => {
    c.style.transition = '';
    c.style.transform = k >= d.slot ? `translateY(${d.gap}px)` : '';
  });
}
function dragMove() {
  const d = Q.drag;
  if (!d) return;
  d.ghost.style.transform = `translate3d(${d.left}px, ${d.y - d.offY}px, 0)`; // keeps its indent: it only moves among its siblings
  const gy = d.y - d.offY + d.h / 2 - d.list.getBoundingClientRect().top;
  const slot = nearestSlot(d.slots, d.geo.filter((g, k) => g.top + g.h / 2 + (k >= d.slot ? d.gap : 0) < gy).length);
  if (slot !== d.slot) { d.slot = slot; qShift(d); }
  const bad = d.slot < d.minSlot;
  d.ghost.classList.toggle('invalid', bad);
  d.hint.textContent = bad ? `Needs #${d.blocker} first` : '';
}
function endDrag(drop) {
  const d = Q.drag;
  Q.drag = null;
  Q.press = null;
  cancelAnimationFrame(d.raf);
  Q.noClick = true;
  setTimeout(() => (Q.noClick = false), 80);
  const tops = qTops(), g = d.ghost.getBoundingClientRect().top;
  d.block.forEach((c, j) => tops.set(c.dataset.task, g + j * 6));
  d.ghost.remove();
  d.list.classList.remove('dragging');
  const ctx = qContext(d.id); // the list's order is unchanged until the move applies
  if (drop && d.slot >= d.minSlot && d.slot !== ctx.slot) return qMove(d.id, ctx, d.slot, tops);
  if (drop && d.slot < d.minSlot) toast(`#${d.id} can't go above #${d.blocker}: it needs #${d.blocker} first`, { kind: 'warn' });
  renderQueue();
  qFlip(tops);
}
$('qBody').addEventListener('pointerdown', qPointerDown);
addEventListener('pointermove', (e) => {
  const p = Q.press;
  if (!p || e.pointerId !== p.pid) return;
  if (Q.drag) { Q.drag.x = e.clientX; Q.drag.y = e.clientY; return dragMove(); }
  const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y);
  if (p.touch) { if (dist > 8) cancelPress(); } // a swipe: let it scroll
  else if (dist > 5) startDrag(p);
});
addEventListener('pointerup', (e) => { if (Q.press?.pid === e.pointerId) (Q.drag ? endDrag(true) : cancelPress()); });
addEventListener('pointercancel', (e) => { if (Q.press?.pid === e.pointerId) (Q.drag ? endDrag(false) : cancelPress()); });
// Once a long-press picked a card up, the finger drags it instead of scrolling the sheet (iOS needs this non-passive).
document.addEventListener('touchmove', (e) => { if (Q.drag) e.preventDefault(); }, { passive: false });
$('qBody').addEventListener('contextmenu', (e) => { if (Q.press || Q.drag) e.preventDefault(); });
$('qBody').addEventListener('click', (e) => { if (Q.noClick) { e.stopPropagation(); e.preventDefault(); } }, true);
$('qBody').addEventListener('keydown', (e) => {
  const card = e.target.closest?.('.q-card');
  if (!card || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  if (Q.busy || Q.drag) return;
  const id = Number(card.dataset.task), ctx = qContext(id);
  const slot = ctx.slots[ctx.slots.indexOf(ctx.slot) + (e.key === 'ArrowUp' ? -1 : 1)];
  if (slot == null) return;
  if (slot < ctx.minSlot) return toast(`#${id} needs #${ctx.blocker} first`, { kind: 'warn' });
  qMove(id, ctx, slot);
});

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
  // Claude, shared with the worker machines (agent-share.mjs): the Claude mark over a small laptop.
  'claude-machines': '<path d="M12 3v9M7.5 7.5h9M8.8 4.3l6.4 6.4M15.2 4.3l-6.4 6.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5 15.5h14v3.5H5zM3 21h18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>',
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
  if (CONN.node !== 'controller') {
    const node = CONN.node;
    try { applyRemote(node, (await api(`/api/connections?node=${encodeURIComponent(node)}`)).connections); } catch {}
  }
}
// Per-machine keys for drafts, sent codes and dismissed panels; `?node=` on every call about a worker's rows.
const ck = (c) => `${c.node || 'controller'}:${c.id}`;
const nodeQ = (c) => (c.node ? `?node=${encodeURIComponent(c.node)}` : '');
const connRows = () => (CONN.node === 'controller' ? CONN.list : CONN.remote);
function applyRemote(node, list) {
  if (node !== CONN.node) return;
  const prev = new Map(CONN.remote.map((c) => [c.id, c]));
  CONN.remote = list || [];
  for (const c of CONN.remote) {
    if (prev.get(c.id)?.login?.state === 'waiting' && c.login?.state === 'done') {
      CONN.justDone[ck(c)] = true;
      setTimeout(() => { delete CONN.justDone[ck(c)]; renderConnections(true); }, 6000);
    }
  }
  renderConnections();
}
// The machine switcher (Controller / each worker), shown once a worker is paired.
async function loadConnNodes() {
  try { CONN.nodes = (await api('/api/cluster/nodes')).nodes || []; } catch { CONN.nodes = []; }
  if (!CONN.nodes.some((n) => n.id === CONN.node)) { CONN.node = 'controller'; CONN.remote = []; }
  renderConnNodes();
  if (CONN.node !== 'controller') refreshConnections();
}
function renderConnNodes() {
  const box = $('connsMachines'), workers = CONN.nodes.filter((n) => !n.local);
  box.hidden = !workers.length;
  box.replaceChildren(...[{ id: 'controller', name: 'Controller', connected: true }, ...workers].map((n) => {
    const b = el('button', '', '');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(n.id === CONN.node));
    b.dataset.node = n.id;
    b.title = n.id === 'controller' ? 'This server' : n.connected ? `${n.name} · online` : `${n.name} · ${n.awayLabel || 'offline'}`;
    b.append(el('span', `dot ${n.connected ? 'on' : 'off'}`), el('span', '', n.name));
    b.onclick = () => selectConnNode(n.id);
    return b;
  }));
}
function selectConnNode(id) {
  if (id === CONN.node) return;
  CONN.node = id;
  CONN.remote = [];
  renderConnNodes();
  renderConnections(true);
  refreshConnections();
}
function applyConnections(list) {
  const prev = new Map(CONN.list.map((c) => [c.id, c]));
  CONN.list = list || [];
  let agentsChanged = false;
  for (const c of CONN.list) {
    const p = prev.get(c.id);
    if (p?.login?.state === 'waiting' && c.login?.state === 'done') {
      CONN.justDone[ck(c)] = true;
      setTimeout(() => { delete CONN.justDone[ck(c)]; renderConnections(true); }, 6000);
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
  const node = CONN.node !== 'controller' && CONN.nodes.find((n) => n.id === CONN.node);
  if (node) return app.append(connNodeRow(node));
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
// A worker's header row: its name, whether it is connected, and its OS.
function connNodeRow(n) {
  const main = el('div', 'cn-main'), info = el('div', 'cn-info'), st = el('span', 'cn-status');
  info.append(el('span', 'cn-label', n.name));
  const os = n.os === 'darwin' ? 'macOS' : n.os === 'linux' ? 'Linux' : n.os || '';
  st.append(el('span', `dot ${n.connected ? 'on' : 'off'}`), el('span', 'cn-st', [n.connected ? NODE_ST[n.status] || 'Online' : cap(n.awayLabel || 'offline'), os].filter(Boolean).join(' · ')));
  info.append(st);
  const icon = el('span');
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 20h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  main.append(icon.firstChild, info);
  return main;
}
// The footer, the model picker's "sign in" option and routing hints open this window (optionally at one agent).
function openConnections(id) {
  closeSidebar();
  if ($('connsModal').hidden) CONN.lastFocus = document.activeElement;
  $('connsModal').hidden = false;
  renderConnFoot();
  if (!$('connsRefresh').disabled) $('connsChecked').textContent = 'Models refresh once a day and after a sign-in; limits from the usage card.';
  if (id) { CONN.node = 'controller'; CONN.remote = []; }
  renderConnNodes();
  renderConnections(true);
  refreshConnections();
  loadConnNodes();
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
    const r = await api(`/api/connections/${c.id}/${action}${nodeQ(c)}`, 'POST', body);
    if ('login' in r) { c.login = r.login; renderConnections(true); }
    return r;
  } catch (e) { alert(`${c.label}: ${e.message}`); return null; }
}
async function connStart(c) {
  delete CONN.sent[ck(c)];
  delete CONN.drafts[ck(c)];
  await connAction(c, 'start');
}
async function connLogout(c) {
  const where = c.node ? CONN.nodes.find((n) => n.id === c.node)?.name || 'that machine' : 'this server';
  const ask = c.ui?.disconnect ? `${c.ui.disconnect}: ${c.label}?` : `Sign out of ${c.label} on ${where}?`;
  if (!confirm(c.logoutWarning ? `${ask}\n\n${c.logoutWarning}` : ask)) return;
  await connAction(c, 'logout', c.logoutWarning ? { confirm: true } : {});
}
// An agent CLI whose limits can't be read at all (health.limits.exposed false; see .agent-orch/AGENTS.md).
const limitsHidden = (id) => CONN.list.find((c) => c.id === id)?.health?.limits?.exposed === false;
// A row's compact health (health.mjs): version, models, limit windows, when they were last read, and what's wrong.
function connHealth(c) {
  const h = c.health;
  if (!h || !c.installed) return null;
  const parts = [h.version ? `v${h.version}` : ''];
  if (h.signedIn) {
    const ms = h.models, L = h.limits;
    const one = ms.count === 1 && AGENT_LIST.find((a) => a.id === c.id)?.models.find((m) => m.id === ms.ids[0]);
    parts.push(one ? one.label || one.id : `${ms.count} model${ms.count === 1 ? '' : 's'}`);
    parts.push(!L.exposed ? 'limits not exposed by CLI'
      : L.windows.length ? [...L.windows].sort((a, b) => byWin(a.window, b.window)).map((w) => `${winLabel(w.window)} ${Math.round(w.pct)}%`).join(', ')
      : L.error ? '' : 'no limit reading yet');
    const at = Math.max(ms.at || 0, L.at || 0);
    if (at) parts.push(`read ${fmtWhen(at)}`);
    if (L.error) parts.push(`limit check failed: ${L.error}`);
    parts.push(...h.problems);
  }
  return { text: parts.filter(Boolean).join(' · '), bad: h.problems.length > 0 || !!h.limits.error, title: h.errors.join('\n') };
}
async function refreshHealth() {
  const b = $('connsRefresh');
  b.disabled = true; b.textContent = 'Checking…';
  blurSwap($('connsChecked'), 'Checking sign-ins…');
  try {
    if (CONN.node !== 'controller') {
      const node = CONN.node, r = await api(`/api/connections/refresh?node=${encodeURIComponent(node)}`, 'POST');
      applyRemote(node, r.connections);
      blurSwap($('connsChecked'), `Asked ${CONN.nodes.find((n) => n.id === node)?.name || 'the machine'} to re-check ${fmtWhen(Date.now())}`);
      return;
    }
    const r = await api('/api/connections/refresh', 'POST');
    AGENT_LIST = (await api('/api/agents')).agents || AGENT_LIST;
    renderAgentPicker();
    applyConnections(r.connections);
    loadSidebarUsage();
    blurSwap($('connsChecked'), `Checked ${fmtWhen(Date.now())}`);
  } catch (e) { blurSwap($('connsChecked'), `Refresh failed: ${e.message}`); }
  finally { b.disabled = false; b.textContent = 'Refresh'; renderConnections(true); }
}
$('connsRefresh').addEventListener('click', refreshHealth);
function connStatus(c) {
  if (!c.installed) return ['', 'Not installed'];
  if (c.signedIn) return ['on', c.ui?.on || (c.account ? `Connected as ${c.account}` : 'Connected')];
  if (c.login?.state === 'waiting') return ['wait', 'Signing in…'];
  return ['warn', c.ui?.off || 'Not signed in'];
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
    close.onclick = () => { CONN.dismissed[ck(c)] = l.startedAt; renderConnections(true); };
    acts.append(again, close);
    box.append(acts);
    return box;
  }
  let n = 0;
  const step = (text) => el('div', 'cn-step', `${++n}. ${text}`);
  if (l.prompt) {
    box.classList.add('cn-prompt');
    box.append(step('The CLI is asking:'), el('pre', 'cn-prompt-text', l.prompt));
    const cancel = el('button', 'link-btn', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => connAction(c, 'cancel');
    const acts = el('div', 'cn-acts'); acts.append(cancel); box.append(acts);
    return box;
  }
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
    inp.dataset.connInput = ck(c);
    inp.value = CONN.drafts[ck(c)] || '';
    inp.oninput = () => { CONN.drafts[ck(c)] = inp.value; };
    const go = el('button', 'btn small primary', 'Submit');
    f.append(inp, go);
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!inp.value.trim()) return inp.focus();
      go.disabled = true;
      if (await connAction(c, 'code', { code: inp.value.trim() })) { CONN.sent[ck(c)] = true; CONN.drafts[ck(c)] = ''; }
      renderConnections(true);
    };
    box.append(f);
    if (CONN.sent[ck(c)]) box.append(el('div', 'cn-step muted', 'Code sent, checking…'));
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
  const list = connRows();
  const sig = JSON.stringify([CONN.node, list, CONN.nodes, CONN.justDone, CONN.dismissed, CONN.sent]);
  if (!force && sig === CONN.sig) return;
  CONN.sig = sig;
  const box = $('connsList'), focused = document.activeElement?.dataset?.connInput;
  box.textContent = '';
  renderConnFoot();
  const node = CONN.node !== 'controller' && CONN.nodes.find((n) => n.id === CONN.node);
  if (node && !list.length) box.append(el('div', 'cn-empty', node.connected ? `Waiting for ${node.name} to report its agents…` : `${node.name} is offline. Its agents show here once it reconnects.`));
  for (const c of list) {
    const row = el('div', 'cn-row');
    row.dataset.conn = c.id;
    const [dot, text] = connStatus(c);
    const main = el('div', 'cn-main');
    const info = el('div', 'cn-info');
    info.append(el('span', 'cn-label', c.label));
    const st = el('span', 'cn-status');
    st.append(el('span', `dot ${dot}`), el('span', 'cn-st', CONN.justDone[ck(c)] && c.signedIn ? `✓ ${text}` : text));
    st.title = text;
    info.append(st);
    main.append(connIcon(c.id), info);
    const waiting = c.login?.state === 'waiting';
    if (c.installed && c.signedIn && c.canLogout && !waiting) {
      const b = el('button', 'btn small cn-btn', c.ui?.disconnect || 'Disconnect');
      b.type = 'button';
      b.onclick = () => connLogout(c);
      main.append(b);
    } else if (c.installed && !c.signedIn && c.canLogin && !waiting) {
      const b = el('button', 'btn small primary cn-btn', c.ui?.connect || 'Connect');
      b.type = 'button';
      b.onclick = () => connStart(c);
      main.append(b);
    }
    row.append(main);
    const hl = connHealth(c);
    if (hl?.text) {
      const hd = el('div', `cn-health${hl.bad ? ' bad' : ''}`, hl.text);
      hd.title = hl.title || hl.text;
      row.append(hd);
    }
    // One subscription signed in on several machines = one set of limits (more machines add CPU/RAM, not quota).
    if (c.sharedWith?.length) {
      const sh = el('div', 'cn-shared', `Same account as ${c.sharedWith.join(', ')}: shares limits`);
      sh.title = 'These machines run on one subscription, so their usage counts against the same plan limits.';
      row.append(sh);
    }
    const l = c.login;
    if (l && (l.state === 'waiting' || (l.state === 'failed' && !c.signedIn && CONN.dismissed[ck(c)] !== l.startedAt))) row.append(connPanel(c));
    box.append(row);
  }
  if (focused) box.querySelector(`[data-conn-input="${focused}"]`)?.focus();
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
      const tx = el('div', 'tx');
      const tt = el('span', 'tt', t.title);
      tt.title = t.title;
      tx.append(tt);
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
  if (state.cid) splash.need.add('history'); // the open chat's messages are part of the first screen
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
