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

// ---------- view toggle (Vibecode chat / Files / Terminal / Browser) ----------
function setView(view) {
  if (!['term', 'files', 'browser'].includes(view)) view = 'chat';
  $('app').dataset.view = view;
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  document.querySelectorAll('#viewMenu [data-view]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.view === view)));
  $('topAction').hidden = view !== 'chat';
  $('chatView').hidden = view !== 'chat';
  $('filesView').hidden = view !== 'files';
  $('termView').hidden = view !== 'term';
  $('browserView').hidden = view !== 'browser';
  $('title').textContent = view === 'term' ? 'Terminal' : view === 'browser' ? 'Browser' : currentTitle();
  $('cwdLabel').textContent = view === 'term' ? '~/workspace · bash' : view === 'browser' ? '' : currentCwdLabel();
  if (view === 'browser') window.bxShow?.(); // public/browser.js
  else window.bxHide?.();
  if (view === 'term') openTerminals();
  else if (view === 'files') window.FilesView?.show(); // public/files.js
  else if (view === 'chat') $('input').focus({ preventScroll: true });
  store.set('cw.view', view);
}
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

// Phone header (<768px, HIG navigation bar): the sidebar button, the title (its chevron opens #viewMenu: the views that
// .seg shows on wider screens, then the overflow, i.e. the repo link) and one action for the view (#topAction).
const phoneHeader = matchMedia('(max-width: 767px)');
function syncPhoneHeader() {
  $('viewBtn').disabled = !phoneHeader.matches;
  if (!phoneHeader.matches) closeViewMenu();
}
phoneHeader.addEventListener('change', syncPhoneHeader);
syncPhoneHeader();
function openViewMenu() {
  const m = $('viewMenu'), repo = $('repoLink'), item = $('viewMenuRepo'), pv = $('previewLink'), pvItem = $('viewMenuPreview');
  $('viewMenuMore').hidden = repo.hidden && pv.hidden;
  item.hidden = repo.hidden;
  if (!repo.hidden) {
    item.replaceChildren(repo.querySelector('svg').cloneNode(true), $('repoText').textContent);
    item.classList.toggle('warn', repo.classList.contains('warn'));
  }
  pvItem.hidden = pv.hidden;
  if (!pv.hidden) pvItem.replaceChildren(...[...pv.childNodes].map((n) => n.cloneNode(true)));
  m.hidden = false;
  $('viewBtn').setAttribute('aria-expanded', 'true');
  const r = $('viewBtn').getBoundingClientRect();
  m.style.top = `${r.bottom + 6}px`;
  m.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - m.offsetWidth / 2, innerWidth - m.offsetWidth - 8))}px`;
  (m.querySelector('[aria-checked="true"]') || m.querySelector('button')).focus({ preventScroll: true });
}
function closeViewMenu(refocus) {
  if ($('viewMenu').hidden) return;
  $('viewMenu').hidden = true;
  $('viewBtn').setAttribute('aria-expanded', 'false');
  if (refocus) $('viewBtn').focus({ preventScroll: true });
}
$('viewBtn').addEventListener('click', () => ($('viewMenu').hidden ? openViewMenu() : closeViewMenu()));
$('viewMenu').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  closeViewMenu();
  if (b.dataset.view) setView(b.dataset.view);
  else if (b.id === 'viewMenuRepo') $('repoLink').click();
  else if (b.id === 'viewMenuPreview') $('previewLink').click();
});
$('viewMenu').addEventListener('keydown', (e) => {
  const items = [...$('viewMenu').querySelectorAll('button')].filter((b) => b.offsetParent);
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeViewMenu(true); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
  else if (e.key === 'Tab') closeViewMenu();
});
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#viewMenu, #viewBtn')) closeViewMenu(); });
$('topAction').addEventListener('click', () => $('newChat').click());
$('bannerTerm').addEventListener('click', () => setView('term'));
$('updateRestart').addEventListener('click', async () => {
  $('updateRestart').disabled = true;
  try { upd.update = (await api('/api/restart-now', 'POST')).update || upd.update; } catch (e) { $('updateRestart').disabled = false; toast(e.message, { kind: 'error' }); }
  renderUpdateBanner();
});
$('updateCancel').addEventListener('click', async () => {
  $('updateCancel').disabled = true;
  try { applyUpdateStatus(await api('/api/restart/cancel', 'POST')); } catch (e) { $('updateCancel').disabled = false; toast(e.message, { kind: 'error' }); }
});
$('updateReload').addEventListener('click', () => location.reload());
$('updateDismiss').addEventListener('click', () => {
  upd.dismissed = upd.commits; store.set('cw.updDismissed', String(upd.commits));
  upd.publicBase = upd.publicLatest; upd.reload = false; // until public/ changes again
  renderUpdateBanner();
});

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
// In the Connections window's 'agent-orch account' row: signs this browser out of agent-orch (not an agent CLI).
$('logout').addEventListener('click', async () => {
  if (!confirm('Sign out of agent-orch on this device?')) return;
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});

function relTime(ts, now = Date.now()) {
  const s = (now - ts) / 1000;
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
const rankedConvos = () => state.convos.filter((c) => c.project && !c.archived)
  .sort((a, b) => (a.project.position ?? Infinity) - (b.project.position ?? Infinity) || a.project.id - b.project.id || b.updatedAt - a.updatedAt);
const rankedProjectIds = (convos = rankedConvos()) => [...new Set(convos.map((c) => c.project.id))];
// A project folder can have several chats: its main chat (mainId === id) holds the project's place in the list and
// the folder's other chats sit indented under it, newest first.
const isSubChat = (c) => !!c.mainId && c.mainId !== c.id && state.convos.some((x) => x.id === c.mainId);
const subChats = (c) => state.convos.filter((x) => x.mainId === c.id && x.id !== c.id).sort((a, b) => b.updatedAt - a.updatedAt);
const familyUpdated = (c) => Math.max(c.updatedAt, ...subChats(c).map((x) => x.updatedAt));

// Chat search: typing (debounced) asks GET /api/convos?q= (search.mjs) and #convoList shows the matches in place of
// the list until the field is cleared or Escape. `seq` drops answers to queries the owner has already typed past.
const chatSearch = { q: '', results: null, timer: 0, seq: 0 };
$('chatSearch').addEventListener('input', () => {
  clearTimeout(chatSearch.timer);
  const q = $('chatSearch').value.trim();
  if (q.length < 2) { // search.mjs needs 2 characters; until then the normal list
    chatSearch.seq++;
    if (chatSearch.results) { Object.assign(chatSearch, { q: '', results: null }); renderConvoList(); }
    return;
  }
  chatSearch.timer = setTimeout(() => runChatSearch(q), 250);
});
$('chatSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !$('chatSearch').value) return;
  e.preventDefault(); e.stopPropagation();
  $('chatSearch').value = '';
  $('chatSearch').dispatchEvent(new Event('input'));
});
async function runChatSearch(q) {
  const seq = ++chatSearch.seq;
  let results;
  try { results = await api(`/api/convos?q=${encodeURIComponent(q)}`); } catch (e) {
    if (seq === chatSearch.seq) toast(`Search failed: ${e.message}`, { kind: 'error' });
    return;
  }
  if (seq !== chatSearch.seq) return;
  Object.assign(chatSearch, { q, results });
  renderConvoList();
}
// `text` into `node` with every query term wrapped in <mark> (text nodes only, so nothing is parsed as HTML).
function markTerms(node, text, q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean), low = text.toLowerCase();
  let i = 0;
  for (;;) {
    let at = -1, len = 0;
    for (const t of terms) {
      const j = low.indexOf(t, i);
      if (j >= 0 && (at < 0 || j < at || (j === at && t.length > len))) { at = j; len = t.length; }
    }
    if (at < 0) break;
    if (at > i) node.append(text.slice(i, at));
    node.append(el('mark', null, text.slice(at, at + len)));
    i = at + len;
  }
  if (i < text.length) node.append(text.slice(i));
  return node;
}
function renderChatSearch(nav) {
  nav.textContent = '';
  if (!chatSearch.results.length) {
    const p = el('p', 'group-label', 'No chats match');
    p.style.textTransform = 'none';
    nav.append(p);
    return;
  }
  for (const r of chatSearch.results) {
    const c = state.convos.find((x) => x.id === r.id);
    const b = el('div', 'convo search-hit' + (r.id === state.cid ? ' active' : ''));
    b.tabIndex = 0;
    b.setAttribute('role', 'button');
    b.dataset.cid = r.id;
    b.append(markTerms(el('span', 'ct'), r.title || (c ? folderName(c.cwd) : 'Chat'), chatSearch.q));
    if (r.hits[0]) b.append(markTerms(el('span', 'cs'), r.hits[0].snippet, chatSearch.q));
    b.append(el('span', 'cm', relTime(r.at || c?.updatedAt || Date.now())));
    const open = () => { openConvo(r.id); closeSidebar(); setView('chat'); };
    b.addEventListener('click', open);
    b.addEventListener('keydown', (e) => { if (e.target === b && e.key === 'Enter') open(); });
    nav.append(b);
  }
}

let archFoldedFor = null; // the archived chat that was open when the owner folded Archived
function renderConvoList() {
  if (drag.active) { drag.stale = true; return; } // re-rendering would pull the lifted card out from under the pointer
  const nav = $('convoList');
  if (chatSearch.results) return renderChatSearch(nav);
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
    const label = el('div', 'group-label rank-label', 'Priority order');
    label.append(el('span', 'rank-hint', 'Drag to set priority'));
    label.title = 'Drag projects to set priority (Alt+↑/↓ with the keyboard): the top one runs first';
    nav.append(label);
    for (const c of ranked) { nav.append(convoItem(c, true)); for (const s of subChats(c)) nav.append(convoItem(s, false, true)); }
  }
  // The rest, newest activity first, with no label (no date groups either: owner, 2026-10-04) and no gap (owner, 2026-10-06).
  const sorted = state.convos.filter((c) => !c.project && !c.archived && !isSubChat(c)).sort((a, b) => familyUpdated(b) - familyUpdated(a));
  for (const c of sorted) { nav.append(convoItem(c, false)); for (const s of subChats(c)) nav.append(convoItem(s, false, true)); }
  // Archived projects (finished ones; the whole folder, all its chats): folded into one row at the bottom, opened while
  // the open chat is one of them, unless the owner folded it again with that chat open (`archFoldedFor`).
  const archived = state.convos.filter((c) => c.archived && !isSubChat(c)).sort((a, b) => familyUpdated(b) - familyUpdated(a));
  if (archived.length) {
    const open = store.get('cw.archivedOpen') === '1' || (!!currentConvo()?.archived && archFoldedFor !== state.cid);
    const t = el('button', 'group-label arch-toggle');
    t.type = 'button';
    t.setAttribute('aria-expanded', String(open));
    t.append(el('span', '', `Archived · ${archived.length}`), el('span', 'caret', '›'));
    t.onclick = () => {
      store.set('cw.archivedOpen', open ? '0' : '1');
      archFoldedFor = open ? state.cid : null;
      renderConvoList();
      const nt = nav.querySelector('.arch-toggle');
      nt?.focus({ preventScroll: true });
      if (!open) nt?.scrollIntoView({ block: 'start', behavior: 'smooth' }); // opened: bring its projects into view
    };
    nav.append(t);
    if (open) for (const c of archived) { nav.append(convoItem(c, false)); for (const s of subChats(c)) nav.append(convoItem(s, false, true)); }
  }
  if (focused) nav.querySelector(`.convo[data-cid="${CSS.escape(focused)}"]`)?.focus();
}

function convoItem(c, rankable, sub = false) {
  const b = el('div', 'convo' + (sub ? ' sub' : '') + (c.id === state.cid ? ' active' : ''));
  b.tabIndex = 0;
  b.setAttribute('role', 'button');
  b.dataset.cid = c.id;
  // One compact row: the busy / tasks-running dot, the title, then "not pushed" when a push failed. Mode and last
  // activity go in the tooltip.
  b.title = `${tilde(c.cwd)} · ${c.mode === 'orchestrator' ? 'Orchestrator' : 'Chat'} · ${relTime(c.updatedAt)}`;
  if (c.busy) b.append(el('span', 'busy-dot'));
  else if (c.project && runningProjectIds().has(c.project.id)) {
    const dot = el('span', 'run-dot'); dot.title = 'Tasks running'; dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', 'Tasks running');
    b.append(dot);
  }
  b.append(el('span', 'ct', c.title || folderName(c.cwd)));
  if (c.git?.error) b.append(el('span', 'cm', 'not pushed'));
  const more = el('button', 'more');
  more.setAttribute('aria-label', sub ? 'Chat options' : 'Project options');
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
    const r = (c.project && byId.get(c.project.id)) || (!isSubChat(c) && byPath.get(c.cwd));
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
  document.querySelector('.menu.convo-menu')?.remove(); // never the header's View menu (also .menu)
  const m = el('div', 'menu convo-menu');
  const sub = isSubChat(c), others = state.convos.filter((x) => x.cwd === c.cwd && x.id !== c.id).length;
  const fresh = el('button', '', 'New chat in this project');
  const rename = el('button', '', 'Rename');
  const merge = el('button', '', sub ? 'Merge into the main chat' : `Merge ${others === 1 ? 'its other chat' : `its ${others} other chats`} into this one`);
  const archive = el('button', '', c.archived ? 'Unarchive project' : 'Archive project');
  const del = el('button', 'danger', 'Delete');
  merge.onclick = async () => {
    m.remove();
    const main = sub ? state.convos.find((x) => x.id === c.mainId) : c;
    if (!confirm(sub ? `Merge "${c.title}" into "${main?.title}"? Its messages move into the main chat, where they happened in time, and this chat goes.`
      : `Merge ${others === 1 ? 'the other chat' : `the ${others} other chats`} of "${c.title}" into it? Their messages move into this chat, where they happened in time, and those chats go.`)) return;
    try {
      const r = await api(`/api/convos/${c.id}/merge`, 'POST');
      toast(`Merged ${r.merged === 1 ? 'a chat' : `${r.merged} chats`} into ${main?.title || 'the main chat'}`, { kind: 'success' });
      if (state.cid !== r.into) { openConvo(r.into); closeSidebar(); setView('chat'); }
    } catch (e) { toast(e.message, { kind: 'error' }); }
  };
  archive.onclick = async () => {
    m.remove();
    try {
      await api(`/api/convos/${c.id}`, 'PATCH', { archived: !c.archived });
      toast(c.archived ? `${folderName(c.cwd)} is back in the list` : `${folderName(c.cwd)} archived: it's under Archived at the bottom of the list, with no reflection`, { kind: 'success' });
    } catch (e) { toast(e.message, { kind: 'error' }); }
  };
  fresh.onclick = () => { m.remove(); closeSidebar(); setView('chat'); applyDraft({ type: 'folder', path: c.cwd }); };
  rename.onclick = async () => {
    m.remove();
    const title = prompt(sub ? 'Rename chat' : 'Rename project (the folder keeps its name)', c.title);
    if (title && title.trim()) await api(`/api/convos/${c.id}`, 'PATCH', { title });
  };
  del.onclick = async () => {
    m.remove();
    const what = sub ? `Delete the chat "${c.title}"? The project and its other chats are kept.`
      : others ? `Delete "${c.title}"'s main chat? Its ${others === 1 ? 'other chat takes' : `oldest other chat takes`} over as the project's main chat; the folder and its GitHub repo are kept.`
        : `Remove "${c.title}" and its chat from the sidebar? The folder and its GitHub repo are kept.`;
    if (!confirm(what)) return;
    await api(`/api/convos/${c.id}`, 'DELETE');
    if (state.cid === c.id) openConvo(null);
  };
  m.append(fresh, rename, ...(others ? [merge] : []), archive, del);
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${Math.min(r.bottom + 4, innerHeight - 100)}px`;
  m.style.left = `${Math.min(r.left, innerWidth - 170)}px`;
  setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }));
}

async function api(url, method = 'GET', body, retry = true) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 404 && !data.error && retry && String(url).startsWith('/api/')) return apiAfterUpdate(url, method, body);
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
// An /api/ route the server doesn't know (a bare 404, no JSON error): this page is newer than the server, which is
// about to restart onto the new code (#459). The owner gets API_UPDATING instead of 'Request failed (404)', and the
// call is retried once the ws 'version' frame (sent on every connect) reports a newer build, within API_WAIT.ms.
const API_UPDATING = 'The server is updating, try again in a moment';
const API_WAIT = { ms: 3 * 60e3, waiters: [], toastAt: 0 };
async function apiAfterUpdate(url, method, body) {
  if (Date.now() - API_WAIT.toastAt > 10e3) { API_WAIT.toastAt = Date.now(); toast(API_UPDATING); }
  const from = VER.running?.build ?? null;
  const newer = await new Promise((resolve) => {
    const w = { from, resolve: (ok) => { clearTimeout(w.timer); API_WAIT.waiters = API_WAIT.waiters.filter((x) => x !== w); resolve(ok); } };
    w.timer = setTimeout(() => w.resolve(false), API_WAIT.ms);
    API_WAIT.waiters.push(w);
  });
  if (!newer) throw new Error(API_UPDATING);
  return api(url, method, body, false);
}
// onVersion: a build newer than the one a waiting call saw (any build when it saw none) releases it.
function apiServerVersion(build) {
  for (const w of [...API_WAIT.waiters]) if (w.from == null || (build && build > w.from)) w.resolve(true);
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
  if (['term', 'browser'].includes($('app').dataset.view)) { $('repoLink').hidden = true; $('previewLink').hidden = true; return; }
  $('title').textContent = currentTitle();
  $('cwdLabel').textContent = currentCwdLabel();
  document.title = `${currentTitle()} · agent-orch`;
  renderRepoLink();
  window.Previews?.renderHeader();
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
  window.Previews?.renderDraft(); // the new project's live preview address follows its name (previews.js)
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
// Screenshots oldest first by their event time (at/ts, then a remote run's seq i), never by media id; ties keep log
// order. A screen seen twice (same media id) counts at its latest time.
function shotsByTime(list) {
  const time = (s) => Number(s.at ?? s.ts) || 0;
  const sorted = list.map((s, n) => ({ s, n })).sort((a, b) => time(a.s) - time(b.s)
    || (a.s.i != null && b.s.i != null ? a.s.i - b.s.i : 0) || a.n - b.n).map((x) => x.s);
  const last = new Map(sorted.map((s, n) => [s.id, n]));
  return sorted.filter((s, n) => last.get(s.id) === n);
}
// A browser task's screens: the latest one large (label: 'Final screen' once finished, 'Current screen' while running),
// fit to the width, then the earlier ones as thumbnails, newest first. Click opens the lightbox (fitted).
function screenStrip(list, label, max = Infinity) {
  const shots = shotsByTime(list);
  const box = el('div', 'screens');
  if (!shots.length) return box;
  const last = shots.at(-1), rest = shots.slice(0, -1).reverse().slice(0, max - 1);
  const fig = shotNode(last);
  fig.classList.add('shot-final');
  box.append(el('div', 'dr-shots-head screen-head', label), fig);
  if (rest.length) box.append(el('div', 'dr-shots-head', `Earlier · ${rest.length}`), shotGrid(rest));
  return box;
}
const screenLabel = (status) => (['done', 'failed', 'cancelled'].includes(status) ? 'Final screen' : status === 'running' ? 'Current screen' : 'Last screen');
// Prev/next goes through every image of the chat, or of the whole task in the drawer.
function openShot(fig) {
  let list;
  const panel = fig.closest('.rv-panel, .act-list, .bx-act');
  if (panel) list = [...panel.querySelectorAll('.shot')].map((f) => ({ id: f.dataset.id, name: f.dataset.name, w: +f.dataset.w || 0, h: +f.dataset.h || 0 }));
  else if (fig.closest('#drBody') && O.detail) list = shotsByTime(O.detail.runs.flatMap((r) => r.entries.filter((e) => e.k === 'image')));
  else list = [...$('messages').querySelectorAll('.shot')].map((f) => ({ id: f.dataset.id, name: f.dataset.name, w: +f.dataset.w || 0, h: +f.dataset.h || 0 }));
  const seen = new Set();
  list = list.filter((i) => i.id && !seen.has(i.id) && seen.add(i.id));
  LB.list = list;
  LB.lastFocus = document.activeElement;
  setShotZoom('fit'); // every opening starts fitted; a switch to Actual size lasts until the lightbox closes
  showShot(Math.max(0, list.findIndex((i) => i.id === fig.dataset.id)));
  $('lightbox').hidden = false;
  $('lightbox').querySelector('[data-close].icon-btn').focus();
}
const LB = { list: [], i: 0, lastFocus: null, size: '', zoom: 'fit', tap: null };
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
// Fit: the whole image in the view (object-fit: contain, never upscaled, no scrollbars). Actual size: natural pixels,
// scrolling/panning (pinch-zoom on phones). At (x, y) (a double-click/tap), actual size keeps that image point under it.
function setShotZoom(zoom, at) {
  const v = $('lbView'), im = $('lbImg');
  const r = at && im.getBoundingClientRect();
  LB.zoom = zoom;
  v.classList.toggle('fit', zoom === 'fit');
  $('lbZoom').textContent = zoom === 'fit' ? 'Actual size' : 'Fit';
  $('lbZoom').setAttribute('aria-pressed', String(zoom !== 'fit'));
  if (zoom === 'fit' || !r?.width || !im.naturalWidth) { v.scrollTo(0, 0); return; }
  const fx = (at.x - r.left) / r.width, fy = (at.y - r.top) / r.height, vr = v.getBoundingClientRect();
  v.scrollTo(im.offsetLeft + fx * im.offsetWidth - (at.x - vr.left), im.offsetTop + fy * im.offsetHeight - (at.y - vr.top));
}
const toggleShotZoom = (at) => setShotZoom(LB.zoom === 'fit' ? 'actual' : 'fit', at);
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
  if (e.pointerType !== 'mouse' || e.button !== 0 || LB.zoom === 'fit') return;
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
// Double-click (mouse) or double-tap (touch, where dblclick is unreliable) toggles Fit ↔ Actual size.
$('lbView').addEventListener('dblclick', (e) => { if (!LB.tap) toggleShotZoom({ x: e.clientX, y: e.clientY }); });
$('lbView').addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse' || !e.isPrimary) return;
  const now = Date.now(), t = LB.tap;
  if (t && now - t.at < 350 && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 30) {
    LB.tap = { at: now, x: NaN, y: NaN }; // a third tap starts over
    toggleShotZoom({ x: e.clientX, y: e.clientY });
  } else LB.tap = { at: now, x: e.clientX, y: e.clientY };
  clearTimeout(LB.tapTimer);
  LB.tapTimer = setTimeout(() => { LB.tap = null; }, 600); // swallows the synthetic dblclick a double-tap may also fire
});
$('lbZoom').addEventListener('click', () => toggleShotZoom());
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
    case 'approval': {
      // '#12 is waiting for your approval: Click "Send" button on mail.google.com · To: bob@…'
      endLive();
      const n = el('div', 'notice approval', `#${ev.taskId} is waiting for your approval: ${ev.action}`);
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
// Keyboard-aware layout (UI-REVIEW #2): iOS Safari ignores interactive-widget=resizes-content, so the keyboard height
// comes from visualViewport. app.css shrinks .app by --kb and, on phones, hides the orch bar while html.kb-open.
// A focus counts only inside a user gesture: iOS opens no keyboard for the load-time input.focus().
let kbFocus = false;
function syncKeyboard() {
  const vv = window.visualViewport, root = document.documentElement;
  const kb = vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
  root.style.setProperty('--kb', kb + 'px');
  root.classList.toggle('kb-open', kb > 0 || kbFocus);
}
if (window.visualViewport) for (const ev of ['resize', 'scroll']) visualViewport.addEventListener(ev, syncKeyboard);
// Any field that brings up the keyboard (the chat composer, the Browser tab's prompt box).
function kbAware(f) {
  f.addEventListener('focus', () => { kbFocus = navigator.userActivation?.isActive ?? true; syncKeyboard(); });
  f.addEventListener('blur', () => { kbFocus = false; syncKeyboard(); });
}
kbAware(input);
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
for (const f of [$('attInput'), $('attImgInput')]) f.addEventListener('change', (e) => { addAttachments([...e.target.files]); e.target.value = ''; input.focus(); });
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
        ? { newProject: { name: d.name, fromText: text || ATT.list[0]?.name.replace(/\.[^.]+$/, '') || '', ...window.Previews?.draftPick() }, mode: state.draftMode }
        : { folder: d.path, mode: state.draftMode, title: text || ATT.list[0]?.name || '' }); // title: a project's extra chat is named from it
      state.draft = { type: 'new', name: '' }; // the next new chat starts its own project again
      window.Previews?.resetDraft();
      if (c.previewError) toast(`Live preview not set up: ${c.previewError}`, { kind: 'error' });
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
  if (e.target.closest('[data-open-gh]')) { openPicker(); openGhImport(); } // the picker, switched to its import pane at once
});

// ---------- composer menus (mode, effort; the model pill opens the fallback sheet) ----------
// One compact listbox popover (.cmenu) in the app's menu style: it opens above its chip (the composer sits at the bottom;
// below when there is more room there), options are .cm-opt buttons (role=option; aria-selected marks the current one),
// arrows/Home/End move, Enter or a click picks, Esc, Tab or a click outside closes. Phones get the same menu; the phone
// composer hides the chips, so its '+' sheet opens them above #plusBtn (openMenuFrom).
const CM = { open: null, binds: new Map() }; // open: { chip, menu, pick, anchor }; binds: chip → { menu, build, pick }
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
function openMenu(chip, menu, build, pick, anchor = chip) {
  closeMenu(false);
  menu.replaceChildren();
  build(menu);
  menu.hidden = false;
  chip.setAttribute('aria-expanded', 'true');
  CM.open = { chip, menu, pick, anchor };
  placeMenu(menu, anchor);
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
  if (refocus) (o.chip.offsetParent ? o.chip : o.anchor).focus();
}
function openMenuFrom(chip, anchor) {
  const b = CM.binds.get(chip);
  openMenu(chip, b.menu, b.build, b.pick, anchor);
}
function bindMenu(chip, menu, build, pick) {
  CM.binds.set(chip, { menu, build, pick });
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
addEventListener('resize', () => { if (CM.open) placeMenu(CM.open.menu, CM.open.anchor); });
// The phone composer's '+' (#451): a sheet with Photo, File and a row per composer chip (mode, and effort / persona when
// their chips show) carrying the chip's value; a row opens that chip's menu above '+'.
const PLUS = { lastFocus: null };
function openPlusSheet() {
  closeMenu(false);
  PLUS.lastFocus = document.activeElement;
  $('psMode').textContent = $('modeLabel').textContent;
  $('psEff').textContent = $('effVal').textContent;
  $('psPersona').textContent = $('personaLabel').textContent;
  for (const r of $('plusSheet').querySelectorAll('[data-plus$="Chip"]')) r.hidden = $(r.dataset.plus).hidden;
  $('plusSheet').hidden = false;
  $('plusBtn').setAttribute('aria-expanded', 'true');
  if (!coarse) $('plusSheet').querySelector('.ps-row').focus();
}
function closePlusSheet(refocus = true) {
  $('plusSheet').hidden = true;
  $('plusBtn').setAttribute('aria-expanded', 'false');
  if (refocus) PLUS.lastFocus?.focus?.();
}
$('plusBtn').addEventListener('click', openPlusSheet);
$('plusSheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) return closePlusSheet();
  const what = e.target.closest('[data-plus]')?.dataset.plus;
  if (!what) return;
  closePlusSheet(false);
  if (what === 'photo') $('attImgInput').click();
  else if (what === 'file') $('attInput').click();
  else openMenuFrom($(what), $('plusBtn'));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('plusSheet').hidden) { e.stopImmediatePropagation(); closePlusSheet(); }
}, true);
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
// ---------- fallbacks (BRIEF goal 8) ----------
// One sheet (#fbModal) edits an ordered fallback list: a chat's (the tasks its messages queue snapshot it and move down
// it when their model hits its limit; empty = they wait), a task's, or a project's list for reflection tasks. It renders
// from what is already loaded (convos, O.project, AGENT_LIST, O.state.blocks), never a fetch; every change saves at once.
// The chat's is the composer's one model pill ('Opus 5 → Astra +1'): its sheet adds the model list above the fallbacks.
function renderPickChip() { renderModelPill(); fbRender(); renderEff(); }
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
// models: the sheet also lists the models to pick the primary from (the primary follows the pick).
function chatFallbacks() {
  const cid = state.cid, convo = () => state.convos.find((c) => c.id === cid);
  return { what: 'queued tasks', models: true, get primary() { return parsePick($('model').dataset.prev || 'claude|'); },
    list: () => (cid ? convo()?.fallbacks : state.draftFallbacks) ?? null,
    url: cid ? `/api/convos/${cid}/fallbacks` : null,
    apply: (list) => {
      if (cid) { const c = convo(); if (c) c.fallbacks = list; } else { state.draftFallbacks = list; store.set('cw.fallbacks', JSON.stringify(list || [])); }
      renderModelPill();
    },
    confirmedOf: (c) => c.fallbacks ?? null };
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
// The composer's pill: the primary model's name, then '→ ● first fallback' and '+N' for the rest. The fallback part
// shrinks first (app.css); the whole chain is in the title and aria-label ('Model Opus 5, then Astra, then Sol').
function renderModelPill() {
  const h = chatFallbacks(), list = h.list() || [], name = fbName(h.primary), fb = $('modelFb');
  $('modelLabel').textContent = name;
  fb.replaceChildren();
  fb.hidden = !list.length;
  if (list.length) {
    const dot = el('span', `fb-dot ${modelHealth(list[0])}`);
    dot.setAttribute('aria-hidden', 'true');
    fb.append(el('span', 'fb-arrow', '→'), dot, el('span', 'fb-name', fbName(list[0])));
    if (list.length > 1) fb.append(el('span', 'fb-more', `+${list.length - 1}`));
  }
  const text = `Model ${[name, ...list.map(fbName)].join(', then ')}`;
  $('modelChip').title = text;
  $('modelChip').setAttribute('aria-label', text);
  // Non-Claude usage windows (the dot) come with the usage history; load them once if nothing has yet.
  if (list[0] && list[0].agent !== 'claude' && !usageSlides.at && !usageSlides.loading) loadSidebarUsage();
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
  const m = $('fbModal'), panel = m.querySelector('.modal-panel');
  if (m.hidden) FB.lastFocus = anchor;
  FB.host = host;
  host.confirmed = host.list();
  FB.fe = { refresh: fbRender };
  FB.q = '';
  $('fbModelSearch').value = '';
  m.hidden = false;
  if (host.models) $('modelChip').setAttribute('aria-expanded', 'true');
  fbRender();
  // A composer-style menu next to its button (placeMenu); the model pill's sheet is a bottom sheet on phones (app.css).
  // Esc or a click outside closes it.
  if (host.models && phoneMQ.matches) Object.assign(panel.style, { left: '', top: '', bottom: '', maxHeight: '' });
  else placeMenu(panel, anchor);
  if (host.models) {
    const cur = $('fbModels').querySelector('.cm-opt[aria-selected="true"]');
    cur?.scrollIntoView({ block: 'nearest' });
    if (!coarse) (cur || $('fbModelSearch')).focus({ preventScroll: true }); // a touch tap would paint a focus ring
  } else (m.querySelector('#fbBody .fe-row') || m.querySelector('#fbBody .fe-add-btn'))?.focus();
}
function closeFallbacks() {
  $('fbModal').hidden = true;
  $('modelChip').setAttribute('aria-expanded', 'false');
  const back = FB.lastFocus?.isConnected ? FB.lastFocus : FB.host?.focusBack?.();
  FB.host = null;
  FB.fe = {};
  back?.focus?.();
}
$('modelChip').addEventListener('click', () => openFallbacks(chatFallbacks(), $('modelChip')));
$('modelChip').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openFallbacks(chatFallbacks(), $('modelChip')); }
});
$('fbModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeFallbacks(); });
// The model section (the chat's pill only): a pick sets the primary and keeps the sheet open; 'Sign in' opens Connections.
$('fbModels').addEventListener('click', (e) => {
  const signin = e.target.closest('[data-signin]');
  if (signin) { closeFallbacks(); return openConnections(signin.dataset.signin); }
  const b = e.target.closest('.cm-opt');
  if (b && !b.disabled) fbPickModel(b.dataset.value);
});
$('fbModels').addEventListener('keydown', (e) => {
  const opts = [...$('fbModels').querySelectorAll('.cm-opt:not(:disabled)')], i = opts.indexOf(document.activeElement);
  if (i < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? opts.length - 1 : i + (e.key === 'ArrowDown' ? 1 : -1);
  if (j < 0 && e.key === 'ArrowUp') return $('fbModelSearch').focus();
  opts[Math.max(0, Math.min(opts.length - 1, j))]?.focus();
});
$('fbModelSearch').addEventListener('input', () => { FB.q = $('fbModelSearch').value; buildModelMenu($('fbModels'), FB.q); });
$('fbModelSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('fbModels').querySelector('.cm-opt:not(:disabled)')?.click(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); $('fbModels').querySelector('.cm-opt:not(:disabled)')?.focus(); }
});
function fbPickModel(v) {
  const sel = $('model');
  if (v !== sel.value) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); } // re-renders the sheet (fbRender)
  $('fbModels').querySelector(`.cm-opt[data-value="${CSS.escape(v)}"]`)?.focus({ preventScroll: true });
}
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
  $('fbModal').classList.toggle('combo', !!h.models);
  $('fbModelSec').hidden = !h.models;
  if (h.models) {
    const cur = document.activeElement?.closest?.('#fbModels .cm-opt')?.dataset.value;
    buildModelMenu($('fbModels'), FB.q || '');
    if (cur != null) $('fbModels').querySelector(`.cm-opt[data-value="${CSS.escape(cur)}"]`)?.focus({ preventScroll: true });
  }
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
    g.dataset.agent = a.id;
    if (a.available && a.loggedIn === false) g.dataset.signin = '1';
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
}
// The pill sheet's model list (#fbModels): one group per usable agent (its Default, then its models), filtered by the
// search q; unusable agents last as faint headers, a signed-out one with 'Sign in'. The <select> stays the source of
// truth: a pick sets its value and fires its change event (fbPickModel).
function buildModelMenu(menu, q = '') {
  const sel = $('model'), words = q.toLowerCase().trim();
  const groups = [...sel.children].filter((g) => g.tagName === 'OPTGROUP').sort((a, b) => a.disabled - b.disabled);
  menu.replaceChildren();
  for (const g of groups) {
    const head = el('div', 'cm-head' + (g.disabled ? ' off' : ''), g.label);
    if (g.disabled) { // signed out / not installed: the header says so
      if (words && !g.label.toLowerCase().includes(words)) continue;
      if (g.dataset.signin) {
        const b = el('button', 'link-btn inline', 'Sign in');
        b.type = 'button';
        b.dataset.signin = g.dataset.agent;
        head.append(' · ', b);
      }
      menu.append(head);
      continue;
    }
    const def = [...g.children].find((o) => / \(default\)$/.test(o.textContent));
    const opts = [];
    for (const o of g.children) {
      const isDef = o.value.endsWith('|');
      const label = isDef ? 'Default' : o.textContent.replace(/^[^·]+ · /, '').replace(/ \(default\)$/, '');
      const hint = isDef && def ? def.textContent.replace(/^[^·]+ · /, '').replace(/ \(default\)$/, '') : '';
      if (words && !`${g.label} ${label} ${hint} ${o.value}`.toLowerCase().includes(words)) continue;
      opts.push(menuOpt(label, { value: o.value, selected: o.value === sel.value, hint, title: o.title, disabled: o.disabled }));
    }
    if (opts.length) menu.append(head, ...opts);
  }
  if (!menu.children.length) menu.append(el('p', 'fe-hint', 'No models match.'));
}
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
// Phones show a delegated chip short ('Astra · moved'); the full text stays in the tooltip and the drawer.
const phoneMQ = matchMedia('(max-width: 800px)');
phoneMQ.addEventListener('change', () => refreshAllCards());
function modelChip(t, ms = modelStatus(t)) {
  const b = el('span', `tc-tag model ${ms.kind}`);
  if (ms.kind === 'delegated') b.innerHTML = MOVED_SVG;
  const short = ms.kind === 'delegated' && phoneMQ.matches;
  b.append(document.createTextNode(short ? `${ms.model} · moved` : ms.text));
  b.title = [short && ms.text, ms.tip, t.route_note].filter(Boolean).join(' — ');
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
// Picking a project (new or with chats already) starts a new chat in it; its other chats stay in the sidebar.
const chooseFolder = (p) => applyDraft({ type: 'folder', path: p });
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
  if (GH_URL.test(raw)) { // a pasted repo URL: import it rather than name a project after it
    list.append(pkItem({ name: `Import ${raw.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\/|^git@github\.com:|\.git$/gi, '')}` },
      { create: true, meta: 'Clone this GitHub repo into a new project', onUse: () => openGhImport(raw) }));
  } else if (!exact) {
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
  $('pkGithub').hidden = true;
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

// ---------- import from GitHub (the picker's third pane) ----------
// Lists the account's repos (GET /api/github/repos, re-read on every open); any owner/name or URL typed in gets an
// "Import …" row. Picking clones it into ~/workspace (POST /api/projects/import) and picks that folder for the next chat.
const GH_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+|^git@github\.com:/i;
const GHI = { repos: null, error: null, busy: false };
function ghTyped(raw) {
  if (GH_URL.test(raw)) return raw.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\/|^git@github\.com:/i, '').split('/').slice(0, 2).join('/').replace(/\.git$/, '');
  if (/^[\w-]+\/[\w.-]+$/.test(raw)) return raw;
  return /^(?:https:\/\/|ssh:\/\/|git@)\S+$/.test(raw) ? raw : null; // another git host: cloned with git
}
async function openGhImport(prefill = '') {
  $('pkProjects').hidden = true;
  $('pkBrowse').hidden = true;
  $('pkGithub').hidden = false;
  $('pickerTitle').textContent = 'Import from GitHub';
  $('pkGhSearch').value = prefill;
  $('pkGhSearch').focus();
  renderGhImport();
  try { GHI.repos = (await api('/api/github/repos')).repos; GHI.error = null; } catch (e) { GHI.error = e.message; }
  if (!$('pkGithub').hidden) renderGhImport();
}
function ghImportRow(r, spec, typed = false) {
  const meta = typed ? 'Clone this repo into a new project'
    : [r.description, r.fork && 'fork', r.pushedAt && `pushed ${relTime(Date.parse(r.pushedAt))}`].filter(Boolean).join(' · ');
  const row = pkItem({ name: typed ? `Import ${r.full}` : r.full }, { create: typed, meta, onUse: () => importRepo(spec, row) });
  if (!typed) row.querySelector('.fi').innerHTML = $('repoLink').querySelector('svg').outerHTML;
  if (!typed && r.private) row.append(el('span', 'tag', 'private'));
  return row;
}
function renderGhImport() {
  if (GHI.busy) return; // keep the row that says "Cloning…"
  const raw = $('pkGhSearch').value.trim(), q = raw.toLowerCase(), typed = ghTyped(raw);
  const list = $('pkGhList');
  list.textContent = '';
  const repos = GHI.repos || [];
  const same = (r) => typed && r.full.toLowerCase() === typed.toLowerCase();
  const shown = repos.filter((r) => !q || same(r) || r.full.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  if (typed && !repos.some(same)) list.append(ghImportRow({ full: typed }, raw, true));
  for (const r of shown.slice(0, 100)) list.append(ghImportRow(r, r.full));
  list.classList.toggle('error', !!GHI.error && !list.children.length);
  if (!list.children.length) {
    list.append(el('div', 'pk-empty', GHI.error || (!GHI.repos ? 'Loading your repos…'
      : raw ? 'No matching repos. Paste owner/name or a URL to import any repo you can see.' : 'No repos on this GitHub account yet.')));
  }
  pk.kb = list.querySelector('.pk-item') ? 0 : -1;
  list.querySelector('.pk-item')?.classList.add('kb');
}
async function importRepo(spec, row) {
  if (GHI.busy) return;
  GHI.busy = true;
  row.classList.add('busy');
  const meta = row.querySelector('.fd'), was = meta.textContent;
  meta.textContent = 'Cloning…';
  try {
    const r = await api('/api/projects/import', 'POST', { repo: spec });
    GHI.busy = false;
    loadProjects();
    chooseFolder(r.path);
    toast(r.existing ? `${r.repo?.full || r.name} is already the project ${r.name}: your next message starts a chat there`
      : `Imported ${r.repo?.full || spec} into ~/workspace/${r.name}. Send a message to start working on it.`);
  } catch (e) {
    GHI.busy = false;
    row.classList.remove('busy');
    meta.textContent = was;
    toast(`Couldn't import: ${e.message}`, { kind: 'error' });
  }
}
$('pkGhBtn').addEventListener('click', () => openGhImport());
$('pkGhSearch').addEventListener('input', renderGhImport);
$('pkGhBack').addEventListener('click', () => {
  $('pickerTitle').textContent = 'Choose a project';
  $('pkGithub').hidden = true;
  $('pkProjects').hidden = false;
  $('pkSearch').focus();
});

// Arrow keys move through the visible list; Enter picks (projects) or opens (browse).
$('pickerModal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); return; }
  const list = !$('pkGithub').hidden ? $('pkGhList') : $('pkBrowse').hidden ? $('pkList') : $('pkBrowseList');
  const rows = [...list.querySelectorAll('.pk-item')];
  if (!rows.length || !['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
  if (e.key === 'Enter') {
    if (e.target.closest('form')) return;
    // Enter in the search box picks the top match.
    const idx = pk.kb >= 0 ? pk.kb : e.target === $('pkSearch') || e.target === $('pkGhSearch') ? 0 : -1;
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

// Web Push (push.mjs): the push-only /sw.js shows notifications while the app is closed; a tap posts {t: 'open', url}
// back here (routeHash). iOS offers PushManager only to the Home Screen app.
const swReg = 'serviceWorker' in navigator ? navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null) : Promise.resolve(null);
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.t === 'open') routeHash(new URL(e.data.url, location.href).hash.slice(1));
});
const iosBrowser = (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))
  && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches;
const b64uBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
(async function initPushSwitch() {
  const sw = $('stPush');
  if (!('PushManager' in window) || iosBrowser) {
    sw.disabled = true;
    $('stPushHint').textContent = 'Add agent-orch to your Home Screen to get notifications';
    return;
  }
  const reg = await swReg;
  sw.checked = !!(await reg?.pushManager.getSubscription().catch(() => null)) && Notification.permission === 'granted';
})();
$('stPush').addEventListener('change', async (e) => {
  const sw = e.target, on = sw.checked;
  sw.disabled = true;
  try {
    const reg = await swReg;
    if (!reg) throw new Error("This browser couldn't set up notifications");
    if (on) {
      if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for agent-orch. Allow them in Settings, then try again.');
      const { key } = await api('/api/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(key) });
      await api('/api/push/subscribe', 'POST', sub.toJSON());
      toast('Notifications on for this device');
    } else {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api('/api/push/subscribe', 'DELETE', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      toast('Notifications off for this device');
    }
  } catch (err) {
    sw.checked = !on;
    toast(err.message, { kind: 'error' });
  }
  sw.disabled = false;
});
// The Home Screen icon's badge: held actions waiting for the owner, across every task this page knows.
function syncAppBadge() {
  if (!('setAppBadge' in navigator)) return;
  let n = 0;
  for (const t of O.tasks.values()) n += t.approvals?.length || 0;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

// ---------- task completion sound ----------
const DEFAULT_TASK_SOUND = '/sounds/task-done.mp3';
const taskSound = new Audio(DEFAULT_TASK_SOUND);
taskSound.preload = 'auto';
taskSound.volume = 0.6;
// window/heard: the current 3 s burst (its start and the machines already queued in it); busyUntil: when the sound playing
// now ends (performance.now ms), so a burst plays each machine's sound in turn; nodes: the machines, oldest first (MC.nodes).
// custom: the owner's own sounds (GET /api/sounds) and the one for all machines; buffers: id → a promise of the decoded
// AudioBuffer (fetched once the page has its audio unlock, or on first play); unlocked: that unlock happened.
const completionSound = { synced: false, statuses: new Map(), done: new Set(), window: -Infinity, heard: new Set(), queue: [], draining: false,
  busyUntil: -Infinity, unlocking: null, ctx: null, mp3: false, nodes: [], custom: { sounds: [], def: null }, buffers: new Map(), unlocked: false };
// Each machine's finish sound, so the owner can tell by ear where a task finished. 'chime' is the MP3 above (the controller's
// default); the others are synthesized with Web Audio: notes [Hz, start s, length s, peak gain, glide-to Hz].
const MACHINE_SOUNDS = {
  chime: { label: 'Chime' },
  bell: { label: 'Bell', type: 'sine', notes: [[1318.5, 0, 0.9, 0.2], [3639, 0, 0.35, 0.04]] },
  marimba: { label: 'Marimba', type: 'sine', notes: [[523.3, 0, 0.3, 0.24], [784, 0.13, 0.4, 0.22]] },
  pop: { label: 'Pop', type: 'sine', notes: [[280, 0, 0.16, 0.26, 900], [420, 0.18, 0.14, 0.18, 1200]] },
  glass: { label: 'Glass', type: 'sine', notes: [[1760, 0, 0.7, 0.12], [2637, 0.09, 0.6, 0.08]] },
  rise: { label: 'Rise', type: 'triangle', notes: [[523.3, 0, 0.28, 0.16], [659.3, 0.11, 0.28, 0.16], [784, 0.22, 0.45, 0.16]] },
  'two-tone': { label: 'Two-tone', type: 'sine', notes: [[784, 0, 0.4, 0.2], [523.3, 0.26, 0.55, 0.2]] },
};
const SYNTH_SOUNDS = Object.keys(MACHINE_SOUNDS).filter((k) => k !== 'chime');
const HEAD_NODE = 'controller';
// Defaults: the controller keeps the chime; each worker, oldest first, starts at a hash of its id across the synthesized
// sounds and steps past ones an older worker already has (while any are left), so workers differ and a new one never
// changes another's. The owner's pick (node.sound, saved on the head) wins.
function soundHash(id) {
  let h = 2166136261;
  for (const ch of String(id)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h;
}
function defaultMachineSounds(ids) {
  const out = new Map(), used = new Set();
  for (const id of ids) {
    if (id === HEAD_NODE) { out.set(id, 'chime'); continue; }
    let i = soundHash(id) % SYNTH_SOUNDS.length;
    for (let n = 0; n < SYNTH_SOUNDS.length && used.has(SYNTH_SOUNDS[i]); n++) i = (i + 1) % SYNTH_SOUNDS.length;
    used.add(SYNTH_SOUNDS[i]);
    out.set(id, SYNTH_SOUNDS[i]);
  }
  return out;
}
function setMachineSounds(nodes) {
  completionSound.nodes = (nodes || []).map((n) => ({ id: n.id, sound: n.sound ?? null }));
  preloadCustomSounds();
}
// Custom sounds are keyed 'custom:<id>' (node.sound, the pickers); a deleted one no longer resolves, so its machines fall back.
const customSound = (key) => (String(key).startsWith('custom:') ? completionSound.custom.sounds.find((c) => c.key === key) : null);
function setCustomSounds(d) {
  const sounds = d?.sounds || [];
  for (const id of completionSound.buffers.keys()) if (!sounds.some((c) => c.id === id)) completionSound.buffers.delete(id);
  completionSound.custom = { sounds, def: d?.default ?? null };
  preloadCustomSounds();
}
// What a machine without its own pick plays: the custom sound for all machines, else its built-in default.
function machineFallback(id) {
  return customSound(`custom:${completionSound.custom.def}`)?.key || machineDefaultSound(id);
}
function machineDefaultSound(id) {
  const ids = completionSound.nodes.map((n) => n.id);
  return defaultMachineSounds(ids.includes(id) ? ids : [...ids, id]).get(id); // a machine paired since: it is the newest
}
function machineSound(id) {
  const pick = completionSound.nodes.find((n) => n.id === id)?.sound;
  return MACHINE_SOUNDS[pick] || customSound(pick) ? pick : machineFallback(id);
}
// The machine a task ran on: run.node_id (task.node). Integrations and the head's own tasks sound like the head.
const taskSoundNode = (t) => (t.integrates || !t.node ? HEAD_NODE : t.node);
function audioCtx() {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!completionSound.ctx && Ctx) try { completionSound.ctx = new Ctx(); } catch {}
  return completionSound.ctx;
}
// Starts one sound; returns how long it lasts (ms).
function playSound(key) {
  const c = customSound(key);
  if (c) { void playCustomSound(c); return Math.min(c.duration || 2, 10) * 1000; }
  const s = MACHINE_SOUNDS[key] || MACHINE_SOUNDS.chime;
  if (!s.notes) { void playTaskSound(); return Math.min(Number.isFinite(taskSound.duration) ? taskSound.duration : 1.5, 3) * 1000; }
  void playNotes(s);
  return Math.max(...s.notes.map(([, at, len]) => at + len)) * 1000;
}
async function playNotes(s) {
  const ctx = audioCtx();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    for (const [hz, at, len, peak, glide] of s.notes) {
      const osc = ctx.createOscillator(), gain = ctx.createGain(), start = t0 + at;
      osc.type = s.type;
      osc.frequency.setValueAtTime(hz, start);
      if (glide) osc.frequency.exponentialRampToValueAtTime(glide, start + len * 0.6);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + len + 0.05);
    }
  } catch {} // no audio device, or the browser still holds audio back
}
// A custom sound, whole and at its own volume, from its decoded buffer (so it starts at once); without Web Audio, an <audio>.
async function playCustomSound(c) {
  const ctx = audioCtx();
  try {
    if (!ctx?.decodeAudioData) { const a = new Audio(c.url); a.volume = c.volume / 100; await a.play(); return; }
    if (ctx.state === 'suspended') await ctx.resume();
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = await customBuffer(c);
    gain.gain.value = c.volume / 100;
    src.connect(gain).connect(ctx.destination);
    src.start();
  } catch {} // gone from the server, undecodable, or audio still held back
}
function customBuffer(c) {
  let b = completionSound.buffers.get(c.id);
  if (!b) {
    b = fetch(c.url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`)))).then((a) => audioCtx().decodeAudioData(a));
    b.catch(() => { if (completionSound.buffers.get(c.id) === b) completionSound.buffers.delete(c.id); });
    completionSound.buffers.set(c.id, b);
  }
  return b;
}
// After the audio unlock, the custom sounds some machine plays are fetched and decoded ahead of their first finish.
function preloadCustomSounds() {
  if (!completionSound.unlocked || !audioCtx()?.decodeAudioData) return;
  const used = new Set([`custom:${completionSound.custom.def}`, ...completionSound.nodes.map((n) => n.sound)]);
  for (const c of completionSound.custom.sounds) if (used.has(c.key)) customBuffer(c).catch(() => {});
}
// A burst's sounds play one after another, never over each other.
async function drainMachineSounds() {
  if (completionSound.draining) return;
  completionSound.draining = true;
  try {
    while (completionSound.queue.length) {
      const wait = completionSound.busyUntil - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      completionSound.busyUntil = performance.now() + playSound(completionSound.queue.shift()) + 150;
    }
  } finally { completionSound.draining = false; }
}
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
  audioCtx()?.resume?.().catch(() => {}); // created and resumed inside the gesture, so later synthesized sounds may play
  completionSound.unlocking = (async () => {
    try { await taskSound.play(); } catch {}
    taskSound.pause();
    taskSound.currentTime = 0;
    taskSound.muted = false;
  })();
  completionSound.unlocked = true;
  preloadCustomSounds();
}
document.addEventListener('pointerdown', unlockTaskSound);
document.addEventListener('keydown', unlockTaskSound);
$('stSound').checked = store.get('cw.taskSound') !== 'off';
$('stSound').addEventListener('change', (e) => store.set('cw.taskSound', e.target.checked ? 'on' : 'off'));
// An uploaded MP3 (GET /api/settings/sound) replaces the default chime for every browser. Settings has only the on/off
// switch (#481): each machine's sound, and the owner's custom sounds, are chosen in its Machines settings.
function setSoundInfo(sound) {
  taskSound.src = sound?.custom ? `/api/settings/sound?v=${sound.at}` : DEFAULT_TASK_SOUND;
  completionSound.mp3 = !!sound?.custom;
}
api('/api/settings').then((d) => setSoundInfo(d.sound)).catch(() => {});
api('/api/cluster/nodes').then((d) => setMachineSounds(d.nodes)).catch(() => {}); // each machine's sound (Machines refreshes it)

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
  if (!$('stSound').checked) return; // plays whether this tab is focused or in the background
  // Several finishing within 3 s: each machine's sound once, in turn.
  const now = performance.now(), node = taskSoundNode(t);
  if (now - completionSound.window >= 3000) { completionSound.window = now; completionSound.heard.clear(); }
  if (completionSound.heard.has(node)) return;
  completionSound.heard.add(node);
  completionSound.queue.push(machineSound(node));
  void drainMachineSounds();
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
    if (serverOpen()) send({ t: 'metrics_sub', on: true });
    if (O.drawer) { send({ t: 'owatch', taskId: O.drawer, on: true }); loadDetail(); }
    window.bvResume?.();
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
  if (msg.t?.startsWith('bv_')) return window.bvOnServer?.(msg); // the live browser view (browser.js)
  if (msg.t === 'oprojects') { applyProjectOrder(msg.order || []); renderConvoList(); return renderOrchBar(); }
  if (['otask', 'oproject', 'ostate', 'orun', 'oorder', 'olane'].includes(msg.t)) return onOrch(msg);
  if (msg.t === 'connections') return msg.node ? applyRemote(msg.node, msg.connections) : applyConnections(msg.connections);
  if (msg.t === 'cluster') {
    // An auto-drain or a failed self-update: the owner should see it now (it stays on the machine's card and in the log).
    if (msg.kind === 'notice') { toast(msg.text, { kind: 'warn', duration: 12000 }); return scheduleMachines(0); }
    scheduleMachines(msg.kind === 'resources' ? 600 : 0);
    if (msg.kind === 'resources') return; // only a worker's CPU/RAM reading changed
    window.bxOnCluster?.(); // a Chrome runner came or went (the Browser tab, browser.js)
    if (!$('connsModal').hidden) loadConnNodes();
    return checkPairing();
  }
  if (msg.t === 'models') return api('/api/agents').then((d) => { AGENT_LIST = d.agents || []; renderAgentPicker(); }).catch(() => {});
  if (msg.t === 'status') {
    if (msg.alert) toast(msg.alert, { kind: 'error' });
    return applyUpdateStatus(msg);
  }
  if (msg.t === 'version') return onVersion(msg.running);
  if (msg.t === 'ext') return window.Ext?.changed(msg.kind); // skills/MCP/subagents/personas changed (ext.js)
  if (msg.t === 'previews') return window.Previews?.changed(true); // a live preview or domain changed (previews.js)
  if (msg.t === 'convos') {
    const drChat = O.detail?.project?.convo_id, effortOf = () => state.convos.find((c) => c.id === drChat)?.effort ?? null;
    const drEffort = drChat ? effortOf() : null;
    const was = state.convos.find((c) => c.id === state.cid);
    state.convos = msg.convos;
    if (state.cid && !state.convos.find((c) => c.id === state.cid)) {
      const main = was?.mainId && state.convos.find((c) => c.id === was.mainId); // a merged (or deleted) extra chat: its main chat
      openConvo(main ? main.id : null);
    }
    renderConvoList();
    updateFolderChip();
    updateHeader();
    migrateAutoDelegate();
    renderModelPill();
    fbRender();
    renderEff();
    window.Ext?.renderChip(); // the persona chip follows the chat's persona
    window.Previews?.renderHeader();
    if (drChat && O.drawer && effortOf() !== drEffort) renderDrawer(true); // its Effort row follows the chat's live effort
    renderUsage();
    if (!state.cid) splash.need.delete('history'); // no chat open (or it was deleted): nothing more to wait for
    splashReady('convos');
    if (!hashRoute.ready) { hashRoute.ready = true; if (hashRoute.task) showTask(hashRoute.task); hashRoute.task = null; }
    return;
  }
  if (msg.cid && msg.cid !== state.cid) return;
  switch (msg.t) {
    case 'history': {
      applyOrchSnapshot(msg.orch);
      resetMessages();
      if (!msg.events.length) { $('messages').append($('emptyTpl').content.cloneNode(true)); updateFolderChip(); }
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

// ---------- custom sounds (sounds.mjs): the add form under each machine's sound picker ----------
const SOUND_LIMIT = { bytes: 1024 * 1024, secs: 10 };
const SOUND_EXT_RE = /\.(mp3|m4a|aac|wav|ogg|oga)$/i;
const SOUND_ACCEPT = 'audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/x-wav,audio/ogg,.mp3,.m4a,.aac,.wav,.ogg';
function applyCustomSounds(d) {
  setCustomSounds(d);
  if (MC.nodes.length) renderMachines();
}
const loadCustomSounds = () => api('/api/sounds').then(applyCustomSounds).catch(() => {});
// The length as this browser decodes it; a file it can't decode isn't a sound it could play.
async function measureSound(blob) {
  const ctx = audioCtx();
  if (!ctx?.decodeAudioData) return null;
  try { return (await ctx.decodeAudioData(await blob.arrayBuffer())).duration; } catch { throw new Error("That isn't audio this browser can play"); }
}
const tooLong = (secs) => new Error(`That sound lasts ${secs.toFixed(1)} s; the limit is ${SOUND_LIMIT.secs} s`);
async function uploadSound(f) {
  if (!SOUND_EXT_RE.test(f.name) && !/^audio\//.test(f.type)) throw new Error('Pick an mp3, m4a/aac, wav or ogg file');
  if (f.size > SOUND_LIMIT.bytes) throw new Error('That file is over 1 MB');
  const secs = await measureSound(f);
  if (secs > SOUND_LIMIT.secs + 0.05) throw tooLong(secs);
  const r = await fetch('/api/sounds', { method: 'POST', body: f, headers: { 'Content-Type': f.type || 'application/octet-stream',
    'X-File-Name': encodeURIComponent(f.name), ...(secs != null && { 'X-Sound-Duration': secs.toFixed(2) }) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`);
  return d.sound;
}
// The head downloads the URL once; the stored copy is then measured here like an upload (too long: it goes again).
async function importSound(url) {
  const { sound } = await api('/api/sounds/import', 'POST', { url });
  if (sound.duration != null) return sound;
  let secs;
  try { secs = await measureSound(await (await fetch(sound.url)).blob()); } catch (e) { await api(`/api/sounds/${sound.id}`, 'DELETE').catch(() => {}); throw e; }
  if (secs == null) return sound;
  if (secs > SOUND_LIMIT.secs + 0.05) { await api(`/api/sounds/${sound.id}`, 'DELETE').catch(() => {}); throw tooLong(secs); }
  return (await api(`/api/sounds/${sound.id}`, 'PATCH', { duration: Math.round(secs * 100) / 100 })).sound;
}
// 'Choose file… or [https://…] Import': onAdded(sound) after the list is re-read; onCancel closes it.
function soundAddForm(onAdded, onCancel) {
  const box = el('div', 'snd-add'), file = el('input'), pickBtn = el('button', 'btn small', 'Choose file…');
  const url = el('input'), imp = el('button', 'btn small', 'Import'), cancel = el('button', 'btn small', 'Cancel');
  file.type = 'file'; file.accept = SOUND_ACCEPT; file.hidden = true;
  url.type = 'url'; url.placeholder = 'https://…/sound.mp3'; url.setAttribute('aria-label', 'Sound URL (https)');
  for (const b of [pickBtn, imp, cancel]) b.type = 'button';
  const busy = async (run) => {
    for (const b of [pickBtn, imp]) b.disabled = true;
    try {
      const c = await run();
      await loadCustomSounds();
      toast(`Added ${c.name}`);
      onAdded(c);
      void playSound(c.key);
    } catch (e) { toast(e.message, { kind: 'error' }); } finally { for (const b of [pickBtn, imp]) b.disabled = false; }
  };
  pickBtn.addEventListener('click', () => file.click());
  file.addEventListener('change', () => { const f = file.files[0]; file.value = ''; if (f) busy(() => uploadSound(f)); });
  const go = () => { if (url.value.trim()) busy(() => importSound(url.value.trim())); };
  imp.addEventListener('click', go);
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  url.addEventListener('blur', () => { if (MC.stale) setTimeout(renderMachines, 0); }); // a Machines render held while typing
  cancel.addEventListener('click', onCancel);
  box.append(pickBtn, file, el('span', 'snd-or', 'or'), url, imp, cancel, el('small', 'snd-hint', 'mp3, m4a/aac, wav or ogg · up to 1 MB and 10 s'));
  return box;
}
loadCustomSounds();

// ---------- status / boot ----------
async function checkStatus() {
  try {
    const s = await api('/api/status');
    state.workspace = s.workspace;
    MINI.host = s.host;
    miniRender();
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

// The server's checkout moved on since it booted (or a restart is queued or under way): offer "Restart now". A rolling
// restart (update: {at, phase}) shows when it happens; new public/ files only need a reload of this page.
const upd = { commits: 0, pending: false, update: null, deferred: null, publicBase: null, publicLatest: null, reload: false, dismissed: Number(store.get('cw.updDismissed')) || 0 };
function applyUpdateStatus(s) {
  if ('commitsSinceBoot' in s) upd.commits = s.commitsSinceBoot || 0;
  if ('restartPending' in s) upd.pending = !!s.restartPending;
  if ('update' in s) upd.update = s.update || null;
  if ('deferred' in s) upd.deferred = s.deferred || null;
  if (s.publicCommit) { upd.publicLatest = s.publicCommit; upd.publicBase ??= s.publicCommit; upd.reload = s.publicCommit !== upd.publicBase; }
  if (s.updated?.version && store.get('cw.updToast') !== s.updated.version) {
    store.set('cw.updToast', s.updated.version);
    toast(`Updated to v${s.updated.version}`, { kind: 'success' });
  }
  if (upd.commits < upd.dismissed) { upd.dismissed = 0; store.set('cw.updDismissed', '0'); } // a restart reset the count
  renderUpdateBanner();
}
async function pollUpdates() { try { applyUpdateStatus(await api('/api/status')); } catch {} }
const UPDATE_PHASE = { preflight: 'Updating: checking that the new code starts…', merging: 'Updating: waiting for a merge to finish…', pausing: 'Updating: pausing this server\'s tasks…', exiting: 'Updating: restarting…' };
// What the updates banner shows (pure, tested): a rolling restart's time or phase, an idle drain, an update the owner
// deferred with Cancel ('Update ready: vX.YY' + Restart now), a reload notice, or the new-commit count.
function updateBannerView(upd, draining, applyUpdates) {
  const u = upd.update, busy = draining || (u && u.phase !== 'scheduled');
  const deferred = !u && !draining && upd.deferred;
  const reloadOnly = !u && !draining && !deferred && upd.reload && (!upd.commits || upd.commits <= upd.dismissed);
  const dismissed = upd.commits && upd.commits <= upd.dismissed;
  return {
    hidden: !u && !draining && !reloadOnly && (deferred ? !!dismissed : !upd.commits || dismissed),
    text: u ? (UPDATE_PHASE[u.phase] || withUntil({ text: 'Updating the server at {until}', until: u.at }))
      : draining ? (applyUpdates === 'idle' ? 'Restarting once idle (automatic)…' : 'Restarting after running tasks finish…')
      : deferred ? `Update ready: v${deferred.version}`
      : reloadOnly ? 'The app was updated: reload to get the new version'
      : `${upd.commits} new commit${upd.commits === 1 ? '' : 's'} since the server started`,
    restart: !busy && !reloadOnly,
    cancel: !!draining || !!(u && ['scheduled', 'merging', 'preflight'].includes(u.phase)),
    reload: reloadOnly,
    dismiss: !busy && !u,
  };
}
function renderUpdateBanner() {
  const v = updateBannerView(upd, !upd.update && (upd.pending || !!O.state?.draining), O.state?.parallel?.applyUpdates);
  $('updateBanner').hidden = v.hidden;
  $('updateText').textContent = v.text;
  $('updateRestart').hidden = !v.restart;
  $('updateRestart').disabled = false;
  $('updateCancel').hidden = !v.cancel;
  $('updateCancel').disabled = false;
  $('updateReload').hidden = !v.reload;
  $('updateDismiss').hidden = !v.dismiss;
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
  chartPointer(host, (x) => { hoverX = x; }, () => draw());
  M.draws.push(draw);
}
// A chart's readout: a mouse hovers; a touch (tap, or a drag along it) shows the nearest reading, which stays until a
// tap elsewhere (no hover-only values on phones). set(x | null) moves the crosshair, draw() repaints.
let chartTap = null;
function chartPointer(host, set, draw) {
  const at = (e) => e.clientX - host.getBoundingClientRect().left;
  host.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || chartTap?.host === host) { set(at(e)); draw(); } });
  host.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { set(null); draw(); } });
  host.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    if (chartTap?.host !== host) chartTap?.clear();
    chartTap = { host, clear: () => { chartTap = null; set(null); draw(); } };
    set(at(e));
    draw();
  });
}
document.addEventListener('pointerdown', (e) => { if (chartTap && !chartTap.host.contains(e.target)) chartTap.clear(); });

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
const CA_WIDE = matchMedia('(min-width: 768px)'); // the Machines view's cards beside the diagram's machines (phones: a list)
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
  $('mSub').textContent = [
    d.device,
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
  const load = d.cpu.load.map((v) => v || 0), loadPct = (load[0] / d.cpu.cores) * 100; // no /proc/loadavg (a macOS head): null
  setTile('load', {
    num: [load[0], (v) => v.toFixed(2)],
    status: level(loadPct, 80, 150),
    detail: `5 min <b>${load[1].toFixed(2)}</b> · 15 min <b>${load[2].toFixed(2)}</b><br>${d.cpu.cores} vCPU, so 1.00 means fully busy · ${d.procs.total} processes`,
  });

  const tb = $('mTop').querySelector('tbody');
  tb.textContent = '';
  for (const p of d.top) {
    const tr = el('tr');
    tr.append(el('td', '', p.name), el('td', 'num', `${(p.cpu || 0).toFixed(1)}%`), el('td', 'num', fmtBytes(p.rss)));
    tb.append(tr);
  }

  M.draws.forEach((fn) => fn());
}

function setBar(bar, pct) {
  bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  bar.className = pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '';
}
// ----- the sidebar machine card -----
// Rotates through the head, then every online worker (MC.nodes, GET /api/cluster/nodes), MINI_MS each with a cross-fade;
// offline workers are skipped and counted ('+1 offline'). Hover or focus holds it. A click (Enter/Space) opens the
// all-machines window (openMachines), never the machine shown. id: the machine wanted, shown: the one painted.
// test/ui-mini-rotate.test.mjs runs this block (from `const MINI` to miniClick) in Node.
const MINI = { id: null, shown: null, host: '', timer: null, hold: new Set(), fading: false, fetch: null };
const MINI_MS = 5000;
function miniMachines(nodes, host) {
  const head = nodes.find((n) => n.local) || { id: 'controller', local: true, name: host };
  const workers = nodes.filter((n) => !n.local && n.enabled);
  return { list: [head, ...workers.filter((n) => n.connected)], offline: workers.filter((n) => !n.connected).length };
}
const miniShown = (list) => list.find((n) => n.id === MINI.id) || list[0];
// The machine `step` places after `id`; one that left the rotation restarts it at the head.
function miniNext(list, id, step = 1) {
  const at = list.findIndex((n) => n.id === id);
  return at < 0 ? list[0].id : list[(at + step + list.length) % list.length].id;
}
// Forward one machine (the timer); the new one gets its full MINI_MS.
function miniGo(step) {
  const { list } = miniMachines(MC.nodes, MINI.host);
  MINI.id = miniNext(list, miniShown(list).id, step);
  miniArm();
  miniRender();
}
function miniArm() {
  clearTimeout(MINI.timer);
  MINI.timer = null;
  if (MINI.hold.size || miniMachines(MC.nodes, MINI.host).list.length < 2) return;
  MINI.timer = setTimeout(() => miniGo(1), MINI_MS);
}
function miniClick() {
  openMachines();
}
function miniRender() {
  const { list } = miniMachines(MC.nodes, MINI.host), n = miniShown(list);
  if (list.length < 2 || MINI.hold.size) { clearTimeout(MINI.timer); MINI.timer = null; } else if (!MINI.timer) miniArm();
  if (MINI.fading) return; // the fade's end paints the newest numbers
  if (MINI.shown && MINI.shown !== n.id && !reduceMotion.matches) {
    MINI.fading = true;
    $('miniSlide').classList.add('out');
    setTimeout(() => { MINI.fading = false; $('miniSlide').classList.remove('out'); miniPaint(); }, 180);
  } else miniPaint();
}
function miniPaint() {
  const { list, offline } = miniMachines(MC.nodes, MINI.host), n = miniShown(list), swap = MINI.shown !== n.id;
  MINI.shown = n.id;
  // The head's numbers come live from its metric ticks; a worker's from its latest reading.
  const live = n.local && M.latest, total = n.inventory?.mem;
  const cpu = live ? M.latest.cpu : caCpu(n), mem = live ? M.latest.mem : caRam(n);
  const gb = (b) => (b / 2 ** 30).toFixed(1).replace(/\.0$/, '');
  const memText = mem == null ? '–' : total ? `${gb((total * mem) / 100)}/${gb(total)} GB` : fmtPct(mem);
  const put = (node, text) => { if (swap) { clearTimeout(node._swap); node._next = null; node.classList.remove('blur-out'); node.textContent = text; } else blurSwap(node, text); };
  put($('miniCpu'), cpu == null ? '–' : fmtPct(cpu));
  put($('miniMem'), memText);
  $('miniSum').textContent = `CPU ${cpu == null ? '–' : fmtPct(cpu)} · RAM ${mem == null ? '–' : fmtPct(mem)}`;
  setBar($('miniCpuBar'), cpu ?? 0);
  setBar($('miniMemBar'), mem ?? 0);
  if (swap || $('hostName').textContent !== (n.name || MINI.host)) { // also the head renamed once its node row arrives
    $('hostName').textContent = n.name || MINI.host;
    $('miniRole').hidden = !n.local;
    $('miniLive').hidden = !n.local; // the head's pulse is its live stream; a worker's numbers are its latest reading
    $('miniOs').innerHTML = OS_ICON[n.os] || OS_ICON.linux;
    $('miniOs').title = OS_NAME[n.os] || n.os || '';
  }
  const running = n.tasks?.length;
  $('miniTasks').textContent = running == null ? '' : running ? `${plural(running, 'task')} running` : 'Idle';
  $('miniOff').textContent = offline ? `+${offline} offline` : '';
  $('miniOff').title = offline ? MC.nodes.filter((m) => !m.local && m.enabled && !m.connected).map((m) => m.name).join(', ') : '';
  $('miniStats').setAttribute('aria-label', `Machine usage: ${n.name || MINI.host}, CPU ${cpu == null ? 'unknown' : fmtPct(cpu)}, `
    + `RAM ${mem == null ? 'unknown' : fmtPct(mem)}${offline ? `, ${offline} offline` : ''}. Open all machines`);
}
// With Server details closed only this card reads the machines: at most every 10 s, and not while the page is hidden.
function miniFetch() {
  if (MINI.fetch || document.hidden) return;
  MINI.fetch = setTimeout(() => { MINI.fetch = null; if (!document.hidden) loadMachines(); }, Math.max(0, MC.at + 10e3 - Date.now()));
}
$('miniMachine').addEventListener('mouseenter', () => { MINI.hold.add('hover'); miniArm(); });
$('miniMachine').addEventListener('mouseleave', () => { MINI.hold.delete('hover'); miniArm(); });
$('miniMachine').addEventListener('focusin', () => { MINI.hold.add('focus'); miniArm(); });
$('miniMachine').addEventListener('focusout', (e) => { if (!$('miniMachine').contains(e.relatedTarget)) { MINI.hold.delete('focus'); miniArm(); } });

// ----- plan usage -----
// Ideal pace: the share of a window's time already gone (1 h into a 5 h window = 20%). Usage over it (burning faster
// than time) marks dark orange, at or under it grey; no known future reset = no mark. test/ui-pace-line.test.mjs.
const paceWinMs = (w) => (/five_hour|(^|-)5h$|^5-hour$/.test(w || '') ? 5 * 3600e3 : 7 * 864e5);
const resetMs = (r) => (typeof r === 'number' ? (r < 1e12 ? r * 1000 : r) : r ? new Date(r).getTime() : NaN);
function paceMark(pct, resetsAt, lenMs, now = Date.now()) {
  const end = resetMs(resetsAt);
  if (pct == null || !(end > now)) return null;
  const ideal = Math.max(0, Math.min(100, ((lenMs - (end - now)) * 100) / lenMs)), over = pct > ideal;
  return { ideal, over, tip: `Pace: ${Math.round(ideal)}% by now · you're at ${Math.round(pct)}% (${Math.round(Math.abs(pct - ideal))}% ${over ? 'over' : 'under'})` };
}
function setPace(bar, m) {
  let p = bar.querySelector('.pace');
  if (!m) { p?.remove(); return; }
  if (!p) bar.append(p = el('b', 'pace'));
  p.style.left = `${m.ideal}%`;
  p.className = m.over ? 'pace over' : 'pace';
}
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
  renderModelPill(); // its usage dot follows the same readings
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
    const pace = w ? paceMark(w.pct, w.resetsAt, paceWinMs(w.id || w.label)) : null;
    setPace(bar, pace);
    row.title = [w?.tip, w?.resetsAt ? fmtReset(w.resetsAt) : '', pace?.tip].filter(Boolean).join('\n');
  });
  // The folded card's one line: the first two windows ("5h 31% · Wk 12%").
  const short = (l) => ({ '5-hour': '5h', Weekly: 'Wk' })[l] || l;
  $('usSum').textContent = windows.slice(0, 2).map((w, i) => `${short(w?.label || (i ? 'Weekly' : '5-hour'))} ${w?.pct != null ? fmtPct(w.pct) : '–'}`).join(' · ');
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
  miniRender();
  if (serverOpen()) renderMetrics();
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
  if (!serverOpen()) return;
  // The pulsing dot shows each update; the label only names the state.
  const text = !connected ? 'Reconnecting…' : late ? 'Waiting for data…' : 'Live';
  if ($('liveText').textContent !== text) $('liveText').textContent = text;
}
setInterval(updateLive, 1000);

// ----- server details (this server's own window: the controller's node detail) -----
// One block (index.html #serverDetails: device line, charts, running tasks, top processes) that renderServerDetails(container)
// mounts in the controller's node detail (the Machines view's side panel); parked in #sdStash otherwise, so its charts and
// listeners live on. Live refresh (metrics_sub) runs only while it's shown.
const serverOpen = () => !$('nodeModal').hidden && !$('sdStash').contains($('serverDetails'));
function renderServerDetails(container) {
  const was = serverOpen();
  container.append($('serverDetails'));
  if (was) return;
  buildMetrics();
  send({ t: 'metrics_sub', on: true });
  renderUsage();
  renderRangePicker();
  renderMetrics();
  loadHistory();
  updateLive();
  loadMachines();
}
function parkServerDetails() {
  if ($('sdStash').contains($('serverDetails'))) return;
  const was = serverOpen();
  $('sdRun').replaceChildren(); // its Running here belongs to that open
  $('sdStash').append($('serverDetails'));
  if (was) send({ t: 'metrics_sub', on: false });
}
// Anything that shows "this server" opens the Machines view on the controller's detail.
function openServer() {
  closeSidebar();
  openNode(MC.nodes.find((n) => n.local)?.id || 'controller');
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
$('miniStats').addEventListener('click', miniClick);
setInterval(() => { if (M.usage) renderUsage(); }, 30e3); // keep the "in 2h 9m" countdowns current

// ----- machines (cluster nodes) and the "Add machine" wizard -----
// One card per node from GET /api/cluster/nodes (cluster.mjs view + orchestrator `machines`: running tasks, work slots in
// use and the node's slot count). While the Machines view is open it re-reads on 'cluster' pushes (node changes, worker
// CPU/RAM readings), task changes and, for the controller's own numbers, its metric ticks (at most every 10 s).
// "Add machine": POST /api/cluster/pair → a one-time code, or {uses: N} → one code for N machines (valid 1 h), embedded in
// a one-line install command per OS (bin/install-worker*.sh, served at /install/…). GET /api/cluster/pair/:code then
// reports waiting → paired (node; a multi-use code: nodes, used) → node.connected; DELETE revokes the code.
const AM = { code: null, expiresAt: 0, uses: 1, pairing: null, err: '', timer: null, lastFocus: null };
const AM_USES = [1, 2, 3, 4, 5, 6, 8, 10];
// open: the cards whose Machine settings are open; stale: a render skipped while a finish sound menu was in use.
// pings: node id → the owner's last Ping ({busy} | {r: the answer} | {error}), shown under the node until it fades (pingBox).
// soundAdd: the node whose Finish sound row shows the add-a-custom-sound form.
// target: the version workers update to ({sha, build, version}); rollout: the owner's Update all in progress (cluster.mjs).
const MC = { nodes: [], at: 0, raf: 0, cards: new Map(), timer: null, loading: false, open: new Set(), stale: false, pings: new Map(), soundAdd: null, target: null, rollout: null };
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
  const was = MC.rollout;
  try {
    const d = await api('/api/cluster/nodes');
    Object.assign(MC, { nodes: d.nodes || [], target: d.target || null, rollout: d.rollout || null, at: Date.now() });
  } catch { return; } finally { MC.loading = false; }
  if (was && !was.doneAt && MC.rollout?.doneAt && MC.rollout.startedAt === was.startedAt) toast(rolloutSummary(MC.rollout), { duration: 8000 });
  setMachineSounds(MC.nodes);
  mcPaint();
}
// Live readings arrive in bursts (a push per worker, task changes): their DOM writes land together in the next frame.
function mcPaint() {
  if (MC.raf) return;
  MC.raf = requestAnimationFrame(() => { MC.raf = 0; renderMachines(); miniRender(); });
}
// Coalesces bursts (task updates, pushes) into one read while the Machines view is open.
function scheduleMachines(ms = 600) {
  if (!mxOpen()) return miniFetch();
  if (MC.timer) return;
  MC.timer = setTimeout(() => { MC.timer = null; if (mxOpen()) loadMachines(); }, ms);
}
// Online / Draining / Disabled while connected; away: Connection lost (silent, no bye), Shut down (bye), Asleep (a legacy
// row: a sleep is only known after the fact, from the worker's reconnect), else Offline.
// Updating: waiting to be idle for its self-update, or restarting into it.
function nodeState(n) {
  if (!n.enabled) return { dot: '', label: 'Disabled' };
  if (['pending', 'sent'].includes(n.update?.state) && !n.draining) return { dot: 'warn', label: 'Updating' };
  if (!n.connected) return n.away === 'asleep' ? { dot: '', label: 'Asleep' } : n.away === 'bye' ? { dot: '', label: 'Shut down' } : { dot: 'off', label: cap(n.awayLabel || 'offline') };
  if (n.draining) return { dot: 'warn', label: 'Draining' };
  return { dot: 'on', label: 'Online' };
}
// 'Cluster: 3 machines · 7 cores · 14.2 GB free · 4 of 6 slots running': machines that are connected and enabled.
function machineSummary(nodes) {
  const up = nodes.filter((n) => n.connected && n.enabled), sum = (f) => up.reduce((a, n) => a + (f(n) || 0), 0);
  const used = sum((n) => n.used), slots = sum((n) => (n.draining ? n.used : Math.max(n.slots || 0, n.used)));
  const off = nodes.filter((n) => n.enabled && !n.connected).length, dis = nodes.filter((n) => !n.enabled).length;
  return [`Cluster: ${plural(up.length, 'machine')}`, plural(sum((n) => n.inventory?.cores), 'core'), `${fmtGB(sum((n) => n.resources?.memAvailable))} free`,
    `${used} of ${plural(slots, 'slot')} running`, off && `${off} offline`, dis && `${dis} disabled`].filter(Boolean).join(' · ');
}
function renderMachines() {
  caSync(MC.nodes);
  $('mxDiagBtn').hidden = $('caWrap').hidden;
  if (ND.id) ndRender();
  mxLanesRender();
  mcRender();
}
// Where the full machine cards live (#mMachines): on a phone all of them under the diagram; from 768px only the open
// machine's, in its side panel's Machine section (its settings, health, ping, agents, updates), else parked.
function mcHome() {
  const ul = $('mMachines'), wide = CA_WIDE.matches, sec = ND.els?.machine;
  if (sec) sec.hidden = !wide;
  const to = !wide ? $('mxMain') : ND.id && sec ? sec : $('sdStash');
  if (ul.parentNode !== to) to.append(ul);
}
function mcRender() {
  mcHome();
  // A menu in use (a finish sound, the add-a-sound URL) isn't replaced under the owner's finger: the render waits until it loses focus.
  if (document.activeElement?.matches?.('#mMachines select, #mMachines .snd-add input')) { MC.stale = true; return; }
  MC.stale = false;
  const nodes = MC.nodes;
  $('mcSum').textContent = nodes.length ? machineSummary(nodes) : '';
  $('mxSum').textContent = nodes.length ? phoneSummary(nodes) : '';
  const remote = nodes.some((n) => !n.local);
  $('pingAll').hidden = !remote;
  const ua = updateAllLabel(nodes, MC.target, MC.rollout);
  $('updateAll').hidden = !remote && !ua.count;
  $('updateAll').textContent = ua.text;
  $('updateAll').disabled = ua.disabled;
  $('updateAll').title = ua.title;
  // Live re-renders keep keyboard focus on the same control of the same card.
  const f = document.activeElement, card = f?.closest?.('#mMachines .mc-node'), key = (b) => b.dataset.act || b.dataset.task || b.textContent;
  const was = card && f.matches('button, summary, input') && [card.dataset.node, key(f)];
  // A card whose machine didn't change keeps its nodes (no relayout under a scrolling finger); relative times refresh each minute.
  const era = [Math.floor(Date.now() / 60e3), AS.node, CA_WIDE.matches, VER.running?.build, JSON.stringify([MC.target, MC.rollout])].join('|'), cards = new Map();
  const cardOf = (n) => {
    const key = MC.pings.has(n.id) || MC.soundAdd === n.id ? null : `${era}|${nodeKey(n)}`, old = MC.cards.get(n.id);
    const li = key && old?.key === key ? old.li : machineCard(n);
    cards.set(n.id, { key, li });
    return li;
  };
  const list = (CA_WIDE.matches ? nodes.filter((n) => n.id === ND.id) : nodes).map(cardOf), box = $('mMachines');
  if (list.length !== box.children.length || list.some((li, i) => box.children[i] !== li)) box.replaceChildren(...list);
  MC.cards = cards;
  if (was) [...$('mMachines').querySelectorAll(`.mc-node[data-node="${CSS.escape(was[0])}"] :is(button, summary, input)`)].find((b) => key(b) === was[1])?.focus({ preventScroll: true });
}
// What a machine's card shows, as a string: heartbeats only move lastSeen, which the card shows as a relative time.
const nodeKey = (n) => JSON.stringify({ ...n, lastSeen: n.lastSeen && relTime(n.lastSeen) });
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
// ----- Machines on phones (<768px, #433) -----
// Each card is one button (.mc-open; the rest of the card is hidden there): name, OS, status and build, CPU and memory
// ring gauges side by side, and one line of what runs ('3 running · #412, #418…'). A tap pushes the machine's detail
// page (#nodeModal as a full-screen page with a back button and edge swipe: charts, running, recent history, settings).
const PHONE_MQ = matchMedia('(max-width: 767px)');
const isPhone = () => PHONE_MQ.matches;
// CPU as a % of the whole machine (its per-core readings, else the 1-min load over its cores) and memory in use.
function nodeUsage(n) {
  const inv = n.inventory || {}, res = n.resources || {};
  const cpu = Array.isArray(res.cpu) && res.cpu.length ? res.cpu.reduce((a, c) => a + (Number(c) || 0), 0) / res.cpu.length
    : res.load?.[0] != null && inv.cores ? (res.load[0] / inv.cores) * 100 : null;
  const mem = inv.mem && res.memAvailable != null ? Math.max(0, (1 - res.memAvailable / inv.mem) * 100) : null;
  return { cpu: cpu == null ? null : Math.min(100, Math.max(0, cpu)), mem };
}
// A ring gauge: the value in the middle, its label beside it ('CPU', '4 cores'); warn ≥ 75%, crit ≥ 90%.
function ringGauge(label, pct, sub) {
  const g = el('span', 'mo-gauge'), r = 15, c = 2 * Math.PI * r, v = pct == null ? null : Math.round(pct);
  const tone = v == null ? 'none' : v >= 90 ? 'crit' : v >= 75 ? 'warn' : '';
  g.innerHTML = `<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="mo-track" cx="18" cy="18" r="${r}"/><circle class="mo-arc ${tone}" cx="18" cy="18" r="${r}" stroke-dasharray="${((v || 0) / 100) * c} ${c}"/></svg>`;
  const t = el('span', 'mo-gt');
  t.append(el('span', 'mo-gv', v == null ? '–' : `${v}%`), el('span', 'mo-gl', label));
  if (sub) t.append(el('span', 'mo-gl mo-gs', sub));
  g.append(t);
  g.setAttribute('role', 'img');
  g.setAttribute('aria-label', `${label} ${v == null ? 'not reported' : `${v}%`}${tone === 'crit' ? ', very high' : tone === 'warn' ? ', high' : ''}`);
  return g;
}
// '3 running · #412, #418…' (two ids, then an ellipsis); 'Idle' / 'Nothing running'.
function runLine(n) {
  const tasks = n.tasks || [];
  if (!tasks.length) return n.connected && n.enabled && !n.draining ? 'Idle' : 'Nothing running';
  return `${tasks.length} running · ${tasks.slice(0, 2).map((t) => `#${t.id}`).join(', ')}${tasks.length > 2 ? '…' : ''}`;
}
function mcOpen(n, st) {
  const b = el('button', 'mc-open'), top = el('span', 'mo-top'), icon = el('span', 'mc-os'), id = el('span', 'mo-id'), pill = el('span', 'mc-st');
  b.type = 'button';
  b.dataset.act = 'open';
  icon.innerHTML = OS_ICON[n.os] || OS_ICON.linux;
  id.append(el('span', 'mo-name', n.name), el('span', 'mo-meta', [n.local ? 'This server' : OS_NAME[n.os] || n.os, n.build && fmtVersion(n.build)].filter(Boolean).join(' · ')));
  pill.append(el('span', `dot ${st.dot}`), document.createTextNode(st.label));
  top.append(icon, id, pill, el('span', 'mo-chev'));
  const u = nodeUsage(n), cores = n.inventory?.cores, mem = n.inventory?.mem, gauges = el('span', 'mo-gauges');
  gauges.append(ringGauge('CPU', u.cpu, cores && plural(cores, 'core')), ringGauge('Memory', u.mem, mem && `${Math.round(mem / 2 ** 30)} GB`));
  const run = el('span', `mo-run${n.tasks?.length ? ' on' : ''}`, runLine(n));
  b.append(top, gauges, run);
  b.setAttribute('aria-label', `${n.name}, ${st.label}. ${runLine(n)}. Open details`);
  b.addEventListener('click', () => openNode(n.id));
  return b;
}
// 'Machines' summary on phones: '3 of 4 online · 7 running · 9 free slots'.
function phoneSummary(nodes) {
  const up = nodes.filter((n) => n.connected && n.enabled);
  const running = nodes.reduce((a, n) => a + (n.tasks?.length || 0), 0);
  const free = up.filter((n) => !n.draining && n.status !== 'paused').reduce((a, n) => a + Math.max(0, (n.slots || 0) - (n.used || 0)), 0);
  return `${up.length} of ${plural(nodes.length, 'machine')} online · ${running} running · ${plural(free, 'free slot')}`;
}
// From 768px it shows only in the machine's side panel, whose charts and Running here stand in for its meters and tasks.
// A Chrome runner whose Claude is signed out (its inventory reported, no signed-in Claude): what the owner must do, else
// null. chrome.mjs runnerSignIn says the same on the server (the Browser tab's setup card); a runner queues nothing until then.
function runnerSignIn(n) {
  const inv = n?.inventory || {};
  if (!inv.chromeRunner || !inv.agents || inv.agents.some((a) => a.id === 'claude' && a.installed && a.signedIn)) return null;
  return `Sign in to Claude on ${String(n.name || n.id || 'the Mac').replace(/^chrome on /i, '')} as yourself: run \`claude\` in Terminal`;
}
function machineCard(n) {
  const li = el('li', 'm-card mc-node'), st = nodeState(n), inv = n.inventory || {}, res = n.resources || {}, brief = CA_WIDE.matches;
  li.dataset.node = n.id;
  if (!n.connected || !n.enabled) li.classList.add('away');
  li.append(mcOpen(n, st));
  const top = el('div', 'mc-top'), icon = el('span', 'mc-os'), id = el('div', 'mc-id'), name = el('span', 'mc-name', n.name);
  icon.innerHTML = OS_ICON[n.os] || OS_ICON.linux;
  icon.title = OS_NAME[n.os] || n.os || '';
  if (n.local) name.append(el('small', '', '(this server)'));
  if (n.build) name.append(el('small', 'mc-build', fmtVersion(n.build)));
  // Behind the head's origin/main (or, while that count is unknown, an older build than the one running here).
  if (!n.local && (n.behind > 0 || (n.behind == null && n.build && VER.running?.build && n.build < VER.running.build))) name.append(el('span', 'tc-tag outdated', 'outdated'));
  const seen = n.local ? 'controller' : n.lastSeen ? `${n.connected ? 'seen' : 'last seen'} ${relTime(n.lastSeen)}` : 'never connected';
  id.append(name, el('span', 'mc-meta', [OS_NAME[n.os] || n.os, n.arch, seen].filter(Boolean).join(' · ')));
  const pill = el('span', 'mc-st');
  pill.append(el('span', `dot ${st.dot}`), document.createTextNode(st.label));
  top.append(icon, id, pill);
  li.append(top);

  const load = res.load?.[0];
  if (inv.cores && !brief) li.append(mcMeter('CPU', [{ b: String(inv.cores) }, ` ${inv.cores === 1 ? 'core' : 'cores'}`, ...(load != null ? [' · load ', { b: load.toFixed(2) }] : [])],
    load != null ? (load / inv.cores) * 100 : null));
  if (inv.mem && res.memAvailable != null && !brief) {
    const used = Math.max(0, inv.mem - res.memAvailable);
    li.append(mcMeter('RAM', [{ b: fmtGB(used) }, ' used · ', { b: fmtGB(res.memAvailable) }, ` free of ${fmtGB(inv.mem)}`], (used / inv.mem) * 100));
  }
  if (res.disk?.total && !brief) {
    const used = Math.max(0, res.disk.total - res.disk.free);
    li.append(mcMeter('Disk', [{ b: fmtGB(res.disk.free) }, ` free of ${fmtGB(res.disk.total)}`], (used / res.disk.total) * 100));
  }
  if (!inv.cores && res.memAvailable == null) li.append(el('p', 'mc-idle', 'No readings yet: they arrive once its worker connects.'));
  const pool = !n.local && poolLine(n);
  if (pool) li.append(pool);
  const health = machineHealth(n);
  if (health.length) li.append(...health);
  const ping = !n.local && !isPhone() && pingBox(n); // phones show it on the detail page
  if (ping) li.append(ping);

  const ag = el('div', 'mc-agents'), signed = (inv.agents || []).filter((a) => a.signedIn);
  for (const a of signed) {
    const t = el('span', 'tc-tag on', agentLabel(a.id));
    if (a.account) t.title = `Signed in as ${a.account}`;
    ag.append(t);
  }
  if (!signed.length) ag.append(el('span', 'mc-idle', runnerSignIn(n) || (inv.agents ? 'No agents signed in' : 'Agents not reported yet')));
  li.append(ag);
  if (brief) {
    if (canUpdate(n)) li.append(updateButton(n));
    li.append(machineSettings(n));
    return li;
  }

  // Running tasks (plan tasks too, though they hold no work slot); tap one for its drawer. This server splits its slots:
  // 'Integrating 2 · Work 1/4' (the reserved ones for integrators and reflection, then its work slots in use).
  const run = el('div', 'mc-run'), h = el('h4'), hd = n.head;
  if (hd) {
    h.append(document.createTextNode('Integrating '), el('b', '', String(hd.reserved)), document.createTextNode(' · Work '), el('b', '', `${hd.workUsed}/${hd.work}`));
    h.title = `${plural(hd.reserved, 'slot')} kept for integrators and reflection (${hd.integrating} running), ${hd.workUsed} of ${plural(hd.work, 'work slot')} in use. ` +
      `Sized from its ${plural(hd.cores, 'core')}: one per core, at least 4 work slots, plus integration slots. Work spreads across eligible machines.`;
  } else h.append(document.createTextNode('Running · '), el('b', '', `${n.used} of ${n.slots ?? 0}`), document.createTextNode(` ${n.slots === 1 ? 'slot' : 'slots'}`));
  run.append(h);
  const tasks = n.tasks || [];
  if (!tasks.length) run.append(el('p', 'mc-idle', n.connected && n.enabled && !n.draining ? 'Idle' : 'Nothing running'));
  const list = el('div', 'mc-tasks');
  for (const t of tasks) list.append(mcTaskRow(t));
  if (tasks.length) run.append(list);
  run.append(renderAssignButton(n));
  if (canUpdate(n)) run.append(updateButton(n));
  li.append(run);
  li.append(machineSettings(n));
  return li;
}
// A running task's row (machine cards, a machine's detail, the queue's lanes): its title, '#id · project · agent · model
// · step' and how long it has run (ticking while the Machines view is open). A tap opens its drawer over the view.
function mcTaskRow(t) {
  const b = el('button', 'mc-task'), main = el('span');
  b.type = 'button';
  b.dataset.task = t.id;
  main.append(el('span', 't', displayTitle(t)), el('span', 's', [`#${t.id}`, t.project, `${shortLabel(t.agent)} · ${modelName(t.agent, t.model)}`,
    t.phase && t.phase !== 'running' ? PHASE_DOING[t.phase] : ''].filter(Boolean).join(' · ')));
  const e = el('span', t.waiting_for ? 'e wait' : 'e', t.waiting_for ? 'waiting' : fmtDur(Date.now() / 1000 - t.started_at));
  e.title = t.waiting_for ? `Waiting for ${t.waiting_for} to come back` : 'Running for';
  if (!t.waiting_for) e.dataset.started = t.started_at;
  b.append(main, e);
  b.addEventListener('click', () => openTask(t.id));
  return b;
}
// A worker's local cap (`node worker.mjs limit` on that machine, cap.mjs; the scheduler never gives it more), from its
// latest reading: 'Pooled: 4 cores · 8 GB (set on this Mac)'. Parts it doesn't cap show the machine's whole.
function poolLine(n) {
  const res = n.resources || {}, inv = n.inventory || {}, c = 'cap' in res ? res.cap : inv.cap;
  if (!c) return null;
  const cores = c.cpu ?? inv.cores, mem = c.mem ?? inv.mem;
  const parts = [cores != null && `${+Number(cores).toFixed(2)} ${cores === 1 ? 'core' : 'cores'}`, mem != null && `${+(mem / 2 ** 30).toFixed(1)} GB`,
    c.maxTasks != null && `at most ${plural(c.maxTasks, 'task')}`].filter(Boolean);
  const p = el('p', 'mc-health mc-pool', `Pooled: ${parts.join(' · ')} (set on this ${n.os === 'darwin' ? 'Mac' : 'machine'})`);
  p.title = "This machine's own cap on what it lends the cluster (node worker.mjs limit, run on it). The scheduler never gives it more.";
  return p;
}
// A running remote task's step on its card ('installing deps'; nothing extra while the agent itself runs).
const PHASE_DOING = { queued: 'starting', cloning: 'cloning', fetching: 'fetching', installing: 'installing deps', checking: 'checking', committing: 'committing', pushing: 'pushing', done: 'finishing' };
// What the owner should know about a machine's health, one short line each: its last placement decision (why it got a
// task or was skipped), why it was drained automatically, an update (waiting, restarting, failed) or how far behind it
// is, its last error today, a Mac's battery and thermal state (information only: they never decide placement) and
// whether it is kept awake for its tasks, GitHub out of reach.
function machineHealth(n) {
  const out = [], res = n.resources || {}, line = (cls, text, title) => { const p = el('p', `mc-health ${cls}`, text); if (title) p.title = title; out.push(p); };
  const d = n.lastDecision;
  if (d?.text) line(`mc-decision${d.ok ? '' : ' warn'}`, `Placement: ${d.text}${d.at ? ` · ${relTime(d.at * 1000)}` : ''}`,
    'The scheduler skips a machine only when its CPU is saturated for a minute, its agent is signed out, or it is full, draining or disabled');
  if (n.drainReason) line('warn', `Drained automatically${n.drainedAt ? ` ${relTime(n.drainedAt)}` : ''}: ${n.drainReason}. Turn on Machine settings → Run tasks on this machine when that's fixed.`);
  const paused = n.status === 'paused' ? res.intake?.reason : null;
  if (paused) line('warn', `${res.intake.text}. Its running tasks go on.`);
  const u = n.update, ro = n.rollout;
  if (ro) out.push(rolloutLine(n, MC.target));
  else if (u?.state === 'pending') line('', 'Updates itself once its running tasks finish; it takes no new ones meanwhile.');
  else if (u?.state === 'sent') line('', 'Updating: pulling the latest agent-orch and restarting…');
  else if (u?.state === 'failed') line('bad', `Update failed: ${u.error}`);
  else if (n.outdated) line('warn', `${plural(n.behind, 'commit')} behind this server's agent-orch`);
  const e = n.lastError;
  if (e && Date.now() - e.at < 86400e3 && e.kind !== 'update') line('bad', `Error ${relTime(e.at)}: ${e.message}`, [e.kind, e.stderr || e.stack].filter(Boolean).join('\n\n'));
  const bat = res.battery, th = res.thermal;
  if (bat) line(bat.pct < 20 && !bat.charging ? 'warn' : '', `Battery ${bat.pct}%${bat.charging ? ' · charging' : bat.source === 'ac' ? ' · on power' : ''}`);
  if (th?.pressure === 'throttled') line('warn', th.speedLimit != null ? `Running hot: CPU limited to ${th.speedLimit}%` : 'Running hot: the CPU is throttled');
  if (res.awake && n.connected) line('', 'Kept awake while its tasks run');
  if (res.net && !res.net.ok && n.connected) line('warn', `Can't reach ${res.net.host === 'github.com' ? 'GitHub' : res.net.host}${res.net.error ? ` (${res.net.error})` : ''}: it can't clone or push`);
  for (const [cls, text, title] of dropLines(n)) line(cls, text, title);
  return out;
}
// A worker's connection drops over the last 24 h (cluster.mjs node_drops): the latest reconnect and its reason, then
// the count by reason ('Connection drops today: 4 (DNS 3, sleep 1)'). Returns [cls, text, title] lines.
const DROP_WHY = { dns: 'DNS lookup of the head failed', network: 'the network was down', asleep: 'it was asleep', lost: 'no reason reported' };
const DROP_NAME = { dns: 'DNS', network: 'network', asleep: 'sleep', lost: 'unexplained' };
const fmtMin = (ms) => (ms < 60e3 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3600e3 ? `${Math.round(ms / 60e3)} min` : `${Math.floor(ms / 3600e3)} h ${Math.round((ms % 3600e3) / 60e3)} min`);
function dropLines(n) {
  const d = n.drops, l = d?.last;
  if (!d?.total) return [];
  const out = [];
  if (l.back && l.reason !== 'lost') out.push(['', `Reconnected after ${fmtMin(l.back - l.at)}: ${l.reason === 'asleep' && n.os === 'darwin' ? 'the Mac was asleep' : DROP_WHY[l.reason] || l.reason}`, l.error || '']);
  const order = Object.keys(DROP_NAME), by = Object.entries(d.by).sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0])).map(([r, c]) => `${DROP_NAME[r] || r} ${c}`);
  out.push([d.total >= 3 ? 'warn' : '', `Connection drops today: ${d.total} (${by.join(', ')})`, 'Connections this machine lost without saying goodbye in the last 24 hours, by the reason its worker reported on reconnect.']);
  return out;
}
// ----- ping result -----
// The owner's Ping (POST /api/cluster/nodes/:id/ping; cluster.mjs ping, pingReport), per worker card and 'Ping all' in
// the Machines header, shown under the node as a chip group (pingBox): the round trip ('84 ms'), then one pill per check
// (pingChecks: DNS, Head, Git, GitHub) with a status dot (ok; warn: over PING_SLOW ms; bad: failed), its label and time,
// its full text as the tooltip. No answer, an error or a disconnected machine: one red pill and a one-line hint. The
// details (every check in words, the hints, the last connection error; a disconnected machine's last drop, its drops
// today and a command to test the head from there) open on a tap. It fades out and collapses PING_MS after the answer
// (removed at once under prefers-reduced-motion), paused while hovered, focused or open; pinging again replaces it.
// A MC.pings entry: {busy} | {r} | {error}, plus box (kept across renders), left (ms to go), t0, timer, fading, holds, open.
const PING_MS = 10000, PING_SLOW = 500, PING_FADE = 250;
async function pingNode(n) {
  if (MC.pings.get(n.id)?.busy) return;
  pingDrop(n.id);
  MC.pings.set(n.id, { busy: true });
  renderMachines();
  let p;
  try { p = { r: await api(`/api/cluster/nodes/${encodeURIComponent(n.id)}/ping`, 'POST') }; } catch (e) { p = { error: e.message }; }
  MC.pings.set(n.id, Object.assign(p, { left: PING_MS, holds: new Set(), open: false }));
  renderMachines();
  pingArm(n.id);
}
$('pingAll').addEventListener('click', () => { for (const n of MC.nodes) if (!n.local) pingNode(n); });
function pingDrop(id) {
  const p = MC.pings.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  clearTimeout(p.fading);
  p.box?.remove();
  MC.pings.delete(id);
}
function pingArm(id) {
  const p = MC.pings.get(id);
  if (!p?.holds || p.timer || p.fading || p.holds.size) return;
  p.t0 = Date.now();
  p.timer = setTimeout(() => pingFade(id, p), p.left);
}
// why: 'hover', 'focus' or 'open'. Holding stops the clock (and a fade under way); the last release restarts it.
function pingHold(id, p, why, on) {
  if (MC.pings.get(id) !== p) return;
  if (!on) { p.holds.delete(why); pingArm(id); return; }
  p.holds.add(why);
  if (p.timer) { clearTimeout(p.timer); p.timer = null; p.left = Math.max(0, p.left - (Date.now() - p.t0)); }
  if (p.fading) { clearTimeout(p.fading); p.fading = null; p.left = Math.max(p.left, 2000); p.box?.classList.remove('out'); }
}
function pingFade(id, p) {
  p.timer = null;
  p.left = 0;
  if (MC.pings.get(id) !== p) return;
  const gone = () => { p.fading = null; pingDrop(id); };
  if (!p.box || matchMedia('(prefers-reduced-motion: reduce)').matches) return gone();
  p.box.classList.add('out');
  p.fading = setTimeout(gone, PING_FADE);
}
// A connected answer's checks, in pingReport's order (so parts[i + 1] is each one's words): {label, ms, state, title}.
function pingChecks(r) {
  const d = r.diag || {}, out = [], ms = (x) => (Number.isFinite(x?.ms) ? Math.round(x.ms) : null);
  const add = (label, x, ok) => out.push({ label, ms: ms(x), state: !ok ? 'bad' : ms(x) > PING_SLOW ? 'warn' : 'ok' });
  if (d.dns) add('DNS', d.dns, d.dns.ok);
  if (d.head) add('Head', d.head, d.head.ok && d.head.status >= 200 && d.head.status < 400);
  if (d.git) add('Git', d.git, d.git.ok);
  if (d.github && !d.github.skipped) add('GitHub', d.github, d.github.ok);
  out.forEach((c, i) => { c.title = `${r.parts?.[i + 1]?.text || c.label}${c.state === 'warn' ? ' · slow' : ''}`; });
  return out;
}
function pingBox(n) {
  const p = MC.pings.get(n.id), r = p?.r;
  if (!p || (r && r.connected !== n.connected)) return null; // it came back (or went away) since: that answer is stale
  return (p.box ||= pingChip(n, p));
}
function pingChip(n, p) {
  const r = p.r, box = el('div', 'mc-ping'), clip = el('div', 'pg-clip'), body = el('div', 'pg-body'), row = el('div', 'pg-row');
  box.setAttribute('role', 'status');
  box.append(clip);
  clip.append(body);
  body.append(row);
  if (p.busy) { row.append(el('span', 'pg-wait', 'Pinging…')); return box; }
  const pill = (state, label, ms, title) => {
    const x = el('span', `pg-pill ${state}`);
    x.append(el('i', 'pg-dot'), el('span', 'pg-l', label));
    if (ms != null) x.append(el('span', 'pg-ms', `${ms} ms`));
    x.title = title || label;
    row.append(x);
  };
  const det = el('div', 'pg-det'), line = (cls, text) => det.append(el('p', `mc-health ${cls}`, text));
  let hint = '', worst = 'bad';
  if (p.error) {
    pill('bad', p.error === 'no answer' ? 'No answer' : 'Failed', null, `Ping: ${p.error}`);
    hint = p.error === 'no answer' ? 'Its worker did not reply within 8 s' : p.error;
  } else if (r.connected) {
    const checks = pingChecks(r), rtt = el('span', 'pg-rtt', `${r.rtt} ms`);
    rtt.title = 'Round trip';
    row.append(rtt);
    for (const c of checks) pill(c.state, c.label, c.ms, c.title);
    worst = ['bad', 'warn'].find((s) => checks.some((c) => c.state === s)) || 'ok';
    line('', (r.parts || []).map((x) => x.text).join(' · '));
    for (const h of r.hints || []) line('bad', h);
    const c = r.diag?.conn;
    if (c?.lastError) line('', `Last connection error ${relTime(c.lastErrorAt)}: ${c.lastError}`);
  } else {
    pill('bad', 'Not connected');
    hint = [r.lastSeen ? `Last seen ${relTime(r.lastSeen)}` : 'Never connected', r.awayLabel].filter(Boolean).join(' · ');
    if (r.reason) line('', `Last drop ${relTime(r.reason.at)}: ${r.reason.reason === 'asleep' && n.os === 'darwin' ? 'the Mac was asleep' : DROP_WHY[r.reason.reason] || r.reason.reason}${r.reason.error ? ` (${r.reason.error})` : ''}`);
    if (r.drops?.total) line(r.drops.total >= 3 ? 'warn' : '', `Drops in the last 24 h: ${r.drops.total} (${Object.entries(r.drops.by).map(([k, v]) => `${DROP_NAME[k] || k} ${v}`).join(', ')})`);
    if (r.command) {
      line('', `To test the head from ${n.os === 'darwin' ? 'that Mac' : 'that machine'}, run this in its Terminal:`);
      const cmd = el('div', 'mc-cmd'), code = el('code', '', r.command), copy = el('button', 'btn small', 'Copy');
      copy.type = 'button';
      copy.dataset.act = 'copy-ping';
      copy.addEventListener('click', async () => { copy.textContent = (await copyToClipboard(r.command)) ? 'Copied' : 'Copy failed'; });
      cmd.append(code, copy);
      det.append(cmd);
    }
  }
  box.classList.add(worst);
  if (hint) {
    const h = el('p', 'pg-hint', hint);
    h.title = hint;
    body.append(h);
  }
  if (det.children.length) {
    const more = el('button', 'pg-more');
    more.type = 'button';
    more.dataset.act = 'ping-more';
    more.setAttribute('aria-label', 'Ping details');
    more.setAttribute('aria-expanded', 'false');
    more.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    row.append(more);
    row.classList.add('tap');
    det.hidden = true;
    body.append(det);
    row.addEventListener('click', () => {
      p.open = !p.open;
      det.hidden = !p.open;
      more.setAttribute('aria-expanded', String(p.open));
      box.classList.toggle('open', p.open);
      pingHold(n.id, p, 'open', p.open);
    });
  }
  box.addEventListener('mouseenter', () => pingHold(n.id, p, 'hover', true));
  box.addEventListener('mouseleave', () => pingHold(n.id, p, 'hover', false));
  box.addEventListener('focusin', () => pingHold(n.id, p, 'focus', true));
  box.addEventListener('focusout', (e) => { if (!box.contains(e.relatedTarget)) pingHold(n.id, p, 'focus', false); });
  return box;
}
// ----- assign a task (the 'Assign task' button on every machine card and machine detail) -----
// renderAssignButton(node) opens a picker titled 'Run on <machine> now' (a popover by the button; a bottom sheet on
// phones) listing GET /api/cluster/nodes/:id/assignable → {tasks}: the queued tasks with no unfinished prerequisite.
// A row (click, tap or Enter) → POST /api/orch/tasks/:id/assign {node}: success closes it with a toast (' · CPU busy'
// when the answer carries a warning) and re-reads the machines; a refusal (409) shows its reason in that row.
// AS: node/name (the machine it is open for), tasks (null while loading), errs (task id → why it was refused), busy (the
// task being posted), q (the search), seq (drops answers for a picker since closed), the parts, and rows (shown rows).
const AS = { node: null, name: '', tasks: null, err: '', errs: new Map(), busy: null, q: '', seq: 0, layer: null, pop: null, list: null, search: null, close: null, anchor: null, rows: [] };
const URGENCY_WORD = { urgent: 'Urgent', normal: 'Normal', background: 'Later' };
const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function renderAssignButton(n) {
  const b = el('button', 'btn small as-btn', 'Assign task');
  b.type = 'button';
  b.dataset.act = 'assign';
  b.dataset.node = n.id;
  b.setAttribute('aria-haspopup', 'dialog');
  b.setAttribute('aria-expanded', String(AS.node === n.id));
  b.disabled = !n.connected;
  b.title = n.connected ? `Pick a ready task and start it on ${n.name} now` : `${n.name} is offline: tasks can start there once it reconnects`;
  b.addEventListener('click', () => (AS.node === n.id ? closeAssign() : openAssign(n, b)));
  return b;
}
function openAssign(n, anchor) {
  closeAssign(false);
  const layer = el('div', 'as-layer'), scrim = el('div', 'as-scrim'), pop = el('div', 'as-pop'), head = el('div', 'as-head'), h = el('h3', '', `Run on ${n.name} now`);
  const x = el('button', 'icon-btn as-x'), search = el('input', 'as-search'), list = el('div', 'as-list'), grip = el('div', 'sheet-grip');
  h.id = 'asTitle';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true');
  pop.setAttribute('aria-labelledby', 'asTitle');
  pop.tabIndex = -1;
  grip.setAttribute('aria-hidden', 'true');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.innerHTML = CLOSE_SVG;
  search.type = 'search';
  search.placeholder = 'Search ready tasks';
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search ready tasks');
  head.append(h, x);
  pop.append(grip, head, search, list);
  layer.append(scrim, pop);
  scrim.addEventListener('click', () => closeAssign());
  x.addEventListener('click', () => closeAssign());
  search.addEventListener('input', () => { AS.q = search.value; renderAssign(); });
  pop.addEventListener('keydown', assignKey);
  Object.assign(AS, { node: n.id, name: n.name, tasks: null, err: '', errs: new Map(), busy: null, q: '', seq: AS.seq + 1, layer, pop, list, search, close: x, anchor, rows: [] });
  anchor.setAttribute('aria-expanded', 'true');
  layer.classList.toggle('sheet', phoneMQ.matches);
  document.body.append(layer);
  renderAssign();
  if (!phoneMQ.matches) placeMenu(pop, anchor);
  (phoneMQ.matches ? pop : search).focus({ preventScroll: true }); // a phone's keyboard stays down until the owner taps Search
  void loadAssignable();
}
function closeAssign(refocus = true) {
  const { layer, anchor, node } = AS;
  if (!layer) return;
  Object.assign(AS, { node: null, seq: AS.seq + 1, layer: null, pop: null, list: null, search: null, close: null, anchor: null, rows: [] });
  layer.remove();
  anchor.setAttribute('aria-expanded', 'false');
  // A live re-render may have replaced the button meanwhile: focus its successor.
  if (refocus) (anchor.isConnected ? anchor : document.querySelector(`.as-btn[data-node="${CSS.escape(node)}"]`))?.focus({ preventScroll: true });
}
async function loadAssignable() {
  const seq = AS.seq;
  try {
    const d = await api(`/api/cluster/nodes/${encodeURIComponent(AS.node)}/assignable`);
    if (seq !== AS.seq) return;
    AS.tasks = d.tasks || [];
  } catch (e) {
    if (seq !== AS.seq) return;
    Object.assign(AS, { tasks: [], err: e.message });
  }
  renderAssign();
  if (!phoneMQ.matches && AS.anchor.isConnected) placeMenu(AS.pop, AS.anchor);
}
const assignWaited = (t, now) => Math.max(0, t.waited ?? now - (t.queued_at || t.created_at || now));
function renderAssign() {
  const list = AS.list;
  if (!list) return;
  const note = (text, cls = '') => { AS.rows = []; list.replaceChildren(el('p', `as-note ${cls}`.trim(), text)); };
  if (!AS.tasks) return note('Loading ready tasks…');
  if (AS.err) return note(`Couldn't load the ready tasks: ${AS.err}`, 'bad');
  if (!AS.tasks.length) return note('No ready tasks: everything queued is waiting on another task');
  const q = AS.q.trim().toLowerCase(), now = Date.now() / 1000, had = document.activeElement?.dataset?.task;
  const shown = AS.tasks.filter((t) => !q || [`#${t.id}`, t.title, t.project, URGENCY_WORD[t.urgency], shortLabel(t.agent || 'claude'), modelName(t.agent || 'claude', t.model)]
    .some((s) => String(s || '').toLowerCase().includes(q)));
  if (!shown.length) return note(`No ready task matches “${AS.q.trim()}”`);
  const items = shown.map((t) => {
    const item = el('div', 'as-item'), b = el('button', 'mc-task as-row'), main = el('span'), s = el('span', 's'), agent = t.agent || 'claude', why = AS.errs.get(t.id);
    b.type = 'button';
    b.dataset.task = t.id;
    b.disabled = AS.busy != null;
    s.append(document.createTextNode(`#${t.id} · `), el('span', `as-urg ${t.urgency || 'normal'}`, URGENCY_WORD[t.urgency] || 'Normal'),
      document.createTextNode(` · ${shortLabel(agent)} · ${modelName(agent, t.model)}`));
    main.append(el('span', 't', t.title), s);
    const w = assignWaited(t, now), e = el('span', 'e', AS.busy === t.id ? 'Starting…' : `waited ${fmtDur(w)}`);
    e.title = `Queued ${fmtDur(w)} ago`;
    b.append(main, e);
    b.addEventListener('click', () => assignPick(t));
    item.append(b);
    if (why) {
      const p = el('p', 'as-why', why);
      p.id = `asWhy${t.id}`;
      p.setAttribute('role', 'alert');
      b.setAttribute('aria-describedby', p.id);
      item.append(p);
    }
    return { t, b, item };
  });
  AS.rows = items.map((r) => r.b);
  list.replaceChildren(...items.map((r) => r.item));
  if (had != null) items.find((r) => String(r.t.id) === had)?.b.focus({ preventScroll: true });
}
async function assignPick(t) {
  if (AS.busy != null || !AS.node) return;
  const { seq, node, name } = AS;
  AS.busy = t.id;
  AS.errs.delete(t.id);
  renderAssign();
  try {
    const r = await fetch(`/api/orch/tasks/${encodeURIComponent(t.id)}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node }) });
    if (r.status === 401) { location.href = '/login'; return; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.reason || d.error || `Request failed (${r.status})`);
    if (seq === AS.seq) closeAssign();
    toast(`Started #${t.id} on ${name}${d.warning ? ' · CPU busy' : ''}`, { kind: d.warning ? 'warn' : 'success' });
    loadMachines();
  } catch (e) {
    if (seq !== AS.seq) return;
    AS.busy = null;
    AS.errs.set(t.id, e.message);
    renderAssign();
    AS.rows.find((b) => b.dataset.task === String(t.id))?.focus({ preventScroll: true });
  }
}
// Arrows move between the search and the rows, Enter in the search starts its only match (else goes to the first row),
// Tab stays inside; Escape (the document listener below, ahead of the machine detail's own) closes.
function assignKey(e) {
  const rows = AS.rows.filter((b) => !b.disabled), i = rows.indexOf(document.activeElement), inSearch = e.target === AS.search;
  const go = (j) => { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, j))]?.focus(); };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') { if (i > 0) go(i - 1); else if (i === 0) { e.preventDefault(); AS.search.focus(); } }
  else if (e.key === 'Enter' && inSearch) { e.preventDefault(); if (rows.length === 1) rows[0].click(); else rows[0]?.focus(); }
  else if (e.key === 'Tab') {
    const f = [AS.close, AS.search, ...rows], k = f.indexOf(document.activeElement);
    e.preventDefault();
    f[(k + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  }
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && AS.layer) { e.preventDefault(); e.stopImmediatePropagation(); closeAssign(); } }, true);

// ----- Update all (#458): the Machines header's 'Update all · 2 behind v3.60' ('All up to date', disabled, when none are)
// and an 'Update' on each outdated machine open a confirm sheet (openUpdateAll): each machine with its version → the
// target, 'Also update Claude Code and Codex CLIs' (off) and 'Update now' → POST /api/cluster/update {nodes, clis}. The
// head updates the workers one at a time, then itself; each card shows its step (rolloutLine), Retry on a failure, and a
// toast says when all are done (loadMachines).
// Behind: a worker by its commit count against origin/main; this server when its running code is older than its checkout.
const behindNow = (n) => n.enabled && (n.local ? !!n.headBehind : n.behind > 0);
const rolloutActive = (r) => !!r && !r.doneAt;
const canUpdate = (n) => behindNow(n) && !['queued', 'updating', 'restarting'].includes(n.rollout?.state);
function updateAllLabel(nodes, target, rollout) {
  const count = nodes.filter(behindNow).length, v = target?.version ? ` ${target.version}` : '';
  if (rolloutActive(rollout)) {
    const all = rollout.nodes.length, left = rollout.nodes.filter((e) => ['queued', 'updating'].includes(e.state)).length;
    return { count, text: `Updating… ${all - left} of ${all}`, disabled: true, title: 'Machines update one at a time, so some keep running tasks throughout' };
  }
  if (!count) return { count, text: 'All up to date', disabled: true, title: `Every machine runs${v || ' the latest agent-orch'}` };
  return { count, text: `Update all · ${count} behind${v}`, disabled: false, title: `Bring ${plural(count, 'machine')} to${v || ' the latest agent-orch'}, one at a time` };
}
// A machine's update step: 'Updating… pulling → installing → restarting' with the current step in bold; then '✓ v3.60',
// a failure with Retry, or 'offline: will update when back online'.
const UPDATE_STEPS = [['pausing', 'pausing tasks'], ['pulling', 'pulling'], ['installing', 'installing'], ['clis', 'updating CLIs'], ['restarting', 'restarting']];
function rolloutText(r, target) {
  const v = target?.version || 'the latest version';
  if (r.state === 'queued') return { cls: '', text: 'Update queued: machines update one at a time' };
  if (r.state === 'restarting') return { cls: '', text: 'Restarting into the new version (this server goes last)…' };
  if (r.state === 'done') return { cls: 'ok', text: `Updated to ${v} ✓` };
  if (r.state === 'failed') return { cls: 'bad', text: `Update failed: ${r.error || 'unknown error'}` };
  if (r.state === 'offline') return { cls: 'warn', text: 'Offline: will update when back online' };
  const steps = UPDATE_STEPS.filter(([k]) => k !== 'clis' || r.clis), at = steps.findIndex(([k]) => k === r.stage);
  return { cls: '', text: 'Updating… ', steps: steps.map(([k, label], i) => ({ label, on: i === at, done: i < at })), note: r.note || '' };
}
function rolloutSummary(r) {
  const n = (s) => r.nodes.filter((e) => e.state === s).length;
  const parts = [n('done') && `${plural(n('done'), 'machine')} updated`, n('failed') && `${n('failed')} failed`, n('offline') && `${n('offline')} offline (they update when back)`,
    n('restarting') && 'this server restarts now'].filter(Boolean);
  return `Update all finished: ${parts.join(', ') || 'nothing to do'}`;
}
function rolloutLine(n, target) {
  const r = n.rollout, t = rolloutText(r, target), p = el('p', `mc-health ua-line ${t.cls}`.trim(), t.text);
  p.dataset.state = r.state;
  if (t.steps) t.steps.forEach((s, i) => { if (i) p.append(document.createTextNode(' → ')); p.append(el(s.on ? 'b' : 'span', s.done ? 'ua-done' : '', s.label)); });
  if (t.note) p.title = t.note;
  if (r.state === 'failed') {
    const b = el('button', 'btn small ua-retry', 'Retry');
    b.type = 'button';
    b.addEventListener('click', () => startUpdate([n.id], !!r.clis));
    p.append(' ', b);
  }
  return p;
}
function updateButton(n) {
  const b = el('button', 'btn small as-btn ua-btn', 'Update');
  b.type = 'button';
  b.dataset.act = 'update-now';
  b.title = `Bring ${n.name} to ${MC.target?.version || 'the latest agent-orch'} now: its tasks pause and resume after`;
  b.addEventListener('click', () => openUpdateAll([n.id]));
  return b;
}
async function startUpdate(ids, clis) {
  try {
    const r = await api('/api/cluster/update', 'POST', { nodes: ids, clis });
    const n = r.rollout?.nodes.filter((e) => ['queued', 'updating'].includes(e.state)).length || 0;
    toast(n > 1 ? `Updating ${n} machines, one at a time` : 'Updating…');
    closeUpdateAll();
  } catch (e) { toast(e.message, { kind: 'error' }); }
  loadMachines();
}
const UA = { layer: null };
function openUpdateAll(ids = null) {
  closeUpdateAll();
  const list = MC.nodes.filter((n) => canUpdate(n) && (!ids || ids.includes(n.id)));
  if (!list.length) return toast('All up to date');
  // Workers first, then this server (it restarts last).
  list.sort((a, b) => Number(a.local) - Number(b.local));
  const layer = el('div', 'as-layer ua-layer'), scrim = el('div', 'as-scrim'), pop = el('div', 'as-pop ua-pop'), head = el('div', 'as-head'), grip = el('div', 'sheet-grip');
  const h = el('h3', '', list.length === 1 && ids ? `Update ${list[0].name}` : 'Update all machines'), x = el('button', 'icon-btn as-x');
  h.id = 'uaTitle';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true');
  pop.setAttribute('aria-labelledby', 'uaTitle');
  pop.tabIndex = -1;
  grip.setAttribute('aria-hidden', 'true');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.innerHTML = CLOSE_SVG;
  head.append(h, x);
  const rows = el('ul', 'ua-list'), to = MC.target?.version || 'latest';
  for (const n of list) {
    const li = el('li', 'ua-row'), note = !n.local && !n.connected ? 'offline: will update when back online' : n.local ? 'restarts last' : n.used === 1 ? 'its task pauses and resumes' : n.used ? `its ${n.used} tasks pause and resume` : '';
    li.append(el('span', 'ua-name', n.name), el('span', 'ua-ver', `${n.version || '?'} → ${to}`));
    if (note) li.append(el('span', 'ua-note', note));
    rows.append(li);
  }
  const hint = el('p', 'as-note', 'One machine at a time: each pauses its tasks (their work is pushed), updates, restarts and picks them up again.');
  const cli = el('label', 'ua-cli'), box = el('input');
  box.type = 'checkbox';
  box.id = 'uaClis';
  cli.append(box, document.createTextNode(' Also update Claude Code and Codex CLIs'));
  const go = el('button', 'btn primary ua-go', 'Update now');
  go.type = 'button';
  go.addEventListener('click', () => { go.disabled = true; startUpdate(list.map((n) => n.id), box.checked); });
  const foot = el('div', 'ua-foot');
  foot.append(cli, go);
  pop.append(grip, head, rows, hint, foot);
  layer.append(scrim, pop);
  scrim.addEventListener('click', closeUpdateAll);
  x.addEventListener('click', closeUpdateAll);
  layer.classList.toggle('sheet', phoneMQ.matches);
  if (!phoneMQ.matches) Object.assign(pop.style, { left: '50%', top: '18%', transform: 'translateX(-50%)' });
  UA.layer = layer;
  document.body.append(layer);
  go.focus({ preventScroll: true });
}
function closeUpdateAll() { UA.layer?.remove(); UA.layer = null; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && UA.layer) { e.preventDefault(); e.stopImmediatePropagation(); closeUpdateAll(); } }, true);
$('updateAll').addEventListener('click', () => openUpdateAll());
// ----- machine settings (the 'Machine settings' disclosure at the foot of each card) -----
// Plain words in at most three sections, a row each (label, one-line hint, one control; a switch's row is its label):
//   Work: parallel tasks (Auto or a cap; the controller's own follow its cores, capped in Settings) and Run tasks
//     on this machine (off = draining: it finishes its running tasks, then takes no more; on also re-enables it).
//   Staying awake (a Mac worker): its policy's keepAwake (power.mjs; on = 'always', off = 'never').
//   Manage: rename, finish sound, check the connection (Ping), update and, set apart in red, remove from the cluster.
// MC.open: the cards whose disclosure is open, kept across live re-renders.
const GEAR_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'; // a gear (Feather's settings icon)
// inline: a machine's detail page on phones shows the settings open, under their own section title.
function machineSettings(n, inline = false) {
  const box = el('details', inline ? 'mc-set inline' : 'mc-set'), sum = el('summary');
  box.open = inline || MC.open.has(n.id);
  if (!inline) box.addEventListener('toggle', () => { if (box.open) MC.open.add(n.id); else MC.open.delete(n.id); });
  sum.dataset.act = 'settings';
  sum.innerHTML = GEAR_ICON;
  sum.append(el('span', '', 'Machine settings'));
  box.append(sum);
  const section = (title) => {
    const s = el('section', 'mc-group');
    s.append(el('h5', '', title));
    box.append(s);
    return s;
  };
  const row = (sec, label, hint, control) => {
    const r = el(control.type === 'checkbox' ? 'label' : 'div', 'mc-row'), t = el('span', 'mc-rt'); // a switch's whole row toggles it
    t.append(el('span', 'mc-rl', label), el('span', 'mc-rh', hint));
    r.append(t, control);
    sec.append(r);
  };
  const button = (text, act, run, cls = '') => {
    const b = el('button', `btn small${cls}`, text);
    b.type = 'button';
    b.dataset.act = act;
    b.addEventListener('click', run);
    return b;
  };
  const toggle = (act, on, label, run) => {
    const s = el('input', 'st-switch');
    s.type = 'checkbox';
    s.checked = on;
    s.dataset.act = act;
    s.setAttribute('role', 'switch');
    s.setAttribute('aria-label', label);
    s.addEventListener('change', run);
    return s;
  };
  const mac = n.os === 'darwin', where = mac ? 'this Mac' : 'this machine';

  const work = section('Work');
  if (n.local) {
    const auto = el('span', 'mc-auto', 'Auto');
    auto.title = `Sized from this server's ${n.head ? plural(n.head.cores, 'core') : 'cores'} (one task per core, at least 4, plus integration slots), re-checked every 10 minutes. Settings → Parallel tasks caps tasks across all machines.`;
    row(work, 'Parallel tasks', "One per core, at least 4, plus integration slots. Settings → Parallel tasks caps all machines.", auto);
  } else {
    const seg = el('span', 'seg-sm');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', `Parallel tasks on ${n.name}`);
    for (const v of [null, 1, 2, 3, 4, ...(n.maxSlots > 4 ? [n.maxSlots] : [])]) {
      const b = el('button', '', v == null ? 'Auto' : String(v));
      b.type = 'button';
      b.dataset.act = `slots-${v ?? 'auto'}`;
      b.setAttribute('aria-pressed', String(v === n.maxSlots));
      b.addEventListener('click', () => { if (v !== n.maxSlots) patchNode(n, { maxSlots: v }); });
      seg.append(b);
    }
    row(work, 'Parallel tasks', n.maxSlots == null ? `Auto: as many as ${where}'s cores allow (at least 4)` : `At most ${plural(n.maxSlots, 'task')} at once`, seg);
  }
  const taking = n.enabled && !n.draining;
  row(work, 'Run tasks on this machine', taking ? 'Accept new tasks' : n.enabled ? 'Finish current tasks, then stop' : 'Off: it takes no tasks',
    toggle('accept', taking, `Run tasks on ${n.name}`, () => patchNode(n, taking ? { draining: true } : { draining: false, ...(n.enabled ? {} : { enabled: true }) })));

  if (!n.local && mac && n.policy) {
    const on = n.policy.keepAwake !== 'never';
    row(section('Staying awake'), "Keep this Mac awake while it's connected", 'Closing the lid still puts it to sleep.',
      toggle('awake', on, `Keep ${n.name} awake`, () => patchNode(n, { policy: { keepAwake: on ? 'never' : 'always' } })));
  }

  const manage = section('Manage');
  row(manage, 'Name', n.name, button('Rename', 'rename', () => {
    const name = prompt(`Rename ${n.name}`, n.name)?.trim();
    if (name && name !== n.name) patchNode(n, { name });
  }));
  row(manage, 'Finish sound', 'Plays when a task finishes here', machineSoundPicker(n));
  if (MC.soundAdd === n.id) manage.append(soundAddForm((c) => { MC.soundAdd = null; patchNode(n, { sound: c.key }); }, () => { MC.soundAdd = null; renderMachines(); }));
  if (!n.local) {
    const busy = !!MC.pings.get(n.id)?.busy, pb = button(busy ? 'Checking…' : 'Check', 'ping', () => pingNode(n));
    pb.disabled = busy;
    row(manage, 'Check connection', n.connected ? 'Tests its link to this server, DNS and GitHub' : 'Why it dropped, and a command to test from it', pb);
  }
  // Update: a machine behind this server's agent-orch, or one whose update failed: the Update all sheet for it alone.
  if (canUpdate(n) || (!n.local && n.connected && n.update?.state === 'failed' && !n.rollout)) {
    row(manage, 'Update agent-orch', n.update?.state === 'failed' ? 'The last update failed: try again' : 'Pauses its tasks, updates and restarts it; they resume after',
      button('Update', 'update', () => openUpdateAll([n.id])));
  }
  if (!n.local) {
    const moving = n.used ? ` Its ${plural(n.used, 'running task')} go${n.used === 1 ? 'es' : ''} back to the queue now.` : '';
    const danger = el('div', 'mc-danger');
    manage.append(danger);
    row(danger, 'Remove from cluster', 'It disconnects; adding it back needs a new pairing code.', button('Remove…', 'remove', async () => {
      if (!confirm(`Remove ${n.name} from the cluster? It disconnects for good.${moving} Adding it back needs a new pairing code.`)) return;
      try { await api(`/api/cluster/nodes/${encodeURIComponent(n.id)}`, 'DELETE'); toast(`Removed ${n.name}`); } catch (e) { toast(e.message, { kind: 'error' }); }
      loadMachines();
    }, ' danger'));
  }
  return box;
}
// The Finish sound row's control, '[Bell ▾] ▶ Test': the sound its finished tasks play, saved on the head (node.sound)
// for every device. Choosing its default again stores null, so it keeps following the default. The owner's custom sounds
// follow the built-ins; '+ Add custom sound…' opens the add form under the row (MC.soundAdd) and gives this machine the new sound.
function machineSoundPicker(n) {
  const pick = el('span', 'mc-sound-pick'), sel = el('select');
  const def = machineFallback(n.id);
  sel.dataset.act = 'sound';
  sel.setAttribute('aria-label', `Finish sound for ${n.name}`);
  const opt = (k, label) => { const o = el('option', '', `${label}${k === def ? ' (default)' : ''}`); o.value = k; return o; };
  for (const [k, s] of Object.entries(MACHINE_SOUNDS)) sel.append(opt(k, k === 'chime' && completionSound.mp3 ? 'Your MP3' : s.label));
  if (completionSound.custom.sounds.length) {
    const g = el('optgroup');
    g.label = 'Your sounds';
    for (const c of completionSound.custom.sounds) g.append(opt(c.key, c.name));
    sel.append(g);
  }
  sel.append(opt('+add', '+ Add custom sound…'));
  sel.value = machineSound(n.id);
  sel.addEventListener('change', () => {
    if (sel.value !== '+add') return patchNode(n, { sound: sel.value === def ? null : sel.value });
    sel.value = machineSound(n.id);
    MC.soundAdd = n.id;
    sel.blur();
    renderMachines();
    $('mMachines').querySelector(`.mc-node[data-node="${CSS.escape(n.id)}"] .snd-add input[type=url]`)?.focus();
  });
  sel.addEventListener('blur', () => { if (MC.stale) setTimeout(renderMachines, 0); });
  const test = el('button', 'btn small', '▶ Test');
  test.type = 'button';
  test.dataset.act = 'sound-test';
  test.setAttribute('aria-label', `Test ${n.name}'s finish sound`);
  test.addEventListener('click', () => playSound(sel.value));
  pick.append(sel, test);
  return pick;
}
async function patchNode(n, body) {
  try { await api(`/api/cluster/nodes/${encodeURIComponent(n.id)}`, 'PATCH', body); } catch (e) { toast(e.message, { kind: 'error' }); }
  loadMachines();
}

// ----- cluster diagram (the Machines view; its machine cards on wider screens) -----
// One SVG drawn by one requestAnimationFrame loop: the head (this server) in the middle and the workers around it (a
// vertical list under 640px), each with CPU (outer) and RAM (inner) ring gauges, its OS icon and its running tasks as
// chips. It moves on data the page already gets: a worker's newer reading (resources.at, sent every heartbeat) pulses it
// and its link; lane activity (olane, one push per tool call) sends particles up the link of that task's machine, at
// most 6 a second per link; a task that shows up on a machine travels there from the head as a chip, and one that leaves
// returns and merges into the head (a check when it finished, a cross when it failed). Phase changes cross-fade on the
// chip. Offline machines turn grey with a dashed link, asleep Macs wear a moon and draining ones an amber ring. The loop
// runs only while something moves, the Machines view is open, the diagram in view and the page visible (at most 60 fps),
// and never reads layout; with reduced motion every change is a static swap. Colours are theme variables (app.css .ca-*).
// From 768px (CA_WIDE) the diagram is a star and each machine wears an HTML card beside its node instead of labels and
// chips (caCard): full name, status and build, then every task running there (the head's split into Integrating and
// Work); usage is only the node's rings (CPU its border, RAM a thin ring inside). A card sits
// outward from the head and is nudged until it clears the other cards, the machines and the links (caPlace*); chips
// still travel the links and fade into the card. Phones keep the labels, the chips and the card list under the diagram.
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
// snapshot since the Machines view opened is drawn (later changes animate).
const CC_W = 272, CC_GAP = 12; // a machine card's width and its distance from its machine
const CA_TOP = 75 * Math.PI / 180; // the star's top sector (±75° from straight up) is the head's card's: no worker or link there
CA_WIDE.addEventListener('change', () => { if (mxOpen()) renderMachines(); }); // cards ↔ the phone's list
const CA = { wrap: null, svg: null, layer: null, cards: false, g: {}, w: 0, h: 0, list: false, key: '', head: null, nodes: new Map(), chips: new Map(), anims: new Set(),
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
  CA.layer = el('div', 'ca-cards');
  CA.wrap.append(CA.layer);
  CA.layer.addEventListener('click', (e) => {
    const row = e.target.closest('.cc-task'), card = e.target.closest('.cc');
    if (row) return openTask(Number(row.dataset.task));
    if (!card || !e.target.closest('.cc-open, .cc-gear')) return;
    openNode(card.dataset.node);
    if (e.target.closest('.cc-gear')) ND.els?.machine?.scrollIntoView({ block: 'start' }); // its settings
  });
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w && w !== CA.w) { CA.w = w; caLayout(); }
  }).observe(CA.wrap);
  // Scrolled out of view (or the Queue tab on a phone): nothing moves until it's back.
  new IntersectionObserver(([e]) => { CA.inView = e.isIntersecting; if (!CA.inView) caFlush(); }).observe(CA.wrap);
  // A chip opens its task's drawer; a machine its detail.
  CA.svg.addEventListener('click', (e) => {
    const chip = e.target.closest('.ca-chip'), node = e.target.closest('.ca-node');
    if (chip) openTask(Number(chip.dataset.task)); else if (node) openNode(node.dataset.node);
  });
  CA.svg.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('ca-node')) { e.preventDefault(); openNode(e.target.dataset.node); }
  });
}
function caClear() {
  caFlush();
  for (const v of CA.nodes.values()) { v.g.remove(); v.link?.remove(); v.glow?.remove(); v.card?.remove(); }
  for (const c of CA.chips.values()) c.g.remove();
  CA.nodes.clear(); CA.chips.clear(); CA.seen.clear();
  CA.key = ''; CA.head = null; CA.ready = false;
}
// A new snapshot of GET /api/cluster/nodes (renderMachines): the machines, their readings and running tasks.
function caSync(nodes) {
  if (!mxOpen()) return; // drawn only while the Machines view is open; the next open starts fresh
  const head = nodes.find((n) => n.local);
  // Alone on a phone: just its card in the list. Wider, the head's card beside its node.
  if (!head || (!nodes.some((n) => !n.local) && !CA_WIDE.matches)) { if (CA.wrap) { CA.wrap.hidden = true; caClear(); } return; }
  caBuild();
  CA.wrap.hidden = false;
  if (CA.cards !== CA_WIDE.matches) { caClear(); CA.cards = CA_WIDE.matches; CA.wrap.classList.toggle('cards', CA.cards); }
  if (!CA.w) CA.w = Math.round(CA.wrap.clientWidth); // until the ResizeObserver's first report
  const ids = new Set(nodes.map((n) => n.id));
  for (const [id, v] of CA.nodes) if (!ids.has(id)) { v.g.remove(); v.link?.remove(); v.glow?.remove(); v.card?.remove(); CA.nodes.delete(id); CA.seen.delete(id); }
  for (const n of nodes) {
    const v = CA.nodes.get(n.id) || caNode(n);
    v.n = n;
    CA.nodes.set(n.id, v);
    if (CA.cards) caCard(v);
  }
  CA.head = CA.nodes.get(head.id);
  if (CA.cards || `${CA.w}|${[...ids].join(',')}` !== CA.key) caLayout(); // a card's height follows its tasks
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
  v.cpuT = sv('circle', { class: 'ca-track', 'data-k': 'cpu' }, g);
  v.cpu = sv('circle', { class: 'ca-gauge', 'data-k': 'cpu', transform: 'rotate(-90)' }, g);
  v.ramT = sv('circle', { class: 'ca-track', 'data-k': 'ram' }, g);
  v.ram = sv('circle', { class: 'ca-gauge', 'data-k': 'ram', transform: 'rotate(-90)' }, g);
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
  CA.list = W < (CA.cards ? 820 : 640);
  if (CA.cards) caCardLayout(W, head, workers);
  else if (CA.list) {
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
  if (CA.cards) CA.layer.style.height = `${CA.h}px`;
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
// The card layout's places. Narrow (< 820px): a list, the head on top, each card right of its machine and each row as
// tall as its card. Otherwise a star (#498): the head in the centre wearing its card right above it (#509), and the
// workers evenly spaced on a circle around it outside that top sector (from CA_TOP to 360° - CA_TOP clockwise from
// the top, so no link crosses the head's card; one or two sit lower-right and lower-left), each card on its machine's
// outer side (beside one to the left or right, growing away from the head's row; below one near the bottom), nudged
// further out until it clears the head's card, the cards placed before it, every machine and every link. A circle too
// wide for the view shrinks and tries again.
function caCardLayout(W, head, workers) {
  const all = [head, ...workers], size = (v, w) => { v.card.style.width = `${w}px`; v.cw = w; v.ch = v.card.offsetHeight; };
  if (CA.list) {
    let y = 8;
    for (const v of all) {
      const r = v === head ? 26 : 22, cx = 70 + r + 14;
      size(v, Math.max(150, Math.min(CC_W, W - cx - 8)));
      Object.assign(v, { r, side: 'right', x: 70, y: y + r + 6, cl: cx, ct: y + 4 });
      y += Math.max(2 * r + 18, v.ch + 14);
    }
    CA.h = y + 4;
    for (const v of workers) v.poly = caPoly(caElbow(v, head, 28));
  } else {
    for (const v of all) size(v, CC_W);
    const n = workers.length, low = Math.sin(CA_TOP), minRad = Math.ceil((CC_W / 2 + 26 + 8) / low); // a worker clears the head's card sideways
    let rad = Math.max(minRad, Math.min((W / 2 - CC_W - 26 - CC_GAP - 12) / (n > 2 ? low : 0.72), n <= 1 ? 250 : 150 + 40 * n)), box;
    for (let tries = 0; tries < 8; tries++) {
      Object.assign(head, { r: 34, x: 0, y: 0, side: 'above', up: true });
      workers.forEach((v, i) => {
        // Clockwise from the top: evenly over [CA_TOP, 2π - CA_TOP]; one or two workers lower-right / lower-left.
        const t = n <= 2 ? (3 + 2 * i) * Math.PI / 4 : CA_TOP + ((2 * Math.PI - 2 * CA_TOP) * i) / (n - 1), c = Math.sin(t), s = -Math.cos(t);
        Object.assign(v, { r: 26, x: rad * c, y: rad * s, side: c > 0.3 ? 'right' : c < -0.3 ? 'left' : 'below', up: s < -0.05 });
      });
      const placed = [];
      for (const v of [head, ...workers]) placed.push(caCardSpot(v, placed, all, head)); // the head's first: anchored above its node
      box = [Infinity, -Infinity, Infinity, -Infinity];
      for (const v of all) for (const [l, r, t, b] of [[v.x - v.r - 8, v.x + v.r + 8, v.y - v.r - 8, v.y + v.r + 8], [v.cl, v.cl + v.cw, v.ct, v.ct + v.ch]]) {
        box = [Math.min(box[0], l), Math.max(box[1], r), Math.min(box[2], t), Math.max(box[3], b)];
      }
      if (box[1] - box[0] <= W - 16 || rad <= minRad) break;
      rad = Math.max(minRad, rad - (box[1] - box[0] - W + 16) / 2 - 4);
    }
    const dx = Math.round(W / 2 - (box[0] + box[1]) / 2), dy = Math.round(12 - box[2]);
    for (const v of all) { v.x += dx; v.y += dy; v.cl += dx; v.ct += dy; }
    CA.h = Math.round(box[3] - box[2] + 24);
    for (const v of workers) v.poly = caPoly([[v.x, v.y], [head.x, head.y]]);
  }
  for (const v of all) {
    Object.assign(v.card.style, { left: `${Math.round(v.cl)}px`, top: `${Math.round(v.ct)}px` });
    v.placed = true;
    v.seat = [Math.max(v.cl, Math.min(v.cl + v.cw, v.x)), Math.max(v.ct, Math.min(v.ct + v.ch, v.y))];
  }
}
// One card's spot beside its machine, pushed 6px at a time away from the head's row until it overlaps no card placed
// before it (8px apart), no machine and no link. Returns its box [left, right, top, bottom].
function caCardSpot(v, placed, all, head) {
  const { x, y, r, cw, ch } = v, s = v.side;
  v.cl = s === 'right' ? x + r + CC_GAP : s === 'left' ? x - r - CC_GAP - cw : x - cw / 2;
  v.ct = s === 'above' ? y - r - CC_GAP - ch : s === 'below' ? y + r + CC_GAP : v.up ? y + 16 - ch : y - 16;
  const dir = v.up ? -1 : 1, hits = (l, t) => {
    const rr = l + cw, bb = t + ch;
    if (placed.some(([a, b, c, d]) => l < b + 8 && rr > a - 8 && t < d + 8 && bb > c - 8)) return true;
    if (all.some((u) => l < u.x + u.r + 6 && rr > u.x - u.r - 6 && t < u.y + u.r + 6 && bb > u.y - u.r - 6)) return true; // the machine's square, rings and all
    return all.some((u) => {
      if (u === head) return false;
      const len = Math.hypot(head.x - u.x, head.y - u.y), k = Math.ceil(len / 4);
      for (let i = 0; i <= k; i++) {
        const px = u.x + ((head.x - u.x) * i) / k, py = u.y + ((head.y - u.y) * i) / k;
        if (px > l - 4 && px < rr + 4 && py > t - 4 && py < bb + 4) return true;
      }
      return false;
    });
  };
  for (let i = 0; i < 120 && hits(v.cl, v.ct); i++) v.ct += 6 * dir;
  return [v.cl, v.cl + cw, v.ct, v.ct + ch];
}
// Integrators and reflection take the head's reserved slots: its card lists them under Integrating.
const caIntegrating = (t) => !!t.integrates || (t.kind !== 'work' && t.kind !== 'plan');
// A machine's card: its header (status dot, full name, build; it opens the machine's detail, as does the gear, where its
// settings live), then every task running there as a mini card (#412, title; agent · model and how long it has run;
// its progress strip; a click opens its drawer), the head's under Integrating and Work. Past about 8 tasks the list
// scrolls. No CPU/RAM here: that's the node's rings. Rebuilt on every snapshot, keeping focus and the list's scroll.
function caCard(v) {
  const n = v.n, st = nodeState(n), card = (v.card ||= el('div', 'cc'));
  if (card.parentNode !== CA.layer) CA.layer.append(card);
  card.dataset.node = n.id;
  card.className = `cc${n.local ? ' head' : ''}${!n.connected || !n.enabled ? ' away' : ''}${v.placed ? ' moves' : ''}`; // placed once: later moves glide
  const a = document.activeElement, focus = card.contains(a) ? a.dataset.task || a.dataset.act || a.className : null, scroll = card.querySelector('.cc-tasks')?.scrollTop || 0;
  card.title = ''; // usage lives on the node's rings (their tooltip), never on the card
  const top = el('div', 'cc-head'), open = el('button', 'cc-open'), gear = el('button', 'cc-gear'), ver = fmtVersion(n.build);
  open.type = gear.type = 'button';
  const dot = el('span', `dot ${st.dot}`);
  dot.title = st.label;
  open.append(dot, el('span', 'cc-name', n.name));
  open.classList.toggle('long', n.name.length > 22); // a long name gets the row to itself (≤ 2 lines); status and build go under it
  if (st.label !== 'Online') open.append(el('span', 'cc-st', st.label));
  const old = !n.local && (n.behind > 0 || (n.behind == null && n.build && VER.running?.build && n.build < VER.running.build)); // as machineCard's tag
  if (ver) {
    const b = open.appendChild(el('span', old ? 'cc-build outdated' : 'cc-build', ver));
    if (old) b.title = n.behind > 0 ? `Outdated: ${plural(n.behind, 'commit')} behind` : 'Outdated';
  }
  open.setAttribute('aria-label', `${n.name}${n.local ? ' (this server, the head)' : ''}: ${st.label}${ver ? `, ${ver}${old ? ', outdated' : ''}` : ''}. Show details`);
  gear.innerHTML = GEAR_ICON;
  gear.setAttribute('aria-label', `${n.name} settings`);
  gear.title = 'Settings and details';
  top.append(open, gear);
  const list = el('div', 'cc-tasks'), tasks = n.tasks || [], hd = n.head;
  if (hd) {
    const integ = tasks.filter(caIntegrating), work = tasks.filter((t) => !caIntegrating(t));
    list.append(el('div', 'cc-grp', `Integrating ${integ.length}/${hd.reserved}`), ...integ.map(ccRow), el('div', 'cc-grp', `Work ${hd.workUsed}/${hd.work}`), ...work.map(ccRow));
  } else if (tasks.length) list.append(...tasks.map(ccRow));
  else list.append(el('p', 'cc-idle', n.connected && n.enabled && !n.draining ? 'Idle' : 'Nothing running'));
  card.replaceChildren(top, list, renderAssignButton(n)); // the owner's rule: every machine card keeps Assign task
  list.scrollTop = scroll;
  if (focus) [...card.querySelectorAll('button')].find((b) => (b.dataset.task || b.dataset.act || b.className) === focus)?.focus({ preventScroll: true });
}
function ccRow(t) {
  const b = el('button', 'cc-task'), wait = !!t.waiting_for, e = el('span', wait ? 'e wait' : 'e', wait ? 'waiting' : fmtDur(Date.now() / 1000 - t.started_at));
  b.type = 'button';
  b.dataset.task = t.id;
  if (!wait) e.dataset.started = t.started_at;
  const top = el('span', 'cc-l1'), sub = el('span', 'cc-l2');
  top.append(el('span', 'cc-id', `#${t.id}`), el('span', 'cc-t', displayTitle(t)));
  sub.append(el('span', 'cc-am', `${shortLabel(t.agent)} · ${modelName(t.agent, t.model)}`), e);
  b.append(top, sub);
  b.title = [`#${t.id} ${displayTitle(t)}`, t.project, `${shortLabel(t.agent)} · ${modelName(t.agent, t.model)}`,
    t.phase && t.phase !== 'running' ? PHASE_DOING[t.phase] : '', wait ? `waiting for ${t.waiting_for}` : ''].filter(Boolean).join(' · ');
  const full = { ...(O.tasks.get(t.id) || {}), ...t, status: 'running' }; // the queue's copy may lag the machine's phase
  syncPhaseStrip(b, full, taskState(full)); // the cards' compact Timeline bar (app.css .cc-task > .tl-bar.compact)
  return b;
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
  if (CA.cards) return v.seat || [v.x, v.y]; // the card's edge nearest its machine
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
  [v.rc, v.rr] = CA.cards ? [r, r - 4.5] : [r - 4, r - 10]; // cards: CPU is the node's border, RAM a thin ring inside
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
  v.name.textContent = CA.cards ? '' : n.name.length > 20 ? `${n.name.slice(0, 19)}…` : n.name; // a card says it all
  const pct = [cpu != null && `CPU ${Math.round(cpu)}%`, ram != null && `RAM ${Math.round(ram)}%`].filter(Boolean).join(' · ');
  v.sub.textContent = CA.cards ? '' : n.local ? ['Head', pct].filter(Boolean).join(' · ') : !n.enabled ? 'Disabled'
    : !n.connected ? `${st.label} · ${n.lastSeen ? `seen ${relTime(n.lastSeen)}` : 'never connected'}` : st.label === 'Online' ? pct || 'Online' : [st.label, pct].filter(Boolean).join(' · ');
  const tasks = n.tasks?.length || 0;
  const label = `${n.name}${n.local ? ' (this server, the head)' : ''}: ${st.label}${pct ? `, ${pct}` : ''}, ${tasks ? `${plural(tasks, 'task')} running` : 'nothing running'}. Show details`;
  v.g.setAttribute('aria-label', label);
  const mem = n.inventory?.mem, gb = (b) => (b / 2 ** 30).toFixed(1); // the rings' exact numbers
  const exact = [cpu != null && `CPU ${cpu.toFixed(1)}% (ring)`, ram != null && `RAM ${ram.toFixed(1)}%${mem ? `, ${gb(mem - n.resources.memAvailable)} of ${gb(mem)} GB` : ''} (inner ring)`].filter(Boolean);
  v.title.textContent = CA.cards && exact.length ? `${n.name}: ${st.label}\n${exact.join('\n')}` : label;
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
const caCanMove = () => !!CA.svg && CA.inView && !CA.wrap.hidden && !reduceMotion.matches && !document.hidden && mxOpen();
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
  const rows = CA.cards ? 0 : CA.list ? 1 : 2; // a card lists them all: its chips only travel
  for (const v of CA.nodes.values()) {
    const mine = [...CA.chips.values()].filter((c) => c.node === v.n.id && !c.leaving).sort((a, b) => (a.t.started_at || 0) - (b.t.started_at || 0) || a.id - b.id);
    mine.forEach((c, k) => { c.slot = Math.max(0, Math.min(k, rows - 1)); c.hidden = k >= rows; });
    const over = CA.cards ? 0 : mine.length - rows;
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
      (u) => ({ e: u < 0.78 ? 0 : caEase((u - 0.78) / 0.22), s: 0.6 + 0.4 * Math.min(1, u / 0.15), o: Math.min(1, u / 0.1) * (o || Math.max(0, Math.min(1, 1 - (u - 0.85) / 0.15))) })); // hidden at rest: it fades out as it lands
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
    (u, e0) => ({ e: e0 * Math.max(0, 1 - u / 0.2), s: u > 0.82 ? 1 - (0.65 * (u - 0.82)) / 0.18 : 1, o: (c.hidden && !CA.cards ? 0.001 : 1) * (u > 0.86 ? (1 - u) / 0.14 : 1) }), 0, home);
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

// ----- Machines: the full-screen view (sidebar 'Machines' button, or the machine card: focused on that machine) -----
// Fills the viewport over the app (a full-height sheet on phones): the cluster summary, the diagram and the machine
// cards on the left; the queue on the right (a tab of its own on phones): 'Running 5 · Queued 12 · 11 free slots', the
// running tasks lane by lane per machine (cluster-wide, from GET /api/cluster/nodes), then the Queue sheet's own list
// (#qBody is borrowed while this is open, so taskCard, the dependency tree and drag-to-reorder come along; queued tasks
// are the open project's, in scheduler order). A machine's detail is its side panel (#nodeModal, below). It sits under
// the task drawer (z-index), so a tapped task opens over it; Escape closes the drawer, then the panel, then the view.
const MX = { lastFocus: null };
function mxOpen() { return !$('mxModal').hidden; }
function openMachines(id) {
  if (!mxOpen()) {
    MX.lastFocus = document.activeElement;
    closeSidebar();
    if (!$('queueModal').hidden) closeQueue(false);
    $('mxModal').hidden = false;
    $('mxQueue').append($('qBody'));
    CA.ready = false; // the cluster diagram's first snapshot is drawn as it is, not replayed
    mxPlace();
    mxTab('machines');
    loadMachines();
    renderQueue();
    if (!id) $('mxModal').querySelector('.mx-head [data-close]').focus();
  }
  if (id) openNode(id);
}
function closeMachines() {
  if (!mxOpen()) return;
  if (Q.drag) endDrag(false);
  ND.lastFocus = null;
  closeNode(true);
  $('mxModal').hidden = true;
  $('queueModal').querySelector('.modal-panel').append($('qBody'));
  caFlush();
  MX.lastFocus?.focus?.({ preventScroll: true });
}
// Phones show one side at a time: the machines or the queue.
function mxTab(tab) {
  $('mxModal').dataset.tab = tab;
  for (const b of $('mxModal').querySelectorAll('.mx-tabs [role="tab"]')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  if (tab === 'queue') qLines(); // the tree's connectors measure the cards, which were hidden
}
$('mxModal').querySelector('.mx-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[role="tab"]');
  if (b) mxTab(b.dataset.tab);
});
$('mxModal').querySelector('.mx-tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tab = $('mxModal').dataset.tab === 'queue' ? 'machines' : 'queue';
  mxTab(tab);
  $('mxModal').querySelector(`.mx-tabs [data-tab="${tab}"]`).focus();
});
$('mxModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]') && !$('nodeModal').contains(e.target)) closeMachines(); });
// Phones: Update all / Ping all / Add machine go under the list, and the diagram sits behind 'Show diagram'.
function mxPlace() {
  const acts = $('mxActs'), head = $('mxModal').querySelector('.mx-head');
  if (isPhone()) $('mxMore').append(acts);
  else if (acts.parentNode !== head) head.insertBefore(acts, head.querySelector('[data-close]'));
  mxDiagram(store.get('cw.mx.diagram') === '1');
}
function mxDiagram(on) {
  $('mxModal').toggleAttribute('data-diagram', on);
  $('mxDiagBtn').textContent = on ? 'Hide diagram' : 'Show diagram';
  $('mxDiagBtn').setAttribute('aria-expanded', String(on));
}
$('mxDiagBtn').addEventListener('click', () => {
  const on = !$('mxModal').hasAttribute('data-diagram');
  store.set('cw.mx.diagram', on ? '1' : '0');
  mxDiagram(on);
});
PHONE_MQ.addEventListener('change', () => {
  if (!mxOpen()) return;
  mxPlace();
  if (ND.id) { ndBuild(); ndRender(); ndMetrics(); }
});
// 'Running 5 · Queued 12 · 11 free slots': tasks running on every machine, the open project's queue, and the slots free
// on the machines taking work (connected, enabled, not draining or paused).
function mxCounts(nodes, queued) {
  const running = nodes.reduce((a, n) => a + (n.tasks?.length || 0), 0);
  const free = nodes.filter((n) => n.connected && n.enabled && !n.draining && n.status !== 'paused').reduce((a, n) => a + Math.max(0, (n.slots || 0) - (n.used || 0)), 0);
  return `Running ${running} · Queued ${queued} · ${plural(free, 'free slot')}`;
}
// The running lanes, a group per machine that runs something or takes work: '<machine> · 2 of 4 slots', its tasks.
function mxLanes() {
  const box = el('div', 'mx-lanes'), h = el('h3', 'dg-group', 'Running');
  box.id = 'mxLanes';
  // Rapid mode: the files running work declared, with how many tasks may edit each at once (the per-file cap).
  const hot = (O.state?.hot_files || []).filter((x) => x.project_id === O.project?.id);
  if (hot.length) h.append(el('span', 'q-hot', `hot files: ${hot.map((x) => `${x.file} ×${x.cap}`).join(' · ')}`));
  box.append(h);
  const nodes = MC.nodes.filter((n) => n.tasks?.length || (n.connected && n.enabled));
  if (!MC.at) box.append(el('p', 'muted', 'Loading machines…'));
  for (const n of nodes) {
    const lane = el('div', 'mx-lane'), head = el('div', 'mx-lane-h'), st = nodeState(n), tasks = n.tasks || [];
    lane.dataset.node = n.id;
    head.append(el('span', `dot ${st.dot}`), el('span', 'mx-lane-n', n.name), el('span', 'mx-lane-s',
      st.label !== 'Online' ? st.label : `${n.used ?? tasks.length} of ${plural(n.slots ?? 0, 'slot')}`));
    lane.append(head);
    if (!tasks.length) lane.append(el('p', 'mc-idle', 'Idle'));
    for (const t of tasks) lane.append(mcTaskRow(t));
    box.append(lane);
  }
  return box;
}
// Fresh machines: the lanes and the counts follow without re-rendering the queue under a drag or the owner's focus.
function mxLanesRender() {
  if (!mxOpen()) return;
  const f = document.activeElement?.closest?.('#mxLanes .mc-task')?.dataset.task, lanes = $('qBody').querySelector('#mxLanes');
  if (lanes) lanes.replaceWith(mxLanes()); // the queue's first render puts them in
  if (f) $('qBody').querySelector(`#mxLanes .mc-task[data-task="${f}"]`)?.focus({ preventScroll: true });
  mxCountsRender();
}
function mxCountsRender() {
  const q = queuedTasks().length;
  $('mxCounts').textContent = mxCounts(MC.nodes, q);
  $('mxTabN').textContent = q ? ` ${q}` : '';
}

// ----- a machine's detail (tap it in the diagram, or its sidebar card): the Machines view's side panel -----
// One panel for every node, sections in the same order: charts (CPU, memory, disk, network, load), what runs there
// with each remote run's phase timeline (the task's latest run, as in its drawer), processes where known, and the log.
// The controller's is this server's full details (renderServerDetails: live charts from the metrics stream, top
// processes); a worker's charts come from GET /api/cluster/nodes/:id/metrics?range= and its log tail on demand
// (GET /api/cluster/nodes/:id/logs?tail=200, fetched over the worker's socket). A worker opened from the controller's
// detail goes back to it on Escape or the back button.
const ND_RANGES = ['15m', '1h', '6h', '24h'];
// els: the sheet's parts (charts grid, running list, log section, log button), built per open; back: the node to return to.
const ND = { id: null, range: ND_RANGES.includes(store.get('cw.nd.range')) ? store.get('cw.nd.range') : '1h', samples: null, err: '', at: 0, seq: 0,
  runs: new Map(), taskKey: '', log: null, lastFocus: null, draws: [], els: {}, back: null, fold: 0 };
// A worker's tiles, styled as this server's: [key, title, value of a sample, format, top of the scale, status, detail,
// optional (hidden while no sample has it)].
const ND_CHARTS = [
  ['cpu', 'CPU', (s) => s.cpu, fmtPct, () => 100, (v) => level(v), (n) => (n.inventory?.cores ? `${plural(n.inventory.cores, 'core')}${n.resources?.load ? ` · load <b>${n.resources.load[0].toFixed(2)}</b>` : ''}` : '')],
  ['mem', 'Memory', (s, n) => (n.inventory?.mem && s.mem != null ? Math.max(0, (1 - s.mem / n.inventory.mem) * 100) : null), fmtPct, () => 100, (v) => level(v),
    (n) => (n.inventory?.mem && n.resources?.memAvailable != null ? `Available <b>${fmtGB(n.resources.memAvailable)}</b> of ${fmtGB(n.inventory.mem)}` : '')],
  ['disk', 'Disk free', (s) => s.disk, (v) => fmtBytes(v), (n, vals) => Math.max(n.resources?.disk?.total || 0, ...vals) * 1.05,
    (v, n) => (n.resources?.disk?.total ? level((1 - v / n.resources.disk.total) * 100, 80, 92) : null), (n) => (n.resources?.disk?.total ? `of ${fmtGB(n.resources.disk.total)} on the disk that holds its repos` : '')],
  ['net', 'Network', (s) => s.netMs, (v) => `${Math.round(v)} ms`, (n, vals) => Math.max(50, ...vals) * 1.2, null, () => 'Round trip to this server', true],
  ['load', 'Load average', (s) => s.load, (v) => v.toFixed(2), (n, vals) => Math.max(n.inventory?.cores || 1, ...vals) * 1.15,
    (v, n) => level((v / (n.inventory?.cores || 1)) * 100, 80, 150), (n) => (n.inventory?.cores ? `${plural(n.inventory.cores, 'core')}, so ${n.inventory.cores}.00 means fully busy` : '')],
];
// The controller before GET /api/cluster/nodes has answered: its details need no node row.
const ndNode = () => MC.nodes.find((n) => n.id === ND.id)
  || (ND.id === 'controller' ? { id: 'controller', local: true, name: MINI.host || $('hostName').textContent, connected: true, enabled: true, tasks: [] } : undefined);
function openNode(id) {
  if (!MC.nodes.some((n) => n.id === id) && id !== 'controller') return;
  if (!mxOpen()) openMachines();
  const open = !$('nodeModal').hidden;
  if (open && id === ND.id) return;
  const back = open && ndNode()?.local ? ND.id : null; // a worker opened from this server's details
  Object.assign(ND, { id, back, samples: null, err: '', at: 0, runs: new Map(), taskKey: '', log: null, lastFocus: open ? ND.lastFocus : document.activeElement });
  $('nodeModal').hidden = false;
  ndBuild();
  ndRender();
  mcRender();
  ndMetrics();
  $('ndBody').scrollTop = 0;
  $('nodeModal').querySelector('.nd').classList.remove('scrolled');
  (back ? $('ndBack') : $('nodeModal').querySelector('[data-close].icon-btn')).focus();
}
// Back to this server's details when a worker was opened from them; `all` closes the panel.
function closeNode(all) {
  if ($('nodeModal').hidden) return;
  if (!all && ND.back) {
    const to = ND.back, focus = ND.lastFocus;
    ND.back = null;
    $('nodeModal').hidden = true;
    openNode(to);
    ND.lastFocus = focus;
    return;
  }
  $('nodeModal').hidden = true;
  parkServerDetails();
  ND.id = ND.back = null;
  if (CA_WIDE.matches) mcRender(); // its machine card goes back to the stash
  ND.lastFocus?.focus?.({ preventScroll: true });
}
$('nodeModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeNode(true); });
$('ndBack').addEventListener('click', () => closeNode());
// Phones: the large title folds into the bar once the page scrolls (one class write per frame at most).
$('ndBody').addEventListener('scroll', () => {
  if (ND.fold) return;
  ND.fold = requestAnimationFrame(() => { ND.fold = 0; $('nodeModal').querySelector('.nd').classList.toggle('scrolled', isPhone() && $('ndBody').scrollTop > 24); });
}, { passive: true });
// Phones: swipe from the left edge back to the list (or this server), the page following the finger.
(() => {
  const page = $('nodeModal').querySelector('.nd');
  let sw = null;
  const reset = () => { page.style.transition = ''; page.style.transform = ''; };
  $('nodeModal').addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sw = isPhone() && e.touches.length === 1 && t.clientX < 28 ? { x: t.clientX, y: t.clientY, t: e.timeStamp, dx: 0, on: false, raf: 0 } : null;
  }, { passive: true });
  $('nodeModal').addEventListener('touchmove', (e) => {
    if (!sw) return;
    const t = e.touches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y;
    if (!sw.on) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { sw = null; return; } // a scroll
      if (dx < 8) return;
      sw.on = true;
    }
    e.preventDefault();
    sw.dx = Math.max(0, dx);
    sw.v = sw.dx / Math.max(1, e.timeStamp - sw.t);
    if (!sw.raf) sw.raf = requestAnimationFrame(() => { if (sw) { sw.raf = 0; page.style.transform = `translateX(${sw.dx}px)`; } });
  }, { passive: false });
  const end = () => {
    const s = sw;
    sw = null;
    if (!s?.on) return;
    cancelAnimationFrame(s.raf);
    const w = page.clientWidth, go = s.dx > w * 0.35 || (s.dx > 40 && s.v > 0.5), still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still) { reset(); if (go) closeNode(); return; }
    page.style.transition = 'transform .2s ease-out';
    page.style.transform = `translateX(${go ? w : 0}px)`;
    setTimeout(() => { reset(); if (go) closeNode(); }, 200);
  };
  $('nodeModal').addEventListener('touchend', end);
  $('nodeModal').addEventListener('touchcancel', end);
})();
// Escape: a drag is dropped back, then the panel closes (or goes back to this server), then the view. The task drawer
// and Add machine sit above and take it first.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !mxOpen() || !$('machineModal').hidden || O.drawer) return;
  e.stopImmediatePropagation();
  if (Q.drag) endDrag(false);
  else if (!$('nodeModal').hidden) closeNode();
  else closeMachines();
}, true);
function ndBuild() {
  const n = ndNode(), body = $('ndBody'), run = section('Running here'), log = section('Log'), machine = section('Machine');
  run.id = 'ndRun';
  log.id = 'ndLog';
  machine.id = 'ndMachine';
  $('sdStash').append($('mMachines')); // out of the old body; mcHome puts it into this one's Machine section
  ND.els = { run, log, machine };
  ndBackLabel();
  const phone = isPhone() && ndPhoneSections();
  if (n.local) {
    // This server: its details (charts, then Running here in its slot, top processes), then the log.
    ND.draws = [];
    for (const c of [...body.children]) if (c.id !== 'serverDetails') c.remove();
    $('sdRun').replaceChildren(run);
    renderServerDetails(body);
    if (phone) { body.prepend(phone.info); body.append(phone.hist, phone.set); }
    body.append(machine, log);
    ndLogRender();
    mcHome();
    return;
  }
  parkServerDetails();
  const row = el('div', 'range-row'), pick = el('div', 'range-picker');
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
  const grid = el('div', 'm-grid nd-grid');
  grid.id = 'ndCharts';
  ND.draws = ND_CHARTS.map(([key, title, get, fmt, top, status, detail, optional]) => {
    const card = el('div', 'm-card nd-chart'), headRow = el('div', 'tile-top'), st = el('span', 'status'), big = el('div', 'big nd-val', '–'), info = el('div', 'detail'), host = el('div');
    card.dataset.chart = key;
    headRow.append(el('h3', '', title), st);
    card.append(headRow, big, info, host);
    grid.append(card);
    return ndChart(host, get, fmt, top, (last, node, has) => {
      big.textContent = last != null ? fmt(last) : '–';
      const [cls, word] = (last != null && status?.(last, node)) || ['', ''];
      st.className = 'status' + (cls ? ' ' + cls : '');
      st.textContent = word;
      info.innerHTML = detail(node);
      card.hidden = !!optional && !has && !!ND.samples;
    });
  });
  ND.els.charts = grid;
  body.replaceChildren(...(phone ? [phone.info, row, grid, run, phone.hist, phone.set] : [row, grid, run]), machine, log);
  ndLogRender();
  mcHome();
}
// The back button: to this server's details (a worker opened from them), or on phones to the list ('‹ Machines').
function ndBackLabel() {
  const to = ND.back && MC.nodes.find((x) => x.id === ND.back);
  $('ndBack').hidden = !ND.back && !isPhone();
  $('ndBackT').textContent = ND.back ? to?.name || 'This server' : 'Machines';
  $('ndBack').setAttribute('aria-label', ND.back ? 'Back to this server' : 'Back to Machines');
}
// Phones: the card's other parts move to the detail page: status (health, agents, ping, update), recent history, settings.
function ndPhoneSections() {
  const info = el('section', 'dr-sec nd-info'), hist = section('Recent'), set = section('Machine settings');
  hist.id = 'ndHist';
  set.id = 'ndSet';
  Object.assign(ND.els, { info, hist, set, keys: {} });
  return { info, hist, set };
}
function ndPhoneRender(n) {
  const { info, hist, set, keys } = ND.els;
  if (!info) return;
  const k = `${Math.floor(Date.now() / 60e3)}|${nodeKey(n)}|${JSON.stringify([MC.target, MC.rollout, VER.running?.build])}`;
  if (keys.info !== k || MC.pings.has(n.id)) {
    keys.info = k;
    const inv = n.inventory || {}, u = nodeUsage(n), gauges = el('div', 'mo-gauges nd-gauges');
    gauges.append(ringGauge('CPU', u.cpu, inv.cores && plural(inv.cores, 'core')), ringGauge('Memory', u.mem, inv.mem && `${fmtGB(n.resources?.memAvailable)} free`));
    const ag = el('div', 'mc-agents'), signed = (inv.agents || []).filter((a) => a.signedIn);
    for (const a of signed) ag.append(el('span', 'tc-tag on', a.account ? `${agentLabel(a.id)} · ${a.account}` : agentLabel(a.id)));
    if (!signed.length) ag.append(el('span', 'mc-idle', runnerSignIn(n) || (inv.agents ? 'No agents signed in' : 'Agents not reported yet')));
    const pool = !n.local && poolLine(n), ping = !n.local && pingBox(n);
    info.replaceChildren(gauges, ...machineHealth(n), ...(pool ? [pool] : []), ...(ping ? [ping] : []), ag, ...(canUpdate(n) ? [updateButton(n)] : []));
  }
  const rk = JSON.stringify(n.recent || []) + Math.floor(Date.now() / 60e3);
  if (keys.hist !== rk) {
    keys.hist = rk;
    hist.replaceChildren(hist.firstElementChild);
    if (!n.recent?.length) hist.append(el('p', 'nd-note', 'Nothing finished here this week.'));
    for (const t of n.recent || []) {
      const b = el('button', `mc-task nd-hrow ${t.status}`), main = el('span');
      b.type = 'button';
      b.dataset.task = t.id;
      main.append(el('span', 't', displayTitle(t)), el('span', 's', [`#${t.id}`, t.project, t.status === 'done' ? 'Done' : t.status === 'failed' ? 'Failed' : 'Cancelled'].filter(Boolean).join(' · ')));
      b.append(el('i', 'nd-hmark'), main, el('span', 'e', relTime(t.finished_at * 1000)));
      b.addEventListener('click', () => openTask(t.id));
      hist.append(b);
    }
  }
  // Settings: rebuilt only when the machine changed, never under a menu or field in use; focus stays on the same control.
  const sk = `${nodeKey(n)}|${MC.soundAdd}`, f = document.activeElement;
  if (keys.set === sk || (set.contains(f) && f.matches('select, input:not([type=checkbox])'))) return;
  keys.set = sk;
  const act = set.contains(f) && f.dataset.act;
  set.replaceChildren(set.firstElementChild, machineSettings(n, true));
  if (act) set.querySelector(`[data-act="${CSS.escape(act)}"]`)?.focus({ preventScroll: true });
}
function ndRender() {
  const n = ndNode();
  if (!n) return closeNode(true); // removed meanwhile
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
    const wrap = el('div', 'nd-task');
    wrap.append(mcTaskRow(t));
    const tl = ND.runs.get(t.id) && timelineSection(ND.runs.get(t.id), true);
    if (tl) wrap.append(tl);
    box.append(wrap);
  }
  box.append(renderAssignButton(n));
  ndPhoneRender(n);
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
  if (!grid) return; // this server's charts follow the metrics stream instead
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
// onValue(latest value, node, any value in range) fills the tile around it.
function ndChart(host, get, fmt, top, onValue) {
  host.className = 'sline';
  host.innerHTML = '<svg aria-hidden="true"><line class="base"/><path class="area"/><path class="line"/><line class="cross" hidden/><circle class="pt" r="4" hidden/></svg><div class="tip" hidden></div>';
  const svg = host.querySelector('svg'), [base, area, line, cross, pt] = svg.children, tip = host.querySelector('.tip');
  const label = el('div', 'sline-label'), [lFrom, lStat] = [el('span'), el('span', 'stat')], yTop = el('span', 'sline-y');
  label.append(lFrom, lStat, el('span', '', 'now'));
  host.after(label);
  host.append(yTop); // the top of the scale (phones)
  let hoverX = null, pts = [];
  function draw() {
    const n = ndNode(), w = host.clientWidth, h = host.clientHeight, end = Date.now(), start = end - RANGE_MS[ND.range], span = end - start;
    if (!n) return;
    pts = (ND.samples || []).map((s) => [s.t, get(s, n)]).filter(([t, v]) => v != null && Number.isFinite(v) && t >= start);
    onValue(pts.at(-1)?.[1], n, pts.length > 0);
    if (!w) return;
    lFrom.textContent = RANGE_AGO[ND.range];
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    for (const [k, v] of [['x1', 0], ['x2', w], ['y1', h - 0.5], ['y2', h - 0.5]]) base.setAttribute(k, v);
    if (pts.length < 2) {
      line.setAttribute('d', '');
      area.setAttribute('d', '');
      lStat.textContent = ND.err || (ND.samples ? 'collecting…' : 'loading…');
      cross.setAttribute('hidden', ''); pt.setAttribute('hidden', ''); tip.hidden = true;
      return;
    }
    const vals = pts.map((p) => p[1]), max = top(n, vals) || 1;
    yTop.textContent = fmt(max);
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
  chartPointer(host, (x) => { hoverX = x; }, () => draw());
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
// Live times while the Machines view is open: elapsed per task (cards, lanes, the detail) and the running step of each timeline.
setInterval(() => {
  if (!mxOpen()) return;
  for (const n of document.querySelectorAll('#mxModal :is(.mc-task, .cc-task) .e[data-started]')) n.textContent = fmtDur(Date.now() / 1000 - Number(n.dataset.started));
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
  if (mxOpen()) loadMachines();
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
    const pace = s.stale ? null : paceMark(s.pct, reset, paceWinMs(w), now);
    c.title = `Read ${fmtWhen(s.t)}${s.stale ? ' (older than the window)' : ''}${pace ? `\n${pace.tip}` : ''}`;
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
  const c = usageChart(host, 'ug-line', '<line class="cap"/><g class="resets"></g><g class="paces"></g><g class="lines"></g>');
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
    // Each window's ideal pace: a faint dashed diagonal from 0 at its start to 100% at its reset.
    const ag = svg.querySelector('.paces');
    ag.replaceChildren();
    series.forEach((pts, i) => {
      const len = paceWinMs(names[i]);
      for (const r of new Set(pts.map((p) => p.resetsAt * 1000).filter(Boolean))) {
        const t0 = Math.max(from, r - len), t1 = Math.min(to, r);
        if (t1 <= t0) continue;
        const v = (t) => ((t - (r - len)) / len) * 100;
        ag.append(ns('line', { class: 'pace', x1: x(t0), y1: y(v(t0)), x2: x(t1), y2: y(v(t1)), style: `stroke:${SERIES[i % SERIES.length]}` }));
      }
    });
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
// The sidebar can fold the server and usage cards to one line each; remembered per browser.
function msFold(folded) {
  $('miniStatsCard').classList.toggle('folded', folded);
  $('msFold').setAttribute('aria-expanded', String(!folded));
  const label = `${folded ? 'Expand' : 'Collapse'} server and usage`;
  $('msFold').setAttribute('aria-label', label);
  $('msFold').title = label;
}
msFold(store.get('cw.statsFolded') === '1');
$('msFold').addEventListener('click', (e) => {
  e.stopPropagation(); // not the card's own click (open usage)
  const folded = !$('miniStatsCard').classList.contains('folded');
  store.set('cw.statsFolded', folded ? '1' : '0');
  msFold(folded);
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
const kindLabel = (t) => (t.kind === 'reflect' ? 'Reflection' : t.kind === 'plan' ? 'Planner' : t.kind === 'review' ? 'Review break' : t.source === 'reflection' ? 'Task · from reflection' : t.source === 'schedule' ? 'Task · scheduled' : 'Task');

function taskState(t) {
  const nowS = Date.now() / 1000;
  if (t.kind === 'review') { // a checkpoint (flag glyph): it never runs, it waits for the owner
    if (t.status === 'awaiting_review') return { cls: 'review awaiting', label: `Waiting for your review${t.review?.task ? ` of #${t.review.task}` : ''}` };
    if (t.status === 'queued') return { cls: 'review', label: 'Wait for your review' };
    if (t.status === 'done') return { cls: 'review done', label: 'Approved' };
  }
  switch (t.status) {
    case 'running':
      if (t.approvals?.length) return { cls: 'running awaiting', label: `Awaiting your approval${t.approvals.length > 1 ? ` · ${t.approvals.length} actions` : ''}` };
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
  syncPhaseStrip(b, t, s);
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
  if (b.isConnected) { syncReviewPanel(b, t); syncApprovalPanels(b, t); }
  else queueMicrotask(() => { if (b.isConnected) { syncReviewPanel(b, O.tasks.get(id)); syncApprovalPanels(b, O.tasks.get(id)); } });
}
// A card's Timeline bar, the drawer Timeline's .tl-bar in compact form (3px, 1px gaps, no step list) just above the card's
// bottom edge: one segment per step of the task's latest run, each taking its share of the time (the queue wait, then the
// run's phase_log from the server), done steps neutral, the step in progress in the running blue (growing live), a
// failed task's last step in red. Its hover title lists the steps with their times and names the current one.
const PHASE_LABEL = { queued: 'Queued', cloning: 'Cloning', fetching: 'Fetching', installing: 'Installing', running: 'Agent', checking: 'Checking',
  committing: 'Committing', pushing: 'Pushing', merging: 'Merging', done: 'Done' };
function stripDur(sec) {
  sec = Math.max(0, Math.round(sec));
  return sec < 60 || sec >= 3600 ? fmtDur(sec) : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
const PH_LOG = new Map(); // task id → the phase_log last seen while it ran (a finished task's view carries none)
// A task's strip: [{phase, ms, cls, since}], oldest first (since: the live step's virtual start, for the ticker).
function stripSegs(t, s) {
  const nowMs = Date.now(), created = (t.created_at || 0) * 1000, started = (t.started_at || 0) * 1000;
  const live = t.status === 'running', waiting = live && (t.waiting_for || s.cls.includes('awaiting'));
  if (!started || t.status === 'queued') {
    const cls = t.status === 'queued' ? (s.cls === 'limited' ? 'limit' : 'cur') : 'stopped';
    return [{ phase: 'queued', ms: Math.max(0, nowMs - created), cls, since: t.status === 'queued' ? created || nowMs : null }];
  }
  if (t.phase_log?.length) PH_LOG.set(t.id, t.phase_log);
  const fin = (t.finished_at || 0) * 1000, end = live || t.status === 'paused' || !fin ? nowMs : fin;
  let log = (live && t.phase_log) || PH_LOG.get(t.id);
  if (!log?.length || log[0][1] < started - 5000) log = [['running', started]]; // none seen, or an earlier run's
  const segs = created && started > created ? [{ phase: 'queued', ms: started - created }] : [];
  log.forEach(([phase, at], n) => {
    const ms = Math.max(0, (n + 1 < log.length ? log[n + 1][1] : end) - at);
    if (segs.at(-1)?.phase === phase) segs.at(-1).ms += ms;
    else segs.push({ phase, ms });
  });
  const last = segs.at(-1);
  if (live) Object.assign(last, { cls: waiting ? 'limit' : 'cur', since: nowMs - last.ms });
  else if (t.status === 'failed') last.cls = 'bad';
  else if (t.status === 'paused' || t.status === 'cancelled') last.cls = 'stopped';
  else if (t.status === 'needs_integration') segs.push({ phase: 'merging', ms: Math.max(0, nowMs - end), cls: 'limit', since: end });
  else if (t.status === 'done') segs.push({ phase: 'done', ms: 0 });
  return segs;
}
// Whether a task has a started run to show a Timeline for (#521): not while it waits (queued, whatever it waits on: a
// prerequisite, a limit, approval) or for a checkpoint, which never runs; a paused or finished one keeps its last timeline.
const hasStartedRun = (t) => !!t.started_at && t.kind !== 'review' && t.status !== 'queued' && t.status !== 'awaiting_review';
function syncPhaseStrip(b, t, s) {
  let bar = b.querySelector(':scope > .tl-bar');
  if (!hasStartedRun(t)) { bar?.remove(); return; } // no element at all until a run starts
  if (!bar) {
    bar = b.appendChild(el('span', 'tl-bar compact'));
    bar.addEventListener('pointerenter', () => bar._redo?.()); // the live step's time, fresh on hover
  }
  bar._redo = () => {
    const segs = stripSegs(t, s).filter((g) => g.phase !== 'done'), dur = (g) => `${PHASE_LABEL[g.phase] || g.phase} ${stripDur(g.ms / 1000)}`;
    bar.replaceChildren(...segs.map((g) => {
      const cls = g.cls === 'cur' || g.cls === 'limit' ? 'cur' : g.cls === 'bad' ? 'bad' : '', i = el('i', cls);
      i.style.flex = `${Math.max(1, g.ms)} 0 3px`;
      if (cls === 'cur' && g.since != null) i.dataset.since = g.since;
      i.title = dur(g);
      return i;
    }));
    const now = segs.find((g) => g.cls === 'cur' || g.cls === 'limit');
    bar.title = segs.map(dur).join(' · ') + (now ? `\nNow: ${PHASE_LABEL[now.phase] || now.phase}` : '');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `Time per step: ${segs.map(dur).join(', ')}${now ? `; now ${PHASE_LABEL[now.phase] || now.phase}` : ''}`);
  };
  bar._redo();
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
  if (r.shots?.length) p.append(screenStrip(r.shots, 'Final screen', 4));
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
// ----- the approval gate (gate.mjs): a browser or connector action held before it ran. The owner sees the exact action
// and the page, and answers Approve once / Always allow this action for this task / Deny (the reason goes to the agent).
// Unanswered, it is denied when it expires. Shown under the task's card (chat, Queue) and at the top of its drawer.
const AP = { busy: new Set(), deny: new Map() }; // deny: approval id -> the reason being typed (survives re-renders)
async function decideApproval(a, decision, reason) {
  AP.busy.add(a.id);
  try {
    await api(`/api/orch/approvals/${encodeURIComponent(a.id)}`, 'POST', { decision, ...(reason && { reason }) });
    AP.deny.delete(a.id);
    const t = O.tasks.get(a.task);
    if (t) { t.approvals = (t.approvals || []).filter((x) => x.id !== a.id); refreshCards(t.id); }
    toast(decision === 'deny' ? 'Denied: the agent was told why' : decision === 'always' ? 'Approved, and allowed for the rest of this task' : 'Approved', { kind: 'success' });
  } catch (e) { toast(e.message, { kind: 'error' }); }
  finally {
    AP.busy.delete(a.id);
    if (O.drawer === a.task) { loadDetail(); loadActions(a.task); }
  }
}
function approvalPanel(a) {
  const p = el('div', 'rv-panel ap-panel');
  p.dataset.id = a.id;
  p.append(el('div', 'rv-head', `#${a.task} is waiting for your approval`), el('div', 'ap-action', a.action || `${a.server}: ${a.tool}`));
  const meta = [];
  if (a.url) meta.push(a.url);
  if (a.expires) meta.push(`denied automatically ${fmtWhen(a.expires)} unless you answer`);
  if (meta.length) p.append(el('div', 'muted ap-meta', meta.join(' · ')));
  if (a.screenshot) p.append(shotGrid([{ id: a.screenshot, name: 'The page when it asked' }]));
  const busy = AP.busy.has(a.id), row = el('div', 'rv-actions');
  const ok = el('button', 'btn small primary', 'Approve once');
  const always = el('button', 'btn small', 'Always allow for this task');
  always.title = 'Approve this, and let the same action through without asking again until this task ends';
  const no = el('button', 'btn small danger', 'Deny…');
  const form = el('form', 'rv-change');
  form.hidden = !AP.deny.has(a.id);
  const note = el('textarea');
  note.rows = 2;
  note.placeholder = 'Why not? The agent is told, and does not do it.';
  note.setAttribute('aria-label', 'Reason for denying');
  note.value = AP.deny.get(a.id) || '';
  note.oninput = () => AP.deny.set(a.id, note.value);
  const send = el('button', 'btn small danger', 'Deny');
  form.append(note, send);
  for (const x of [ok, always, no, send]) { x.type = x === send ? 'submit' : 'button'; x.disabled = busy; }
  ok.onclick = () => decideApproval(a, 'approve');
  always.onclick = () => decideApproval(a, 'always');
  no.onclick = () => { form.hidden = !form.hidden; if (form.hidden) AP.deny.delete(a.id); else { AP.deny.set(a.id, note.value); note.focus(); } };
  form.onsubmit = (e) => { e.preventDefault(); decideApproval(a, 'deny', note.value.trim()); };
  row.append(ok, always, no);
  p.append(row, form);
  return p;
}
// Under a chat card: one panel per held action, rebuilt only when the set changes (a typed reason is kept in AP.deny).
function syncApprovalPanels(b, t) {
  const list = b.parentElement?.closest('.task-cards, #qBody') ? t?.approvals || [] : [];
  const sig = list.map((a) => a.id).join(',') + (list.some((a) => AP.busy.has(a.id)) ? ':busy' : '');
  const old = [];
  for (let n = b.nextElementSibling; n?.classList.contains('ap-panel'); n = n.nextElementSibling) old.push(n);
  if ((b.dataset.ap || '') === sig && old.length === list.length) return;
  b.dataset.ap = sig;
  for (const n of old) n.remove();
  b.after(...list.map(approvalPanel));
}
// The drawer's Actions timeline: every browser/connector call of the task (its audit log), newest first.
const ACT = { task: null, data: null, open: false };
async function loadActions(id) {
  try {
    const d = await api(`/api/orch/tasks/${id}/actions`);
    if (O.drawer !== id) return;
    ACT.task = id; ACT.data = d;
    const sec = $('drBody').querySelector('.dr-actions-log');
    if (sec) sec.replaceWith(actionsSection(id));
  } catch {}
}
const CLASS_LABEL = { read: 'Read', draft: 'Draft', outbound: 'Outbound' };
const DECISION_LABEL = { approve: 'approved by you', always: 'approved, always for this task', auto: 'allowed (you said always)', deny: 'denied by you', expired: 'denied: no answer in time' };
function actionsSection(id) {
  const d = el('details', 'dr-more dr-actions-log');
  d.open = ACT.open;
  const data = ACT.task === id ? ACT.data : null, entries = data?.entries || [];
  d.append(el('summary', '', `Actions${entries.length ? ` · ${entries.length}` : ''}`));
  d.addEventListener('toggle', () => { ACT.open = d.open; if (d.open) loadActions(id); });
  if (!data) { d.append(el('div', 'muted', 'Loading…')); return d; }
  if (!entries.length) { d.append(el('div', 'muted', 'No browser or connector actions yet. Every one is logged here, and outbound ones wait for your approval.')); return d; }
  const ul = el('ol', 'act-list');
  for (const e of entries.slice().reverse()) {
    const li = el('li', `act act-${e.class}${e.ok === false ? ' act-fail' : ''}`);
    const head = el('div', 'act-head');
    head.append(el('span', `act-cls ${e.class}`, CLASS_LABEL[e.class] || e.class), el('span', 'act-what', e.action || `${e.server}: ${e.tool}`));
    li.append(head);
    const bits = [fmtWhen(e.ts), e.tool];
    if (e.decision) bits.push(DECISION_LABEL[e.decision] || e.decision);
    if (e.note) bits.push(`"${e.note}"`);
    if (e.ok === false && !e.decision) bits.push('failed');
    if (e.broken) bits.push('⚠ log chain broken here');
    li.append(el('div', 'muted act-meta', bits.join(' · ')));
    if (e.screenshot) li.append(shotGrid([{ id: e.screenshot, name: e.action || e.tool }]));
    ul.append(li);
  }
  d.append(ul);
  return d;
}

// The machine a running task is on ('on vps-2', 'waiting for Mac mini (connection lost)'), or a queued one is pinned to
// ('only on MacBook Air'); tasks on the controller say
// 'on this server' only once the cluster has workers (MC.nodes, read when the Queue or a node detail opens).
function taskMachine(t) {
  if (t.status === 'queued' && t.run_on_name) return `only on ${t.run_on_name}`; // pinned by the owner (Run on)
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
  syncAppBadge();
  renderUsage();
  renderOrchBar();
  renderUpdateBanner();
  refreshAllCards();
  scheduleQueue();
}

function onOrch(msg) {
  window.bxOnOrch?.(msg); // the Browser tab's activity panel (browser.js)
  if (msg.t === 'olane') return caEvent(msg.taskId); // live lane activity: particles on the cluster diagram (no lanes in the Queue)
  if (msg.t === 'otask' || msg.t === 'ostate') scheduleMachines(); // running tasks per machine
  if (msg.t === 'otask') {
    caTask(msg.task);
    observeTaskCompletion(msg.task);
    if (FB.local?.url === `/api/orch/tasks/${msg.task.id}/fallbacks`) msg.task.fallbacks = FB.local.list; // a save still in flight
    O.tasks.set(msg.task.id, msg.task);
    syncAppBadge();
    syncSidebarRunning();
    renderUsage();
    refreshCards(msg.task.id);
    for (const other of O.tasks.values()) if (taskDeps(other).includes(msg.task.id)) refreshCards(other.id);
    if (O.drawer === msg.task.id) { renderDrawerHead(); scheduleDetail(); }
    if (msg.task.project_id === O.project?.id) scheduleQueue();
  } else if (msg.t === 'oapproval') {
    // A held action: a sound (the task-sound switch) and a toast that opens the task, even while this tab has focus.
    const a = msg.approval, t = O.tasks.get(a.task);
    if (t) {
      t.approvals = msg.kind === 'new' ? [...(t.approvals || []).filter((x) => x.id !== a.id), a] : (t.approvals || []).filter((x) => x.id !== a.id);
      syncAppBadge();
      refreshCards(t.id);
      if (O.drawer === t.id) { renderDrawerHead(); scheduleDetail(); }
    }
    if (O.drawer === a.task && ACT.open) loadActions(a.task);
    if (msg.kind === 'new') {
      toast(`#${a.task} needs your approval: ${a.action}`, { kind: 'warn', duration: 15000, action: 'Review', run: () => showTask(a.task) });
      if ($('stSound').checked) void playTaskSound();
    }
  } else if (msg.t === 'oorder') {
    for (const r of msg.order || []) { const t = O.tasks.get(r.id); if (t) t.position = r.position; }
    if (msg.project_id === O.project?.id) scheduleQueue();
  } else if (msg.t === 'oproject') {
    window.Schedules?.changed(); // its schedules ride on the project (schedules.js)
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
    if (!$('queueModal').hidden) scheduleQueue(); // its 'Waiting: …' line follows the stall reason
  } else if (msg.t === 'orun' && O.drawer === msg.taskId && O.detail) {
    appendRunEntry(msg.runId, msg.e);
  }
}

// ----- the status bar above the chat
// #452: 'Running X · Queue Y' (X = running tasks on every machine, Y = queued ones, waiting on a prerequisite included),
// 'Paused · Queue Y' or 'Idle'. The Queue button shows no count of its own, so Y appears once.
function orchBarStatus(paused, running, queued) {
  if (paused) return { text: `Paused · Queue ${queued}`, state: 'paused' };
  if (!running && !queued) return { text: 'Idle', state: 'idle' };
  return { text: `Running ${running} · Queue ${queued}`, state: running ? 'running' : 'waiting' };
}
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
  // One short status; detail belongs in the Queue modal (.agent-orch/CONTEXT.md: the bar stays minimal).
  const status = orchBarStatus(paused, p?.counts?.running || 0, p?.counts?.queued || 0);
  blurSwap($('obStatus'), status.text);
  $('obState').dataset.state = status.state;
  $('obState').title = s.rapid?.reason || (s.pacing ? `Pacing: ${s.pacing}` : '');
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
  if (meAdmin()) loadGatePatterns();
  loadRigorLevels();
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
// ----- Version (under the sidebar logo): the build this server runs and since when (ws 'version' on connect), and the
// newer one on disk (GET /api/version), in its tooltip; there is no About section in Settings (#481). A build newer than the one this tab (or, on a fresh load, this browser) last saw toasts.
const VER = { running: null, seq: 0, about: null };
// Build N (git rev-list --count) → 'v<N/100>.<N%100, two digits>', like version.mjs formatVersion: 352 → 'v3.52'.
function fmtVersion(n) { return Number.isInteger(n) && n >= 0 ? `v${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}` : null; }
function onVersion(running) {
  const b = running?.build, prev = VER.running?.build || Number(store.get('cw.build')) || 0;
  VER.running = running || null;
  apiServerVersion(b);
  if (b) {
    if (prev && b > prev) toast(`Updated to ${fmtVersion(b)}`, { kind: 'success', duration: 8000 });
    store.set('cw.build', String(b));
  }
  renderSideVer(running);
  loadAbout();
}
// The version line under the sidebar logo: 'v3.52'. Its tooltip is the old About section's lines (aboutLines) once GET
// /api/version answers, else 'v3.52 · a1b2c3d · restarted 13:05'. A tap (no hover on phones) shows them as a toast.
function sideVerTip(r) { return [fmtVersion(r?.build), r?.sha?.slice(0, 7), r?.startedAt && `restarted ${fmtWhen(r.startedAt)}`].filter(Boolean).join(' · '); }
function renderSideVer(r) {
  const v = fmtVersion(r?.build), a = VER.about;
  $('sideVer').hidden = !v;
  $('sideVer').textContent = v || '';
  $('sideVer').title = !v ? '' : a ? [a.running, a.restarted, a.pending].filter(Boolean).join('\n') : sideVerTip(r);
}
async function loadAbout() {
  const seq = ++VER.seq;
  try {
    const d = await api('/api/version');
    if (seq !== VER.seq) return;
    VER.about = aboutLines(d);
    renderSideVer(VER.running || d?.running);
  } catch {}
}
// The About text for a GET /api/version answer, in the browser's timezone (pure: test/version-ui.test.mjs).
function aboutLines(d, now = Date.now()) {
  const r = d?.running || {}, disk = d?.disk, rs = d?.restart || {}, waits = !!(rs.pending || rs.auto);
  return {
    running: r.sha ? `Running ${fmtVersion(r.build) || 'version ?'} (${r.sha.slice(0, 7)})${r.subject ? ` · "${r.subject}"` : ''}` : 'Running version unknown (not a git checkout)',
    runningTip: r.committedAt ? `Committed ${fmtWhen(r.committedAt, now)}` : '',
    restarted: r.startedAt ? `Restarted ${relTime(r.startedAt, now)} (${fmtWhen(r.startedAt, now)}) · up ${fmtDur((now - r.startedAt) / 1000)}` : '',
    restartedTip: r.serviceStartedAt ? `Service started ${fmtWhen(r.serviceStartedAt, now)}` : '',
    pending: disk?.ahead > 0 ? `${fmtVersion(disk.build) || 'A newer version'} ready (${disk.ahead} newer)${waits ? ' · restarts when idle' : ''}` : null,
    restartButton: disk?.ahead > 0 && !waits,
  };
}
$('sideVer').addEventListener('pointerenter', loadAbout);
$('sideVer').addEventListener('click', async () => {
  await loadAbout();
  toast($('sideVer').title.replace(/\n/g, ' · '), { duration: 8000 });
});
loadAbout();
function renderSettings() {
  if ($('settingsModal').hidden) return;
  const s = O.state || {}, p = O.project;
  renderParallel(s);
  // Disabled until the orchestrator state arrives; not flipped under the owner's finger while a save is in flight.
  $('stRapid').disabled = !s.parallel;
  if (document.activeElement !== $('stRapid')) $('stRapid').checked = s.parallel?.rapidDevelopment !== false;
  $('stRapidHint').textContent = s.rapid?.reason || 'Keep free slots fed with small parallel tasks. Off waits for an empty queue.';
  $('stApplyUpdates').disabled = !s.parallel;
  if (document.activeElement !== $('stApplyUpdates')) $('stApplyUpdates').value = s.parallel?.applyUpdates || 'auto';
  renderReflectPool();
  $('stProject').hidden = !p;
  if (!p) return;
  $('stProjectTitle').textContent = `This project · ${p.path.split('/').pop()}`;
  renderRigor();
  // Keep improving (projects.perpetual): live from the project pushes, not flipped while a save is in flight.
  if (!PERP.saving) $('stPerpetual').checked = !!p.perpetual;
  // Never overwrite what the owner is typing (renderSettings runs on every state push).
  if (document.activeElement !== $('stDirection') && !DIR.timer && !DIR.saving) { $('stDirection').value = p.reflect_direction || ''; fitDirection(); }
}
// Reflection models (#508, projects.reflect_pool): a checkbox per discovered model of each signed-in agent, grouped by
// agent; each reflection runs on a random checked one. At least one stays checked (default: the chat's model). Saved at
// once (PUT …/reflect-settings {pool}); not rebuilt while focused or saving.
const POOL = { saving: 0 };
function renderReflectPool() {
  const box = $('stReflectPool');
  if (box.contains(document.activeElement) || POOL.saving) return;
  const r = O.project?.reflect || {}, pool = r.pool || [], key = (x) => `${x.agent}\n${x.model}`, on = new Set(pool.map(key));
  const row = (agent, model, label) => {
    const l = el('label', 'st-pool-item'), c = document.createElement('input');
    c.type = 'checkbox'; c.value = `${agent}\n${model}`; c.checked = on.has(c.value);
    l.append(c, el('span', '', label));
    return l;
  };
  const groups = [];
  for (const a of AGENT_LIST) {
    if (!a.models?.length || !a.available || a.loggedIn === false) continue;
    const g = el('div', 'st-pool-group');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', a.label);
    g.append(el('div', 'st-pool-agent', a.label), ...a.models.map((m) => row(a.id, m.id, m.label || m.id)));
    groups.push(g);
  }
  const shown = new Set(groups.flatMap((g) => [...g.querySelectorAll('input')].map((c) => c.value)));
  const gone = pool.filter((x) => !shown.has(key(x)));
  if (gone.length) {
    const g = el('div', 'st-pool-group');
    g.append(el('div', 'st-pool-agent', 'Unavailable'), ...gone.map((x) => row(x.agent, x.model, `${x.agent} · ${x.model}`)));
    groups.push(g);
  }
  box.replaceChildren(...groups);
}
$('stReflectPool').addEventListener('change', async (e) => {
  if (!O.project || e.target.type !== 'checkbox') return;
  const boxes = [...$('stReflectPool').querySelectorAll('input:checked')];
  if (!boxes.length) { e.target.checked = true; toast('Keep at least one reflection model', { kind: 'error' }); return; }
  const pool = boxes.map((c) => { const [agent, model] = c.value.split('\n'); return { agent, model }; });
  POOL.saving++;
  try {
    const d = await api(`/api/orch/projects/${O.project.id}/reflect-settings`, 'PUT', { pool });
    if (d.project && O.project?.id === d.project.id) O.project = d.project;
  } catch (err) { toast(err.message, { kind: 'error' }); }
  POOL.saving--;
  if (!$('stReflectPool').contains(document.activeElement)) renderReflectPool();
});
// Parallel tasks: what can run right now (state.capacity: this server's slots plus online workers') and
// how many run; the owner can only cap it lower ('' = no limit, else maxTasks).
function renderParallel(s) {
  const sel = $('stParallel');
  // A server that predates state.capacity (not restarted since this page's code changed): show what it does report.
  const c = s.capacity || (s.parallel && { running: s.workRunning ?? s.running ?? 0, max: s.slots ?? 0, controller: s.slots ?? 0,
    controllerMax: s.slots ?? 0, workers: 0, pacing: null, cap: s.parallel.maxTasks ?? null });
  sel.disabled = !c;
  renderServerTasks(s, c);
  if (!c) { $('stParHint').textContent = 'Checking what can run…'; if (!sel.options.length) sel.append(new Option('No limit', '')); return; }
  const tight = c.controller < c.controllerMax ? ` of ${c.controllerMax}` : '';
  const where = c.workers ? ` (this server ${c.controller}${tight}, workers ${c.workers})` : tight ? ` (this server ${c.controller}${tight})` : '';
  const bits = [`${c.running} running`, `up to ${c.max} can run now${where}`];
  if (c.pacing != null && c.pacing < c.max) bits.push(`usage pacing allows ${c.pacing}`);
  if (!c.max) bits[1] = 'none can start now: every machine is busy';
  $('stParHint').textContent = bits.join(' · ');
  if (document.activeElement === sel) return; // not rebuilt while the owner is choosing
  const opts = [new Option(`No limit${c.max ? ` (${c.max})` : ''}`, '')];
  const top = Math.max(c.max - 1, c.cap || 0, 1);
  for (let n = 1; n <= top; n++) opts.push(new Option(`At most ${n}`, String(n)));
  sel.replaceChildren(...opts);
  sel.value = c.cap ? String(c.cap) : '';
}
// This server's own work slots (parallelTasks 1-16): the owner's limit; memory is only an emergency floor. controllerMax
// is 0 while workers take the work, so the stored setting shows then.
function renderServerTasks(s, c) {
  const sel = $('stServerTasks');
  sel.disabled = !s.parallel;
  if (document.activeElement === sel) return;
  if (sel.options.length !== 16) sel.replaceChildren(...Array.from({ length: 16 }, (_, i) => new Option(`${i + 1} ${i ? 'tasks' : 'task'}`, String(i + 1))));
  sel.value = String(c?.controllerMax || s.parallel?.parallelTasks || 4);
}
// The approval gate's "Don't allow" rules (one per line; everything else runs without asking), saved on change. The old
// built-in outbound names show under the box as suggestions: a tap adds one as a rule.
async function loadGatePatterns() {
  try {
    const g = await api('/api/orch/gate');
    if (document.activeElement !== $('stGatePatterns')) $('stGatePatterns').value = (g.rules || []).join('\n');
    renderGateSuggest(g);
  } catch {}
}
function renderGateSuggest(g) {
  const box = $('stGateSuggest'), have = new Set((g.rules || []).map((r) => r.toLowerCase()));
  const left = (g.suggestions || []).filter((x) => !have.has(x.toLowerCase()));
  box.replaceChildren(...(left.length ? [el('span', '', 'Suggestions:')] : []), ...left.map((x) => {
    const b = el('button', '', x);
    b.type = 'button';
    b.onclick = () => { const t = $('stGatePatterns'); t.value = `${t.value.trim() ? `${t.value.trimEnd()}\n` : ''}${x}`; saveGateRules(t); };
    return b;
  }));
}
async function saveGateRules(t) {
  try {
    const r = await api('/api/orch/gate', 'PUT', { rules: t.value });
    t.value = r.settings.rules.join('\n');
    renderGateSuggest(r.settings);
    toast(r.settings.rules.length ? 'Saved: matching actions now wait for your approval' : 'Saved: browser tasks now run every action without asking', { kind: 'success' });
    if (typeof bxLoadRules === 'function') bxLoadRules();
  } catch (err) { toast(err.message, { kind: 'error' }); }
}
$('stGatePatterns').addEventListener('change', (e) => saveGateRules(e.target));
$('stParallel').addEventListener('change', (e) => { saveParallel({ maxTasks: e.target.value ? Number(e.target.value) : null }); e.target.blur(); });
$('stServerTasks').addEventListener('change', (e) => { saveParallel({ parallelTasks: Number(e.target.value) }); e.target.blur(); });
$('stRapid').addEventListener('change', async (e) => { await saveParallel({ rapidDevelopment: e.target.checked }); e.target.blur(); renderSettings(); });
$('stApplyUpdates').addEventListener('change', async (e) => { await saveParallel({ applyUpdates: e.target.value }); e.target.blur(); renderSettings(); });
// Rigor (projects.rigor 1-5, #779): how much process the chat planner and reflection put into this project's tasks. Five
// segments (a radiogroup: arrow keys, Home/End) name the levels (GET /api/orch/rigor-levels); the selected one shows its
// name, summary and the example task that level writes. Moving previews; a click, a pointer release or a pause after the
// arrows saves (PATCH the project {rigor}). Pushes don't move it while the owner is on it or a save is in flight.
const RIGOR = { levels: null, loading: null, failed: false, preview: null, saving: 0, timer: null, drag: false, expanded: false };
const RIGOR_DEFAULT = 3; // a project from before rigor existed (the migration sets those to 3)
function loadRigorLevels() {
  if (RIGOR.levels || RIGOR.loading) return RIGOR.loading;
  RIGOR.loading = api('/api/orch/rigor-levels', 'GET', undefined, false)
    .then((d) => { RIGOR.levels = Array.isArray(d) ? d : d.levels || []; RIGOR.failed = false; })
    .catch(() => { RIGOR.failed = true; })
    .finally(() => { RIGOR.loading = null; renderRigor(); });
  return RIGOR.loading;
}
const rigorLevel = (n) => RIGOR.levels?.find((l) => Number(l.level) === n);
const rigorLabel = (n) => (rigorLevel(n)?.name ? `${n} · ${rigorLevel(n).name}` : `Level ${n}`);
function rigorSaved() { const r = Number(O.project?.rigor); return r >= 1 && r <= 5 ? r : RIGOR_DEFAULT; }
function renderRigor() {
  if (!O.project || $('settingsModal').hidden) return;
  const box = $('stRigor');
  if (!RIGOR.saving && !RIGOR.timer && !RIGOR.drag && !box.contains(document.activeElement)) RIGOR.preview = null;
  const n = RIGOR.preview ?? rigorSaved(), l = rigorLevel(n);
  for (const b of box.querySelectorAll('[data-level]')) {
    const lv = Number(b.dataset.level), on = lv === n;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
    b.setAttribute('aria-label', rigorLabel(lv));
    b.title = rigorLevel(lv)?.summary || '';
    b.querySelector('.rg-name').textContent = rigorLevel(lv)?.name || '';
  }
  $('stRigorName').textContent = rigorLabel(n);
  $('stRigorSummary').textContent = l?.summary || (RIGOR.failed ? 'Couldn\'t load the level descriptions' : RIGOR.levels ? '' : 'Loading…');
  const ex = l?.example;
  $('stRigorExample').hidden = !ex;
  if (!ex) return;
  $('stRigorExTitle').textContent = ex.title || '';
  $('stRigorExDone').textContent = ex.done_when || '';
  // The prompt shows its first 4 lines; the button appears only when there is more.
  const pr = $('stRigorExPrompt'), more = $('stRigorExMore');
  pr.textContent = ex.prompt || '';
  pr.classList.remove('open');
  const long = pr.scrollHeight > pr.clientHeight + 1;
  pr.classList.toggle('open', long && RIGOR.expanded);
  more.hidden = !long;
  more.textContent = RIGOR.expanded ? 'Show less' : 'Show full prompt';
  more.setAttribute('aria-expanded', String(long && RIGOR.expanded));
}
function rigorPreview(n) {
  if (n === (RIGOR.preview ?? rigorSaved())) return;
  RIGOR.preview = n;
  renderRigor();
}
// The project's fields (PATCH /api/orch/project/:id); a server from before that route takes the same body as a POST.
async function patchProject(id, body) {
  const url = `/api/orch/project/${id}`;
  try { return await api(url, 'PATCH', body, false); } catch (e) {
    if (!/\((404|405)\)$/.test(e.message)) throw e;
    return api(url, 'POST', body);
  }
}
async function saveRigor(n) {
  clearTimeout(RIGOR.timer); RIGOR.timer = null;
  const p = O.project;
  if (!p || !(n >= 1 && n <= 5)) return;
  if (n === rigorSaved()) { renderRigor(); return; }
  RIGOR.preview = n;
  RIGOR.saving++;
  try {
    await patchProject(p.id, { rigor: n });
    if (O.project?.id === p.id) O.project.rigor = n;
    toast(`Rigor set to ${rigorLabel(n)}: applies to new planning and reflection`, { kind: 'success' });
  } catch (err) { toast(err.message, { kind: 'error' }); RIGOR.preview = null; }
  finally { RIGOR.saving--; renderRigor(); }
}
{
  const box = $('stRigor');
  const at = (x) => { const r = box.getBoundingClientRect(); return Math.min(5, Math.max(1, Math.floor(((x - r.left) / r.width) * 5) + 1)); };
  box.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-level]');
    if (!b || e.button) return;
    RIGOR.drag = true;
    box.setPointerCapture?.(e.pointerId);
    rigorPreview(Number(b.dataset.level));
  });
  box.addEventListener('pointermove', (e) => { if (RIGOR.drag) rigorPreview(at(e.clientX)); });
  box.addEventListener('pointerup', () => { if (!RIGOR.drag) return; RIGOR.drag = false; saveRigor(RIGOR.preview ?? rigorSaved()); });
  box.addEventListener('pointercancel', () => { RIGOR.drag = false; RIGOR.preview = null; renderRigor(); }); // e.g. the sheet scrolls instead
  // Enter/Space (a click with no pointer: detail 0); pointer clicks already saved on release.
  box.addEventListener('click', (e) => { const b = e.target.closest('[data-level]'); if (b && e.detail === 0) saveRigor(Number(b.dataset.level)); });
  box.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    const cur = RIGOR.preview ?? rigorSaved();
    const n = e.key === 'Home' ? 1 : e.key === 'End' ? 5 : step ? Math.min(5, Math.max(1, cur + step)) : 0;
    if (!n) return;
    e.preventDefault();
    rigorPreview(n);
    box.querySelector(`[data-level="${n}"]`).focus();
    clearTimeout(RIGOR.timer);
    RIGOR.timer = setTimeout(() => saveRigor(n), 700);
  });
  box.addEventListener('focusout', (e) => { if (RIGOR.timer && !box.contains(e.relatedTarget)) saveRigor(RIGOR.preview); });
  $('stRigorExMore').addEventListener('click', () => { RIGOR.expanded = !RIGOR.expanded; renderRigor(); });
}
// Keep improving: off means this project never reflects (queued reflections are cancelled; a running one's tasks are dropped).
const PERP = { saving: false };
$('stPerpetual').addEventListener('change', async (e) => {
  const p = O.project, on = e.target.checked;
  if (!p) return;
  PERP.saving = true;
  try {
    await api(`/api/orch/project/${p.id}`, 'POST', { perpetual: on });
    if (O.project?.id === p.id) O.project.perpetual = on;
    toast(on ? 'Keep improving is on' : 'Keep improving is off: this project won\'t reflect', { kind: 'success' });
  } catch (err) { toast(err.message, { kind: 'error' }); }
  finally { PERP.saving = false; e.target.blur(); renderSettings(); }
});
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
  window.bvThumbDrop?.();
  $('taskDrawer').hidden = true;
  $('drawerScrim').hidden = true;
  refreshAllCards();
}
$('drClose').addEventListener('click', closeTask);
$('drawerScrim').addEventListener('click', closeTask);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && O.drawer && $('settingsModal').hidden && $('pickerModal').hidden && $('connsModal').hidden && $('usageModal').hidden && $('queueModal').hidden && !e.target.closest?.('.dr-due')) {
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
  if (t.kind === 'work' && !t.integrates && ['queued', 'paused'].includes(t.status)) {
    if (!MC.at) loadMachines().then(() => { if (O.drawer === t.id && MC.nodes.some((n) => !n.local)) renderDrawer(true); });
    if (MC.nodes.some((n) => !n.local)) c.append(runOnRow(t));
  }
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

// Run on: the owner pins a queued work task to one machine, or leaves it to any (PATCH /api/orch/tasks/:id/run-on).
function runOnRow(t) {
  const row = el('label', 'dr-runon'), sel = el('select');
  sel.append(new Option('Any machine', ''));
  for (const n of MC.nodes) {
    const off = !n.local && (!n.connected || n.status === 'offline') ? ' (offline)' : '';
    sel.append(new Option(n.local ? `${n.name} (this server)` : `${n.name}${off}`, n.id));
  }
  if (t.run_on && !MC.nodes.some((n) => n.id === t.run_on)) sel.append(new Option(t.run_on_name || t.run_on, t.run_on));
  sel.value = t.run_on || '';
  sel.onchange = async () => {
    try {
      const r = await api(`/api/orch/tasks/${t.id}/run-on`, 'PATCH', { node: sel.value || null });
      if (r.task) { O.tasks.set(t.id, { ...(O.tasks.get(t.id) || {}), ...r.task }); refreshCards(t.id); }
      toast(sel.value ? `#${t.id} runs only on ${sel.selectedOptions[0].text.replace(/ \((this server|offline)\)$/, '')}` : `#${t.id} runs on any machine`);
    } catch (e) { sel.value = t.run_on || ''; toast(e.message, { kind: 'error' }); }
  };
  row.title = 'Pinned to one machine, it waits for that machine even while others are free';
  row.append(el('span', '', 'Run on'), sel);
  return row;
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
// The step in progress grows on every Timeline bar (cards and the drawer), and counts up in an open drawer's step list.
setInterval(() => {
  for (const n of document.querySelectorAll('.tl-bar i[data-since]')) n.style.flexGrow = String(Math.max(1, Date.now() - Number(n.dataset.since)));
  if (!O.drawer) return;
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
  for (const a of t.approvals || []) top.append(approvalPanel(a));
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
  // A running browser task: its live page, with Watch and Take over (browser.js).
  const live = window.bvTaskThumb?.(t);
  if (live) body.append(live);
  // A worker's steps for the latest run (runs.phases): where the time went, what it's doing now, what failed.
  const lastRun = hasStartedRun(t) && d.runs.at(-1), tl = lastRun && timelineSection(lastRun, t.status === 'running' && !lastRun.outcome);
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
  // A browser task: its latest screen large, earlier ones newest first (screenStrip). Others: every screenshot, oldest
  // first, as a compact gallery (the drawer's .shots are small tiles; see app.css).
  const shots = d.runs.flatMap((r) => r.entries.filter((e) => e.k === 'image'));
  if (shots.length && t.browser) s3.append(screenStrip(shots, screenLabel(t.status)));
  else if (shots.length) s3.append(el('div', 'dr-shots-head', `Screenshots · ${shots.length}`), shotGrid(shots));
  if (t.status === 'running') {
    const live = el('div', 'out-live');
    live.append(el('span', 'spark'), document.createTextNode('Working…'));
    s3.append(live);
  }
  body.append(s3);

  // Every browser/connector call it made (the approval gate's audit log), loaded when opened.
  if (t.kind === 'work') body.append(actionsSection(t.id));

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
// of a prerequisite (the UI also greys those slots out). The Machines view borrows #qBody while it's open (qShown).
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
  if (RF.open) closeRefillPop();
  else if (Q.drag) endDrag(false);
  else closeQueue();
}, true);
function scheduleQueue() { clearTimeout(Q.timer); Q.timer = setTimeout(renderQueue, 120); }
// Why nothing starts although tasks are ready (the scheduler's stall reason, #453), e.g. 'Waiting: restart pending (integrator #439 is merging)'.
function queueStallText(stall, queued) {
  return stall?.reason && queued > 0 ? `Waiting: ${stall.reason}` : '';
}
const qShown = () => !$('queueModal').hidden || mxOpen();
// ----- refill status
// The Queue's refill line (#436, plain words in #455): how many tasks are ready for how many open slots, and whether
// agent-orch is asking the planner for more. refillStatus is pure (state + project → texts); the ⓘ opens a short
// explanation that stays open across the Queue's re-renders (RF.open).
const RF = { open: false };
const RF_EXPLAIN = 'Each machine can run several tasks at once. When fewer tasks are ready than there are open slots, agent-orch asks the planner to queue more, so no machine sits idle. Turn this off with Keep improving in Settings.';
function refillStatus(r, project) {
  if (!r) return null;
  if (project && !project.perpetual) return { state: 'off', text: 'Keep improving is off for this project', short: 'Keep improving is off' };
  const blocked = r.blockedProjects || [];
  if (project ? blocked.some((b) => b.id === project.id) : blocked.length) return { state: 'limit', text: 'Planning paused: usage limit near', short: 'Planning paused: usage limit near' };
  // r.free counts the head's reserved slots too (#453); the refill fills the worker side.
  const free = (r.workers || r).free, ready = plural(r.ready, 'task');
  if (r.toppingUp) return { state: 'planning', text: `${ready} ready for ${plural(free, 'open slot')} · planning more work`, short: `${r.ready} ready · ${free} open` };
  if (!free) return { state: 'busy', text: `All slots busy · ${ready} ready`, short: `All busy · ${r.ready} ready` };
  return { state: 'balanced', text: `${plural(free, 'open slot')} · ${ready} ready`, short: `${r.ready} ready · ${free} open` };
}
// Counts go in <b> (semibold, tabular figures).
function refillText(cls, text) {
  const s = el('span', cls);
  for (const part of String(text).split(/(\d+)/)) if (part) s.append(/^\d+$/.test(part) ? el('b', '', part) : part);
  return s;
}
function renderRefillStatus(r, project) {
  const st = refillStatus(r, project);
  if (!st) return null;
  const box = el('div', `rf rf-${st.state}`);
  box.setAttribute('role', 'status');
  if (st.state === 'planning') { const dot = el('span', 'rf-dot'); dot.setAttribute('aria-hidden', 'true'); box.append(dot); }
  box.append(refillText('rf-full', st.text), refillText('rf-short', st.short));
  const info = el('button', 'rf-info', 'ⓘ');
  info.type = 'button';
  info.setAttribute('aria-label', 'What is this?');
  info.setAttribute('aria-expanded', String(RF.open));
  const pop = el('p', 'rf-pop', RF_EXPLAIN);
  pop.hidden = !RF.open;
  info.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    RF.open = !RF.open;
    pop.hidden = !RF.open;
    info.setAttribute('aria-expanded', String(RF.open));
  });
  box.append(info, pop);
  return box;
}
function closeRefillPop() {
  RF.open = false;
  for (const p of document.querySelectorAll('.rf-pop')) p.hidden = true;
  for (const b of document.querySelectorAll('.rf-info')) b.setAttribute('aria-expanded', 'false');
}
// ----- end refill status
document.addEventListener('click', (e) => { if (RF.open && !e.target.closest?.('.rf')) closeRefillPop(); });
function renderQueue() {
  if (!qShown() || Q.drag || Q.busy) return;
  const body = $('qBody'), mx = mxOpen();
  const focused = document.activeElement?.closest?.('#qBody .tcard')?.dataset.task; // keeps keyboard focus across re-renders
  body.textContent = '';
  if (mx) { body.append(mxLanes()); mxCountsRender(); } // every machine's running tasks, in place of this project's
  const running = mx ? [] : [...O.tasks.values()].filter((t) => t.status === 'running' && t.project_id === O.project?.id);
  const queued = queuedTasks();
  const reviews = [...O.tasks.values()].filter((t) => t.status === 'awaiting_review' && t.project_id === O.project?.id);
  if (reviews.length) {
    body.append(el('h3', 'dg-group', 'Waiting for your review'));
    const box = el('div', 'q-list q-review');
    for (const t of reviews) box.append(queueCard(t.id, false));
    body.append(box);
  }
  if (running.length) {
    const head = el('h3', 'dg-group', 'Running');
    // Rapid mode: the files running work declared, with how many tasks may edit each at once (the per-file cap).
    const hot = (O.state?.hot_files || []).filter((h) => h.project_id === O.project?.id);
    if (hot.length) head.append(el('span', 'q-hot', `hot files: ${hot.map((h) => `${h.file} ×${h.cap}`).join(' · ')}`));
    body.append(head);
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
  const refill = renderRefillStatus(O.state?.rapid, O.project);
  if (refill) body.append(refill);
  body.append(el('h3', 'dg-group', `Up next · ${queued.length}${mx && O.project ? ` · ${O.project.name}` : ''}`));
  const stall = queueStallText(O.state?.stall, queued.length);
  if (stall) body.append(el('p', 'muted q-stall', stall));
  if (!queued.length) body.append(el('p', 'muted', mx && !O.project ? 'Open a project to see its queue.' : 'Nothing queued.'));
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
  if (!list || !qShown()) return;
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
  const card = qShown() && $('qBody').querySelector(`.tcard[data-task="${id}"]`);
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
  qDragMove();
  const scroll = () => {
    if (Q.drag !== d) return;
    const r = $('qBody').getBoundingClientRect(), edge = Math.min(64, r.height / 4);
    const v = d.y < r.top + edge ? -(r.top + edge - d.y) / edge : d.y > r.bottom - edge ? (d.y - (r.bottom - edge)) / edge : 0;
    if (v) { $('qBody').scrollTop += Math.max(-1, Math.min(1, v)) * 14; qDragMove(); }
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
function qDragMove() {
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
  if (Q.drag) { Q.drag.x = e.clientX; Q.drag.y = e.clientY; return qDragMove(); }
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
  if (!coarse) $('connsModal').querySelector('[data-close].icon-btn').focus(); // a touch tap would paint a focus ring on it
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
      const c = state.convos.find((x) => x.cwd === g.path && !isSubChat(x)); // the project's main chat
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

// '#task-<id>' (a notification's link) opens that task's drawer once the first state has arrived; '#<cid>' opens a chat.
const hashRoute = { ready: false, task: null };
function routeHash(hash) {
  const m = /^task-(\d+)$/.exec(hash);
  if (!m) {
    if (hash && hash !== state.cid && state.convos.some((c) => c.id === hash)) { openConvo(hash); setView('chat'); }
    return;
  }
  history.replaceState(null, '', state.cid ? `#${state.cid}` : '#');
  if (hashRoute.ready) showTask(Number(m[1]));
  else hashRoute.task = Number(m[1]);
}
addEventListener('hashchange', () => routeHash(location.hash.slice(1)));

// Who is signed in (GET /api/me: {user: {id, name, role, caps}, usage}). A non-admin's browser hides the admin's
// controls (users.css: html[data-role=user]) and skips their requests; users.js renders the rest.
const me = { user: null, usage: [] };
const meAdmin = () => me.user?.role !== 'user';
async function loadMe() {
  try { Object.assign(me, await api('/api/me')); } catch {}
  document.documentElement.dataset.role = me.user?.role || 'admin';
  window.Users?.changed();
}

(async function boot() {
  await loadMe();
  await checkStatus();
  const hash = location.hash.slice(1);
  const cid = /^task-\d+$/.test(hash) ? null : hash || null;
  openConvo(cid);
  if (!cid) routeHash(hash);
  if (state.cid) splash.need.add('history'); // the open chat's messages are part of the first screen
  connect();
  setView(store.get('cw.view') || 'chat');
  setInterval(renderConvoList, 60e3);
  setInterval(() => { if (!document.hidden) pollUpdates(); }, 60e3);
  if (meAdmin()) { refreshGitHub(); refreshConnections(); }
  const lastSeen = Number(store.get('cw.lastSeen')) || 0;
  if (lastSeen && Date.now() - lastSeen >= AWAY_MIN_MS) showAway(lastSeen);
  markSeen();
})();
