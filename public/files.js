'use strict';
// ---------- Files: a Finder-style browser of the whole disk, opening on the open chat's project (server: files.mjs) ----------
// Opens at the project's root (or the last folder, remembered per project for this page load only). Paths are absolute: the
// path bar runs from '/', ↑ Parent (⌥↑, Backspace) climbs to '/', Places jumps to Project, Home, / and /tmp, and Go to folder
// (⌘L) takes a typed absolute, ~ or relative path with completion from the listings. Protected entries (secrets) show a lock
// and never open; a read-only location shows a tag and disables the menu's write actions. Icon and list views (list folders
// open in place with disclosure triangles), back/forward, a name filter,
// hidden files on request (⌘⇧.), project-wide search by name or inside files (Enter in the search field; Names | Contents), and Quick Look (Space or double-click) for text, Markdown and images.
// The Changed view lists the files that differ from git HEAD with +/− counts; Quick Look shows their diff.
// Ask in chat (Quick Look's header, a Contents hit's trailing button, Shift+Enter on a row) puts `path[:line]` into the composer. Loaded after
// app.js and uses its helpers ($, el, api, store, md, currentConvo, toast, copyToClipboard).
// Selection: click, ⌘/Ctrl-click, Shift-click ranges, ⌘A. A context menu (right-click, long-press, a row's ⋯, Shift+F10) offers
// Open, Copy/Cut/Paste (⌘C ⌘X ⌘V), Compress to ZIP, Extract here, Rename… (F2), New file…/New folder…, Delete (Delete or
// Backspace, after an in-page confirm), Copy path and Ask in chat. The clipboard is app-internal
// (absolute paths plus copy|cut) and outlives folder changes; pasting POSTs /api/files/copy or /move {paths, dest},
// and /zip {paths, dest} and /unzip {path, dest} make and extract archives (cid rides in the query like every files route).
// Rename and New edit a name in place (FX.edit, redrawn by every render): POST /api/files/rename {path, name},
// /api/files/new {dir, name, type}; Delete POSTs /api/files/delete {paths}.
const FX = {
  cid: null, path: '', data: null, err: '', seq: 0, qseq: 0, fseq: 0, cseq: 0, find: null, changed: null, back: [], fwd: [], sel: null, filter: '', rows: [],
  view: ['list', 'changed'].includes(store.get('cw.files.view')) ? store.get('cw.files.view') : 'icons',
  sort: (() => { try { const s = JSON.parse(store.get('cw.files.sort')); if (s?.key) return s; } catch {} return { key: 'name', dir: 1 }; })(),
  hidden: store.get('cw.files.hidden') === '1',
  mode: store.get('cw.files.mode') === 'contents' ? 'contents' : 'names', // what Search project looks at
  expanded: new Set(), kids: new Map(), built: false, ql: null,
  picked: new Set(), anchor: null, // the selection (FX.sel is its lead row) and the Shift-click anchor
  root: null, clip: null, menu: null, press: 0, // root: the project key; clip: {mode: 'copy'|'cut', paths, root}
  proj: null, places: null, last: new Map(), restored: false, // proj: the project's real path; last: root → folder (this page load)
  goto: { cache: new Map(), opts: [], i: -1, seq: 0 }, // Go to folder's suggestions
  climbed: false, // the selection is only the folder ↑ Parent came out of: Backspace climbs on instead of deleting it
  edit: null, // a name being typed: {kind: 'rename', rel, value} | {kind: 'new', type: 'file'|'dir', dir, value}
};
const FX_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const fxKeys = (k) => (FX_MAC ? `⌘${k}` : `Ctrl+${k}`);
const FX_THUMB_MAX = 3e6; // images up to this size show as their own thumbnail in the icon view
const touch = () => matchMedia('(pointer: coarse)').matches;
// Absolute paths: '/' has no parent; a relative path (a search result, the Changed view) is inside the project.
const fxParent = (p) => (p.startsWith('/') ? p.replace(/\/[^/]*$/, '') || '/' : p.split('/').slice(0, -1).join('/'));
const fxJoin = (a, b) => (a === '/' ? `/${b}` : a ? `${a}/${b}` : b);
const fxAbs = (p) => (p.startsWith('/') || !FX.proj ? p : p ? fxJoin(FX.proj, p) : FX.proj);
const fxRel = (p) => (FX.proj && p.startsWith(FX.proj + '/') ? p.slice(FX.proj.length + 1) : p); // what chat is told
const fxBase = (p) => (p === '/' ? '/' : p.split('/').pop());
const FX_RO = "Read-only location: agent-orch can't change files here";
const FX_PROT = 'Protected file: contents hidden';
const fxUrl = (kind, rel) => `/api/files/${kind}?cid=${encodeURIComponent(FX.cid)}&path=${encodeURIComponent(rel)}`;
// A folder's listing: `dir` is the contract; `path` keeps servers from before it working.
const fxListUrl = (rel) => `/api/files/list?cid=${encodeURIComponent(FX.cid)}&dir=${encodeURIComponent(rel)}&path=${encodeURIComponent(rel)}`;
const extOf = (name) => { const m = /\.([^.]+)$/.exec(name); return m && m[1] !== name.slice(1) ? m[1].toLowerCase() : ''; };
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const isImage = (name) => IMG_EXT.has(extOf(name));
const KINDS = { js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript JSX', jsx: 'JavaScript JSX', json: 'JSON',
  md: 'Markdown', html: 'HTML', css: 'CSS', py: 'Python', sh: 'Shell script', yml: 'YAML', yaml: 'YAML', toml: 'TOML', txt: 'Plain Text',
  log: 'Log File', jsonl: 'JSON Lines', go: 'Go', rs: 'Rust', rb: 'Ruby', java: 'Java', c: 'C', h: 'C Header', cpp: 'C++', swift: 'Swift',
  sql: 'SQL', csv: 'CSV', xml: 'XML', svg: 'SVG image', lock: 'Lock File', env: 'Environment', mp3: 'MP3 audio', mp4: 'MPEG-4 movie',
  pdf: 'PDF document', zip: 'ZIP archive', gz: 'Gzip archive', db: 'Database', sqlite: 'Database', woff2: 'Font', ttf: 'Font' };
function kindOf(e) {
  if (e.dir) return 'Folder';
  const x = extOf(e.name);
  if (KINDS[x]) return KINDS[x];
  if (IMG_EXT.has(x)) return `${x.toUpperCase()} image`;
  return x ? `${x.toUpperCase()} file` : 'Document';
}
// Finder's units (decimal) and dates ("Today at 3:10 PM").
function fxSize(n) {
  if (n == null) return '--';
  if (n < 1000) return `${n} bytes`;
  const u = ['KB', 'MB', 'GB']; let i = -1;
  do { n /= 1000; i++; } while (n >= 1000 && i < u.length - 1);
  return `${n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, '')} ${u[i]}`;
}
function fxDate(ms) {
  const d = new Date(ms), now = new Date(), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 864e5);
  if (diff === 0) return `Today at ${t}`;
  if (diff === 1) return `Yesterday at ${t}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} at ${t}`;
}

// ----- icons: a macOS-style folder and a page with its extension; images show themselves
const FOLDER_SVG = '<svg viewBox="0 0 64 52" aria-hidden="true"><path d="M3 9a5 5 0 0 1 5-5h15l5 5h28a5 5 0 0 1 5 5v2H3z" fill="var(--fx-folder-back)"/><rect x="3" y="12" width="58" height="37" rx="5" fill="var(--fx-folder)"/><path d="M3 18h58" stroke="var(--fx-folder-line)" stroke-width="1.2"/></svg>';
function pageSvg(label) {
  const t = (label || '').slice(0, 4).toUpperCase();
  return `<svg viewBox="0 0 48 60" aria-hidden="true"><path d="M5 2h26l14 14v39a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3z" fill="var(--fx-page)" stroke="var(--fx-page-line)" stroke-width="1.5"/><path d="M31 2v11a3 3 0 0 0 3 3h11" fill="var(--fx-page-fold)" stroke="var(--fx-page-line)" stroke-width="1.5" stroke-linejoin="round"/>${t ? `<text x="24" y="47" text-anchor="middle" font-size="${t.length > 3 ? 8.5 : 10}" font-weight="700" fill="var(--fx-page-text)" font-family="system-ui, sans-serif">${t.replace(/[<&]/g, '')}</text>` : ''}</svg>`;
}
const LOCK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7.5" rx="1.6" fill="currentColor"/><path d="M5.3 7V5a2.7 2.7 0 0 1 5.4 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
function iconFor(e, rel, big) {
  const box = el('span', 'fx-ico');
  if (e.dir) box.innerHTML = FOLDER_SVG;
  else if (big && isImage(e.name) && e.size <= FX_THUMB_MAX && !e.protected) {
    const img = el('img');
    img.loading = 'lazy'; img.decoding = 'async'; img.alt = ''; img.src = fxUrl('raw', rel);
    img.onerror = () => { box.innerHTML = pageSvg(extOf(e.name)); };
    box.classList.add('thumb');
    box.append(img);
  } else box.innerHTML = pageSvg(extOf(e.name));
  if (e.protected) {
    const lock = el('span', 'fx-lock');
    lock.innerHTML = LOCK_SVG;
    lock.title = FX_PROT;
    box.append(lock);
  }
  return box;
}

// ----- shell (built once)
const ICON_GRID = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const ICON_LIST = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="5" cy="6" r="1.2" fill="currentColor"/><circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="5" cy="18" r="1.2" fill="currentColor"/></svg>';
function fxBuild() {
  if (FX.built) return;
  FX.built = true;
  const v = $('filesView');
  v.innerHTML = `
    <div class="fx-bar">
      <div class="fx-nav" role="group" aria-label="History">
        <button type="button" class="icon-btn" id="fxBack" aria-label="Back" title="Back (⌘[)"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button type="button" class="icon-btn" id="fxFwd" aria-label="Forward" title="Forward (⌘])"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button type="button" class="icon-btn fx-up" id="fxUp" aria-label="Parent folder" title="Parent folder (⌥↑)"><svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M12 19V6M6 11.5l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="fx-up-l">Parent</span></button>
      </div>
      <h2 class="fx-title" id="fxTitle">Files</h2>
      <span class="fx-ro" id="fxRO" title="${FX_RO}" hidden>Read-only</span>
      <div class="fx-tools">
        <button type="button" class="btn small fx-places" id="fxPlaces" aria-haspopup="menu" title="Places and Go to folder (${fxKeys('L')})">Places<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 4.5l3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div class="fx-views seg-sm" role="radiogroup" aria-label="View as">
          <button type="button" role="radio" data-fxview="icons" aria-label="Icons" title="as Icons">${ICON_GRID}</button>
          <button type="button" role="radio" data-fxview="list" aria-label="List" title="as List">${ICON_LIST}</button>
          <button type="button" role="radio" data-fxview="changed" class="fx-ch-btn" title="Files changed since the last commit">Changed</button>
        </div>
        <button type="button" class="icon-btn" id="fxHidden" aria-pressed="false" title="Show hidden files (⌘⇧.)" aria-label="Show hidden files"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
        <button type="button" class="icon-btn" id="fxRefresh" aria-label="Refresh" title="Refresh"><svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <label class="fx-search"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><input id="fxFilter" type="search" placeholder="Search this folder" aria-label="Search this folder" autocomplete="off" spellcheck="false" enterkeyhint="search"></label>
        <div class="fx-find" id="fxFindBar" hidden>
          <div class="fx-mode seg-sm" role="group" aria-label="Search project by">
            <button type="button" data-fxmode="names" title="Find files by name">Names</button><button type="button" data-fxmode="contents" title="Find text inside files">Contents</button>
          </div>
          <button type="button" class="btn small fx-find-btn" id="fxFindBtn">Search project</button>
        </div>
      </div>
    </div>
    <form class="fx-goto" id="fxGotoBar" hidden>
      <label for="fxGoto">Go to folder</label>
      <div class="fx-goto-f">
        <input id="fxGoto" type="text" placeholder="/path, ~/path or a subfolder" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"
          role="combobox" aria-autocomplete="list" aria-controls="fxSugg" aria-expanded="false">
        <div class="fx-sugg" id="fxSugg" role="listbox" aria-label="Folders" hidden></div>
      </div>
      <button type="submit" class="btn small">Go</button>
      <button type="button" class="icon-btn" id="fxGotoX" aria-label="Close" title="Close (Esc)"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </form>
    <div class="fx-main" id="fxMain"></div>
    <div class="fx-busy" id="fxBusy" role="status" hidden><span class="fx-prog" aria-hidden="true"></span><span id="fxBusyText"></span></div>
    <div class="fx-path" id="fxPath"></div>`;
  $('fxBack').onclick = () => fxHistory(-1);
  $('fxFwd').onclick = () => fxHistory(1);
  $('fxUp').onclick = () => fxUp();
  $('fxPlaces').onclick = () => { const k = $('fxPlaces').getBoundingClientRect(); fxPlacesOpen(k.left, k.bottom + 4); };
  $('fxGotoBar').onsubmit = (e) => { e.preventDefault(); fxGotoGo(); };
  $('fxGotoX').onclick = () => fxGotoClose(true);
  $('fxGoto').addEventListener('input', () => fxGotoSuggest());
  $('fxGoto').addEventListener('keydown', fxGotoKey);
  $('fxGoto').addEventListener('blur', () => setTimeout(() => { if (!$('fxGotoBar').contains(document.activeElement)) fxGotoList([]); }, 150));
  $('fxRefresh').onclick = () => (FX.find ? fxFind(FX.find.q) : FX.view === 'changed' ? fxChanged() : fxLoad());
  v.querySelectorAll('[data-fxmode]').forEach((b) => b.addEventListener('click', () => {
    FX.mode = b.dataset.fxmode; store.set('cw.files.mode', FX.mode);
    if (FX.find) fxFind(FX.find.q); else fxRender();
  }));
  $('fxFindBtn').onclick = () => fxFind($('fxFilter').value.trim());
  $('fxHidden').onclick = () => fxToggleHidden();
  v.querySelectorAll('[data-fxview]').forEach((b) => b.addEventListener('click', () => {
    FX.view = b.dataset.fxview; store.set('cw.files.view', FX.view);
    if (FX.view === 'changed') fxChanged(); else fxRender();
    fxFocus();
  }));
  $('fxFilter').addEventListener('input', (e) => {
    FX.filter = e.target.value.trim().toLowerCase();
    $('fxFindBar').hidden = FX.filter.length < 2;
    if (!FX.filter && FX.find) fxFindExit(); else fxRender();
  });
  $('fxFilter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim().length >= 2) { e.preventDefault(); fxFind(e.target.value.trim()); }
    else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); fxFocus(true); }
    else if (e.key === 'Escape' && (FX.find || e.target.value)) { e.preventDefault(); fxFindExit(true); }
  });
  $('fxMain').addEventListener('keydown', fxKey);
  $('fxMain').addEventListener('contextmenu', (e) => {
    if (fxFlat() || !FX.data || e.target.closest('.fx-head')) return;
    e.preventDefault();
    if (Date.now() - FX.press < 1000) return; // a long-press already opened it
    const o = e.target.closest('[data-i]');
    fxMenuOpen(o ? FX.rows[+o.dataset.i] : null, e.clientX, e.clientY);
  });
  v.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === '.') { e.preventDefault(); fxToggleHidden(); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === '[' || e.key === ']')) { e.preventDefault(); fxHistory(e.key === '[' ? -1 : 1); }
  });
  // ⌘L / Ctrl+L: Go to folder, wherever the focus is while Files is showing.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l' && $('app').dataset.view === 'files' && FX.cid) { e.preventDefault(); fxGotoOpen(); }
  });
}

// ----- data
// Shows the open chat's project; a different chat starts at its last folder (remembered per project until the page reloads).
function filesShow() {
  fxBuild();
  const cid = currentConvo()?.id || null;
  if (cid !== FX.cid) {
    const root = currentConvo()?.cwd || cid, last = (root && FX.last.get(root)) || '';
    Object.assign(FX, { cid, root, path: last, restored: !!last, proj: null, places: null, back: [], fwd: [], sel: null, picked: new Set(), anchor: null, filter: '', data: null, err: '', find: null, changed: null, edit: null });
    FX.expanded.clear(); FX.kids.clear();
    $('fxFilter').value = ''; $('fxFindBar').hidden = true;
    fxGotoClose();
  }
  if (!cid) { fxRender(); return; }
  fxLoad();
  if (FX.view === 'changed') fxChanged();
}
async function fxLoad(focus = false) {
  if (!FX.cid) return fxRender();
  const seq = ++FX.seq, { cid, path } = FX;
  $('filesView').classList.add('loading');
  try {
    const d = await api(fxListUrl(path));
    if (seq !== FX.seq || cid !== FX.cid) return;
    FX.data = d; FX.err = ''; FX.path = d.dir ?? d.path ?? path; FX.restored = false;
    if (d.places?.length) FX.places = d.places;
    FX.proj = d.places?.find((p) => p.label === 'Project')?.path || FX.proj || (path ? null : d.dir) || null;
    if (FX.root) FX.last.set(FX.root, FX.path);
    // Refresh any folders opened in place in the list view.
    for (const rel of [...FX.expanded]) {
      try { FX.kids.set(rel, (await api(fxListUrl(rel))).entries); } catch { FX.expanded.delete(rel); FX.kids.delete(rel); }
    }
    if (seq !== FX.seq) return;
  } catch (e) {
    if (seq !== FX.seq) return;
    FX.data = null; FX.err = e.message;
    // The remembered folder is gone: back to the project. A folder asked for by hand shows why it didn't open.
    if (FX.restored && /Not found|Not a folder|Outside/.test(e.message)) { FX.path = ''; FX.restored = false; FX.last.delete(FX.root); return fxLoad(focus); }
  } finally { if (seq === FX.seq) $('filesView').classList.remove('loading'); }
  fxRender();
  if (focus) fxFocus();
}
function fxGo(rel, { push = true } = {}) {
  if (push && rel !== FX.path) { FX.back.push(FX.path); FX.fwd = []; }
  FX.path = rel; FX.sel = null; FX.climbed = false; FX.picked.clear(); FX.filter = ''; FX.edit = null; FX.find = null; $('fxFilter').value = ''; $('fxFindBar').hidden = true;
  FX.expanded.clear(); FX.kids.clear(); FX.restored = false;
  fxLoad(true);
}
// Somewhere else on the disk (Places, Go to folder): out of the Changed view first, which has no folder.
function fxNav(p) {
  if (FX.view === 'changed') { FX.view = 'icons'; store.set('cw.files.view', FX.view); }
  fxGo(p);
}
function fxHistory(dir) {
  const from = dir < 0 ? FX.back : FX.fwd, to = dir < 0 ? FX.fwd : FX.back;
  if (!from.length) return;
  const prev = FX.path;
  to.push(prev);
  fxGo(from.pop(), { push: false });
  FX.sel = prev.startsWith(FX.path) ? prev : null; // back out of a folder: it stays selected
}
// The folder above this one; null at '/' (and before the first listing).
const fxUpPath = () => (!FX.path.startsWith('/') || FX.path === '/' ? null : FX.data?.dir === FX.path && 'parent' in FX.data ? FX.data.parent : fxParent(FX.path));
function fxUp() {
  const up = fxUpPath();
  if (!up || FX.view === 'changed') return;
  const child = FX.path;
  fxGo(up);
  FX.sel = child; FX.climbed = true;
}
function fxToggleHidden() {
  FX.hidden = !FX.hidden; store.set('cw.files.hidden', FX.hidden ? '1' : '0'); fxRender();
}
// Project-wide search, by name (find) or inside files (grep) as FX.mode says: results replace the folder until a name
// result is opened, Escape, or the field is cleared.
async function fxFind(q) {
  if (!FX.cid || q.length < 2) return;
  const seq = ++FX.fseq, cid = FX.cid, mode = FX.mode;
  FX.find = { q, mode, data: null, err: '' }; FX.sel = null; FX.picked.clear();
  fxRender();
  try {
    const d = await api(`${mode === 'contents' ? '/api/files/grep' : '/api/files/find'}?cid=${encodeURIComponent(cid)}&q=${encodeURIComponent(q)}`);
    if (seq !== FX.fseq || cid !== FX.cid || !FX.find) return;
    FX.find.data = d;
  } catch (e) {
    if (seq !== FX.fseq || !FX.find) return;
    FX.find.err = e.message;
  }
  fxRender();
}
// The Changed view's data: {data, err}; data is /api/files/changed's answer.
async function fxChanged() {
  if (!FX.cid) return fxRender();
  const seq = ++FX.cseq, cid = FX.cid;
  FX.changed = { data: FX.changed?.data || null, err: '' };
  fxRender();
  try {
    const d = await api(`/api/files/changed?cid=${encodeURIComponent(cid)}`);
    if (seq !== FX.cseq || cid !== FX.cid) return;
    FX.changed = { data: d, err: '' };
  } catch (e) {
    if (seq !== FX.cseq || cid !== FX.cid) return;
    FX.changed = { data: null, err: e.message };
  }
  fxRender();
  if (FX.view === 'changed' && !FX.find && $('fxMain').contains(document.activeElement)) fxFocus();
}
function fxFindExit(clear) {
  FX.fseq++; FX.find = null; FX.sel = null; FX.picked.clear();
  if (clear) { FX.filter = ''; $('fxFilter').value = ''; $('fxFindBar').hidden = true; }
  fxRender();
}
// Opening a result shows its folder with it selected (hidden files turn on when it is one).
function fxReveal(r) {
  if (!FX.hidden && fxRel(r.rel).split('/').some((p) => p.startsWith('.'))) fxToggleHidden();
  fxGo(fxParent(r.rel));
  FX.sel = r.rel;
}
const ICON_ASK = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
// `rel[:line]` into the composer at the caret (spaced from its neighbours), then back to the chat with the caret after it.
function fxAskAbout(rel, line) {
  rel = fxRel(rel);
  const input = $('input'), ref = line ? `${rel}:${line}` : rel, v = input.value;
  const a = input.selectionStart ?? v.length, b = input.selectionEnd ?? a;
  const before = v.slice(0, a), after = v.slice(b);
  const text = `${before && !/\s$/.test(before) ? ' ' : ''}${ref}${/^\s/.test(after) ? '' : ' '}`;
  input.value = before + text + after;
  input.dispatchEvent(new Event('input', { bubbles: true })); // the composer resizes
  fxClosePreview();
  document.querySelector('.seg button[data-view="chat"]')?.click(); // app.js setView('chat'), like the Vibecode tab
  input.focus({ preventScroll: true });
  input.setSelectionRange(a + text.length, a + text.length);
}
function fxSorted(entries) {
  const { key, dir } = FX.sort;
  const val = (e) => (key === 'size' ? e.size ?? -1 : key === 'date' ? e.mtime : key === 'kind' ? kindOf(e) : e.name);
  return entries.filter((e) => FX.hidden || !e.hidden).filter((e) => !FX.filter || e.name.toLowerCase().includes(FX.filter))
    .sort((a, b) => (b.dir - a.dir) || dir * (typeof val(a) === 'number' ? val(a) - val(b) : String(val(a)).localeCompare(String(val(b)), undefined, { numeric: true, sensitivity: 'base' })));
}

// ----- rendering
function fxRender() {
  if (!FX.built) return;
  const main = $('fxMain'), d = FX.data;
  $('fxBack').disabled = !FX.back.length;
  $('fxFwd').disabled = !FX.fwd.length;
  $('fxUp').disabled = !fxUpPath() || FX.view === 'changed';
  $('fxRO').hidden = !fxReadOnly();
  $('fxHidden').setAttribute('aria-pressed', String(FX.hidden));
  $('filesView').querySelectorAll('[data-fxview]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.fxview === FX.view)));
  $('filesView').querySelectorAll('[data-fxmode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fxmode === FX.mode)));
  $('fxTitle').textContent = (FX.view === 'changed' ? fxRootName() : FX.path.startsWith('/') ? fxBase(FX.path) : d?.name) || currentConvo()?.title || 'Files';
  main.textContent = '';
  main.className = `fx-main ${FX.view}`;
  if (!FX.cid) {
    main.append(fxEmpty('No project yet', 'Files shows the project of the chat you have open. Pick a project in Vibecode to browse it here.'));
    $('fxPath').textContent = '';
    return;
  }
  if (FX.find) return fxFound(main);
  if (FX.view === 'changed') return fxChangedList(main);
  if (!d) {
    FX.rows = [];
    if (!FX.err) main.append(el('div', 'fx-loading', 'Loading…'));
    else if (/Permission denied/i.test(FX.err)) main.append(fxEmpty('Permission denied', "agent-orch's user isn't allowed to open this folder. ↑ Parent or Places take you elsewhere.", 'fx-denied'));
    else main.append(fxEmpty("Couldn't open this folder", FX.err));
    if (FX.path.startsWith('/')) fxPathBar(); else $('fxPath').textContent = ''; // the path bar still climbs out
    return;
  }
  FX.rows = [];
  const add = (entries, base, depth) => {
    for (const e of fxSorted(entries)) {
      const rel = e.path || fxJoin(base, e.name);
      FX.rows.push({ e, rel, depth });
      if (FX.view === 'list' && e.dir && FX.expanded.has(rel) && FX.kids.has(rel)) add(FX.kids.get(rel), rel, depth + 1);
    }
  };
  add(d.entries, FX.path, 0);
  fxPrune();
  if (!FX.rows.length && FX.edit?.kind !== 'new') main.append(fxEmpty(FX.filter ? 'No matches' : 'This folder is empty', FX.filter ? `Nothing here is named like “${FX.filter}”.` : d.entries.length ? 'It only has hidden files (⌘⇧. shows them).' : ''));
  else if (FX.view === 'icons') main.append(fxIcons());
  else main.append(fxList());
  fxPathBar();
  fxEditMount();
}
// Drops picks that left the listing; a lead set elsewhere (a revealed result, the folder just backed out of) becomes the selection.
function fxPrune() {
  const have = new Set(FX.rows.map((r) => r.rel));
  if (FX.sel && !have.has(FX.sel)) FX.sel = null;
  for (const rel of FX.picked) if (!have.has(rel)) FX.picked.delete(rel);
  if (FX.sel && !FX.picked.size) FX.picked.add(FX.sel);
}
// Search results and the Changed view are flat lists: one row at a time, no clipboard or context menu.
const fxFlat = () => !!FX.find || FX.view === 'changed';
const fxRootName = () => (FX.proj && fxBase(FX.proj)) || String(currentConvo()?.cwd || '').split('/').filter(Boolean).pop() || 'Project';
// '/' then one crumb per folder down to this one.
function fxCrumbs() {
  if (!FX.path.startsWith('/')) return [{ name: fxRootName(), path: '' }];
  const parts = FX.path.split('/').filter(Boolean);
  return [{ name: '/', path: '/' }, ...parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))];
}
// No writes here: the listing's own flag when there is one, else writes land only under the project, home and /tmp (Places
// but '/'): this folder is one of them or inside one, or holds a writable entry that isn't a link or one of them (/private/tmp).
function fxReadOnly() {
  const d = FX.data;
  if (!d || fxFlat() || !d.dir) return false;
  if (typeof d.writable === 'boolean') return !d.writable;
  const roots = (FX.places || []).filter((p) => p.path !== '/').map((p) => p.path.replace(/\/$/, ''));
  if (roots.some((r) => d.dir === r || d.dir.startsWith(r + '/'))) return false;
  return !d.entries.some((e) => e.writable && !e.isSymlink && !roots.includes(e.path));
}
function fxFound(main) {
  const { q, mode, data, err } = FX.find;
  $('fxPath').textContent = '';
  if (!data) { FX.rows = []; return main.append(err ? fxEmpty("Couldn't search this project", err) : el('div', 'fx-loading', 'Searching…')); }
  if (mode === 'contents') return fxFoundLines(main);
  FX.rows = data.entries.map((e) => ({ e, rel: fxAbs(e.path), depth: 0 }));
  fxPrune();
  if (!FX.rows.length) main.append(fxEmpty(`No files named like “${q}”`, data.truncated ? 'The project is too big to search all of it.' : 'Hidden folders, .git and node_modules are skipped.'));
  else {
    const t = el('div', 'fx-rows fx-found');
    t.setAttribute('role', 'listbox');
    t.setAttribute('aria-label', `Files named like “${q}”, ${FX.rows.length} found`);
    t.tabIndex = 0;
    FX.rows.forEach((r, i) => {
      const o = optionFor(r, i, 'fx-row'), up = fxParent(r.rel), folder = !up || up === FX.proj ? fxRootName() : fxRel(up);
      const name = el('span', 'fx-c name'), nm = el('span', 'fx-n');
      nm.append(el('span', 'fx-nt', r.e.name), el('span', 'fx-sub', r.e.dir ? folder : `${folder} · ${fxSize(r.e.size)}`)); // sub: phones only
      name.append(el('span', 'fx-disc-sp'), iconFor(r.e, r.rel, false), nm);
      o.title = fxRel(r.rel);
      o.append(name, el('span', 'fx-c folder', folder), el('span', 'fx-c size', r.e.dir ? '--' : fxSize(r.e.size)));
      t.append(o);
    });
    fxActive(t);
    main.append(t);
  }
  const n = FX.rows.length;
  $('fxPath').append(el('span', 'fx-crumbs', `Searching the whole project for “${q}”`),
    el('span', 'fx-count', `${n} found${data.truncated ? ' · stopped early' : ''}`));
}
// The Changed view: a status badge, the path (its folder dimmed) and +add −del per changed file; the filter matches paths.
const FX_STATUS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', '?': 'Untracked' };
function fxChangedList(main) {
  const { data, err } = FX.changed || {}, bar = $('fxPath');
  bar.textContent = '';
  const refresh = el('button', 'fx-crumb fx-ch-refresh', 'Refresh');
  refresh.type = 'button';
  refresh.onclick = () => fxChanged();
  if (!data) {
    FX.rows = [];
    main.append(err ? fxEmpty("Couldn't list the changes", err) : el('div', 'fx-loading', 'Loading…'));
    return bar.append(el('span', 'fx-crumbs', 'Changes'), refresh);
  }
  const entries = data.entries.filter((c) => !FX.filter || c.path.toLowerCase().includes(FX.filter));
  FX.rows = entries.map((c) => ({ e: { name: c.path.split('/').pop(), dir: false, size: null, mtime: null }, rel: c.path, ch: c, depth: 0 }));
  fxPrune();
  if (data.notGit) main.append(fxEmpty('Not a git repository', "This project isn't tracked by git, so there are no changes to show."));
  else if (!FX.rows.length) main.append(fxEmpty(FX.filter ? 'No matches' : 'No uncommitted changes', FX.filter ? `No changed file is named like “${FX.filter}”.` : `Everything matches the last commit${data.branch ? ` on ${data.branch}` : ''}.`));
  else {
    if (data.truncated) main.append(el('div', 'fx-trunc', `Showing the first ${data.entries.length.toLocaleString()} changed files.`));
    const t = el('div', 'fx-rows fx-changed');
    t.setAttribute('role', 'listbox');
    t.setAttribute('aria-label', `${FX.rows.length} changed file${FX.rows.length === 1 ? '' : 's'}`);
    t.tabIndex = 0;
    FX.rows.forEach((r, i) => {
      const c = r.ch, o = optionFor(r, i, `fx-row${c.status === 'D' ? ' deleted' : ''}`), folder = c.path.slice(0, -r.e.name.length);
      const badge = el('span', `fx-st st-${c.status === '?' ? 'U' : c.status}`, c.status);
      badge.title = FX_STATUS[c.status] || c.status;
      const name = el('span', 'fx-c name fx-cp');
      name.append(el('span', 'fx-dir', folder), el('span', 'fx-base', r.e.name));
      const cnt = el('span', 'fx-cnt');
      if (c.binary) cnt.append(el('span', 'fx-bin', 'binary'));
      else cnt.append(el('span', 'fx-add', `+${c.add}`), el('span', 'fx-del', `−${c.del}`));
      o.title = `${FX_STATUS[c.status] || c.status}: ${c.from ? `${c.from} → ` : ''}${c.path}`;
      o.append(badge, name, cnt);
      t.append(o);
    });
    fxActive(t);
    main.append(t);
  }
  const add = entries.reduce((n, c) => n + c.add, 0), del = entries.reduce((n, c) => n + c.del, 0), n = FX.rows.length;
  bar.append(el('span', 'fx-crumbs', data.notGit ? 'Changes' : `Changes${data.branch ? ` on ${data.branch}` : ''}`),
    el('span', 'fx-count', data.notGit ? '' : `${n} file${n === 1 ? '' : 's'} · +${add} −${del}${data.truncated ? ' · list cut short' : ''}`), refresh);
}
// Contents results: a heading per file, then one row per matching line (`line · text`, the match in <mark>). A row's
// rel is unique per line; `file` is what Quick Look opens.
function fxFoundLines(main) {
  const { q, data } = FX.find;
  FX.rows = data.hits.map((h) => ({ e: { name: h.path.split('/').pop(), dir: false, size: null, mtime: null }, rel: `${h.path}#L${h.line}`, file: h.path, hit: h, depth: 0 }));
  fxPrune();
  const nFiles = new Set(data.hits.map((h) => h.path)).size;
  if (!FX.rows.length) main.append(fxEmpty(`No text like “${q}” in this project`, data.truncated ? 'The project is too big to search all of it.' : 'Hidden folders, .git, node_modules, binary files and files over 1 MB are skipped.'));
  else {
    const t = el('div', 'fx-rows fx-found fx-lines');
    t.setAttribute('role', 'listbox');
    t.setAttribute('aria-label', `Lines with “${q}”, ${FX.rows.length} found in ${nFiles} file${nFiles === 1 ? '' : 's'}`);
    t.tabIndex = 0;
    let group;
    FX.rows.forEach((r, i) => {
      if (!group || group.dataset.file !== r.file) {
        group = el('div', 'fx-lgroup');
        group.dataset.file = r.file;
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', r.file);
        const head = el('div', 'fx-lfile');
        head.setAttribute('aria-hidden', 'true');
        head.title = r.file;
        head.append(iconFor(r.e, r.file, false), el('span', 'fx-nt', r.file));
        group.append(head);
        t.append(group);
      }
      const o = optionFor(r, i, 'fx-row fx-hit');
      o.title = `${r.file}:${r.hit.line}`;
      const ask = el('button', 'fx-ask');
      ask.type = 'button'; ask.tabIndex = -1; ask.innerHTML = ICON_ASK;
      ask.title = 'Ask in chat (⇧Enter)';
      ask.setAttribute('aria-label', `Ask in chat about ${r.file}:${r.hit.line}`);
      ask.onclick = (ev) => { ev.stopPropagation(); fxAskAbout(r.file, r.hit.line); };
      o.append(el('span', 'fx-hl', String(r.hit.line)), fxMarked(el('span', 'fx-ht'), r.hit.text, q), ask);
      group.append(o);
    });
    fxActive(t);
    main.append(t);
  }
  $('fxPath').append(el('span', 'fx-crumbs', `Searching inside the project's files for “${q}”`),
    el('span', 'fx-count', `${FX.rows.length} line${FX.rows.length === 1 ? '' : 's'} in ${nFiles} file${nFiles === 1 ? '' : 's'} · ${data.files} searched${data.truncated ? ' · stopped early' : ''}`));
}
// `text` into `node` with each case-insensitive occurrence of q in <mark> (text nodes only).
function fxMarked(node, text, q) {
  const low = text.toLowerCase(), needle = q.toLowerCase();
  let i = 0;
  for (let at; needle && (at = low.indexOf(needle, i)) >= 0; i = at + needle.length) {
    if (at > i) node.append(text.slice(i, at));
    node.append(el('mark', null, text.slice(at, at + needle.length)));
  }
  if (i < text.length) node.append(text.slice(i));
  return node;
}
function fxEmpty(title, text, cls = '') {
  const box = el('div', `fx-empty ${cls}`.trim());
  box.innerHTML = FOLDER_SVG;
  box.append(el('strong', '', title), el('p', '', text));
  return box;
}
function optionFor(r, i, cls) {
  const o = el('div', cls);
  o.id = `fx-o-${i}`;
  o.dataset.i = String(i);
  o.setAttribute('role', FX.view === 'list' && !FX.find ? 'treeitem' : 'option');
  o.setAttribute('aria-selected', String(FX.picked.has(r.rel)));
  o.title = r.e.protected ? `${r.e.name}: ${FX_PROT}` : r.e.readable === false ? `${r.e.name}: permission denied` : r.e.name;
  if (r.e.readable === false) o.classList.add('fx-noread');
  if (fxIsCut(r.rel)) o.classList.add('fx-cut');
  o.addEventListener('click', (ev) => {
    if (ev.target.closest('.fx-disc, .fx-ask, .fx-more, .fx-edit')) return;
    if (Date.now() - FX.press < 1000) return; // the click that ends a long-press
    const mod = ev.metaKey || ev.ctrlKey;
    fxSelect(r.rel, ev.shiftKey && !fxFlat() ? 'range' : mod && !fxFlat() ? 'toggle' : null);
    if (touch() && !mod && !ev.shiftKey) fxOpen(r);
  });
  o.addEventListener('dblclick', (ev) => { if (!touch() && !ev.target.closest('.fx-more, .fx-edit')) fxOpen(r); });
  if (fxFlat()) return o;
  // Long-press (touch) opens the context menu where the finger is.
  let t = 0, at = null;
  const stop = () => { clearTimeout(t); t = 0; };
  o.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType !== 'touch' || ev.target.closest('.fx-disc, .fx-more, .fx-edit')) return;
    at = { x: ev.clientX, y: ev.clientY };
    t = setTimeout(() => { t = 0; FX.press = Date.now(); fxMenuOpen(r, at.x, at.y); }, 500);
  });
  o.addEventListener('pointermove', (ev) => { if (t && Math.hypot(ev.clientX - at.x, ev.clientY - at.y) > 8) stop(); });
  o.addEventListener('pointerup', stop);
  o.addEventListener('pointercancel', stop);
  return o;
}
// A row's ⋯ button: the context menu for people without a right button or a long-press.
function fxMoreBtn(r) {
  const b = el('button', 'fx-more');
  b.type = 'button'; b.tabIndex = -1;
  b.setAttribute('aria-label', `Actions for ${r.e.name}`);
  b.setAttribute('aria-haspopup', 'menu');
  b.title = 'Actions';
  b.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="6" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="18" cy="12" r="1.7" fill="currentColor"/></svg>';
  b.onclick = (ev) => { ev.stopPropagation(); const k = b.getBoundingClientRect(); fxMenuOpen(r, k.left, k.bottom + 2); };
  return b;
}
function fxIcons() {
  const g = el('div', 'fx-grid');
  g.setAttribute('role', 'listbox');
  g.setAttribute('aria-label', `${$('fxTitle').textContent}, ${FX.rows.length} items`);
  g.tabIndex = 0;
  if (FX.edit?.kind === 'new') g.append(fxNewRow('fx-item'));
  FX.rows.forEach((r, i) => {
    const o = optionFor(r, i, 'fx-item');
    o.append(iconFor(r.e, r.rel, true), el('span', 'fx-name', r.e.name), fxMoreBtn(r));
    g.append(o);
  });
  fxActive(g);
  return g;
}
function fxList() {
  const wrap = el('div', 'fx-table');
  const head = el('div', 'fx-head');
  for (const [key, label] of [['name', 'Name'], ['date', 'Date Modified'], ['size', 'Size'], ['kind', 'Kind']]) {
    const b = el('button', `fx-col ${key}`, label);
    b.type = 'button';
    if (FX.sort.key === key) { b.classList.add('on'); b.setAttribute('aria-sort', FX.sort.dir > 0 ? 'ascending' : 'descending'); b.dataset.dir = FX.sort.dir > 0 ? 'asc' : 'desc'; }
    b.onclick = () => { FX.sort = { key, dir: FX.sort.key === key ? -FX.sort.dir : 1 }; store.set('cw.files.sort', JSON.stringify(FX.sort)); fxRender(); };
    head.append(b);
  }
  const t = el('div', 'fx-rows');
  t.setAttribute('role', 'tree');
  t.setAttribute('aria-label', `${$('fxTitle').textContent}, ${FX.rows.length} items`);
  t.tabIndex = 0;
  if (FX.edit?.kind === 'new') t.append(fxNewRow('fx-row'));
  FX.rows.forEach((r, i) => {
    const o = optionFor(r, i, 'fx-row');
    o.setAttribute('aria-level', String(r.depth + 1));
    const name = el('span', 'fx-c name');
    name.style.paddingLeft = `${r.depth * 18}px`;
    if (r.e.dir) {
      const open = FX.expanded.has(r.rel);
      o.setAttribute('aria-expanded', String(open));
      const disc = el('button', 'fx-disc');
      disc.type = 'button'; disc.tabIndex = -1;
      disc.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${r.e.name}`);
      disc.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3.5 2l5 4-5 4z" fill="currentColor"/></svg>';
      disc.onclick = (ev) => { ev.stopPropagation(); fxExpand(r.rel, !open); };
      name.append(disc);
    } else name.append(el('span', 'fx-disc-sp'));
    const nm = el('span', 'fx-n');
    nm.append(el('span', 'fx-nt', r.e.name), el('span', 'fx-sub', r.e.dir ? 'Folder' : `${fxSize(r.e.size)} · ${fxDate(r.e.mtime)}`)); // sub: phones only
    name.append(iconFor(r.e, r.rel, false), nm, fxMoreBtn(r));
    o.append(name, el('span', 'fx-c date', fxDate(r.e.mtime)), el('span', 'fx-c size', r.e.dir ? '--' : fxSize(r.e.size)), el('span', 'fx-c kind', kindOf(r.e)));
    t.append(o);
  });
  fxActive(t);
  wrap.append(head, t);
  return wrap;
}
function fxActive(container) {
  const i = FX.rows.findIndex((r) => r.rel === FX.sel);
  if (i >= 0) container.setAttribute('aria-activedescendant', `fx-o-${i}`);
  else container.removeAttribute('aria-activedescendant');
}
// The full path from '/', every folder clickable; on phones the middle folders fold into a … that unfolds them.
function fxPathBar() {
  const bar = $('fxPath');
  bar.textContent = '';
  const crumbs = el('nav', 'fx-crumbs');
  crumbs.setAttribute('aria-label', 'Path');
  const all = fxCrumbs(), fold = all.length > 4;
  all.forEach((c, i) => {
    const mid = fold && i > 0 && i < all.length - 2;
    if (i === 1 && fold) {
      const ell = el('button', 'fx-ell', '…');
      ell.type = 'button';
      ell.setAttribute('aria-label', 'Show the whole path');
      ell.title = FX.path;
      ell.onclick = () => crumbs.classList.add('open');
      crumbs.append(ell);
    }
    if (i) crumbs.append(el('span', `fx-sep${mid ? ' mid' : ''}`, '›'));
    const b = el('button', `fx-crumb${mid ? ' mid' : ''}${c.path === '/' ? ' fx-root' : ''}`);
    b.type = 'button';
    b.title = c.path === FX.proj ? `${c.path} (project)` : c.path;
    if (c.path === '/') b.setAttribute('aria-label', 'Root folder /');
    else b.innerHTML = FOLDER_SVG;
    b.append(el('span', '', c.name));
    if (i === all.length - 1) b.setAttribute('aria-current', 'location');
    b.onclick = () => { if (c.path !== FX.path || !FX.data) fxGo(c.path); };
    crumbs.append(b);
  });
  const n = FX.rows.length, hiddenCount = FX.hidden || !FX.data ? 0 : FX.data.entries.filter((e) => e.hidden).length;
  bar.append(crumbs, el('span', 'fx-count', !FX.data ? '' : `${n} item${n === 1 ? '' : 's'}${hiddenCount && !FX.filter ? ` · ${hiddenCount} hidden` : ''}${FX.data.truncated ? ' · first 5,000 shown' : ''}`));
  crumbs.scrollLeft = crumbs.scrollWidth;
}
async function fxExpand(rel, open) {
  if (!open) { for (const k of [...FX.expanded]) if (k === rel || k.startsWith(rel + '/')) FX.expanded.delete(k); fxRender(); return; }
  FX.expanded.add(rel);
  if (!FX.kids.has(rel)) {
    try { FX.kids.set(rel, (await api(fxListUrl(rel))).entries); } catch (e) { FX.expanded.delete(rel); toast(e.message, { kind: 'error' }); }
  }
  fxRender();
  fxFocus();
}

// ----- selection, keyboard, opening
// how: null = just this row, 'toggle' = ⌘-click, 'range' = Shift-click (from the anchor), 'all' = ⌘A.
function fxSelect(rel, how = null) {
  FX.climbed = false;
  const i = FX.rows.findIndex((r) => r.rel === rel);
  if (how === 'all') FX.picked = new Set(FX.rows.map((r) => r.rel));
  else if (how === 'toggle') { if (!FX.picked.delete(rel)) FX.picked.add(rel); FX.anchor = rel; }
  else if (how === 'range' && FX.anchor != null && i >= 0) {
    const a = FX.rows.findIndex((r) => r.rel === FX.anchor), lo = Math.min(a < 0 ? i : a, i), hi = Math.max(a < 0 ? i : a, i);
    FX.picked = new Set(FX.rows.slice(lo, hi + 1).map((r) => r.rel));
  } else { FX.picked = new Set(rel == null ? [] : [rel]); FX.anchor = rel; }
  FX.sel = how === 'toggle' && !FX.picked.has(rel) ? [...FX.picked].at(-1) ?? null : how === 'all' ? FX.sel ?? FX.rows[0]?.rel ?? null : rel;
  const c = $('fxMain').querySelector('[role="listbox"], [role="tree"]');
  if (!c) return;
  c.querySelectorAll('[data-i]').forEach((o) => o.setAttribute('aria-selected', String(FX.picked.has(FX.rows[+o.dataset.i]?.rel))));
  if (how !== 'all') c.querySelector(`#fx-o-${i}`)?.scrollIntoView({ block: 'nearest' });
  fxActive(c);
  if (FX.ql && i >= 0 && !FX.rows[i].e.dir && FX.picked.has(rel)) fxPreview(FX.rows[i]); // Quick Look follows the selection
}
const fxPickedRows = () => FX.rows.filter((r) => FX.picked.has(r.rel));
function fxFocus(selectFirst) {
  const c = $('fxMain').querySelector('[role="listbox"], [role="tree"]'), field = $('fxMain').querySelector('.fx-edit');
  if (field) return field.focus({ preventScroll: true }); // a name being typed keeps the focus through refreshes
  if (!c) return;
  if (selectFirst && !FX.sel && FX.rows[0]) fxSelect(FX.rows[0].rel);
  c.focus({ preventScroll: true });
  c.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); // e.g. a revealed find result
}
function fxOpen(r) {
  if (r.hit || r.ch) fxPreview(r);
  else if (FX.find) fxReveal(r);
  else if (r.e.dir) fxGo(r.rel);
  else fxPreview(r);
}
function fxKey(e) {
  if (e.target.closest('input')) return;
  const i = FX.rows.findIndex((r) => r.rel === FX.sel), cur = FX.rows[i];
  const cols = () => {
    if (FX.view !== 'icons') return 1;
    const items = $('fxMain').querySelectorAll('.fx-item');
    let n = 0;
    for (const it of items) { if (it.offsetTop !== items[0].offsetTop) break; n++; }
    return Math.max(1, n);
  };
  const move = (d) => { const n = Math.min(FX.rows.length - 1, Math.max(0, (i < 0 ? (d > 0 ? -1 : FX.rows.length) : i) + d)); if (FX.rows[n]) fxSelect(FX.rows[n].rel, e.shiftKey && !fxFlat() ? 'range' : null); };
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase(), changed = !FX.find && FX.view === 'changed';
  if (mod && !e.shiftKey && !e.altKey && !fxFlat() && ['a', 'c', 'x', 'v'].includes(k)) {
    e.preventDefault();
    if (k === 'a') fxSelect(null, 'all');
    else if (k === 'v') fxPaste(FX.path);
    else fxClipSet(k === 'x' ? 'cut' : 'copy');
  } else if (!fxFlat() && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
    e.preventDefault();
    const o = $('fxMain').querySelector(`#fx-o-${i}`), k2 = (o || e.currentTarget).getBoundingClientRect();
    fxMenuOpen(cur || null, k2.left + 24, o ? k2.bottom : k2.top + 24);
  } else if (!fxFlat() && e.key === 'F2' && !mod) { e.preventDefault(); if (FX.picked.size === 1 && cur) fxRenameStart(cur); }
  else if (!fxFlat() && (e.key === 'Delete' || (e.key === 'Backspace' && !FX.climbed)) && !mod && FX.picked.size) { e.preventDefault(); fxConfirmDelete(fxPickedRows()); }
  else if (FX.find && (e.key === 'Escape' || e.key === 'Backspace' || (mod && e.key === 'ArrowUp'))) { e.preventDefault(); fxFindExit(true); $('fxFilter').focus(); }
  else if ((FX.find || changed) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) e.preventDefault();
  else if (changed && (e.key === 'Backspace' || ((mod || e.altKey) && e.key === 'ArrowUp'))) e.preventDefault(); // no folder to go up from
  else if ((mod || e.altKey) && e.key === 'ArrowUp') { e.preventDefault(); fxUp(); }
  else if (e.shiftKey && e.key === 'Enter') { if (cur) { e.preventDefault(); fxAskAbout(cur.file || cur.rel, cur.hit?.line); } }
  else if ((mod && e.key === 'ArrowDown') || e.key === 'Enter') { if (cur) { e.preventDefault(); fxOpen(cur); } }
  else if (e.key === ' ') { e.preventDefault(); if (FX.ql) fxClosePreview(); else if (cur && !cur.e.dir) fxPreview(cur); }
  else if (e.key === 'Backspace') { e.preventDefault(); fxUp(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); move(cols()); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-cols()); }
  else if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (FX.view === 'list') { if (cur?.e.dir && !FX.expanded.has(cur.rel)) fxExpand(cur.rel, true); } else move(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (FX.view !== 'list') move(-1);
    else if (cur?.e.dir && FX.expanded.has(cur.rel)) fxExpand(cur.rel, false);
    else if (cur?.depth) fxSelect(fxParent(cur.rel));
  } else if (e.key === 'Home') { e.preventDefault(); if (FX.rows[0]) fxSelect(FX.rows[0].rel); }
  else if (e.key === 'End') { e.preventDefault(); if (FX.rows.length) fxSelect(FX.rows.at(-1).rel); }
}

// ----- clipboard, context menu and file operations
const fxClipOk = () => !!FX.clip?.paths.length && FX.clip.root === FX.root;
const fxIsCut = (rel) => FX.clip?.mode === 'cut' && fxClipOk() && FX.clip.paths.includes(rel);
const fxLabel = (paths) => (paths.length === 1 ? `“${paths[0].split('/').pop()}”` : `${paths.length} items`);
const fxFolderName = (p) => (p ? fxBase(p) : fxRootName());
// Can things be written into folder p? (The current folder, or a folder row of it.)
const fxWritableDir = (p) => (p === FX.path ? !fxReadOnly() : FX.rows.find((r) => r.rel === p)?.e.writable !== false);
// Cut rows look dimmed until they are pasted.
function fxMarkCut() {
  $('fxMain').querySelectorAll('[data-i]').forEach((o) => o.classList.toggle('fx-cut', fxIsCut(FX.rows[+o.dataset.i]?.rel)));
}
function fxClipSet(mode) {
  const rows = fxPickedRows(), paths = rows.map((r) => r.rel);
  if (!paths.length) return;
  if (rows.some((r) => r.e.protected)) return toast(`${FX_PROT}: it can't be copied or moved.`, { kind: 'error' });
  if (mode === 'cut' && fxReadOnly()) return toast(`${FX_RO}. Copy instead.`, { kind: 'error' });
  FX.clip = { mode, paths, root: FX.root };
  fxMarkCut();
  toast(`${fxLabel(paths)} ${mode === 'cut' ? 'cut: paste to move' : 'copied: paste to make a copy'} (${fxKeys('V')})`, { duration: 2500 });
}
async function fxPaste(dest) {
  if (!fxClipOk()) return;
  const { mode, paths } = FX.clip;
  if (!fxWritableDir(dest)) return toast(`${FX_RO}.`, { kind: 'error' });
  if (mode === 'cut' && paths.some((p) => dest === p || dest.startsWith(p + '/'))) return toast("A folder can't be moved into itself.", { kind: 'error' });
  const res = await fxOp(mode === 'cut' ? 'move' : 'copy', { paths, dest });
  if (!res) return;
  if (mode === 'cut') { FX.clip = null; fxMarkCut(); }
  const made = fxMade(res);
  toast(`${mode === 'cut' ? 'Moved' : 'Copied'} ${made.length === paths.length ? fxLabel(made) : fxLabel(paths)} to ${fxFolderName(dest)}`, { kind: 'success' });
}
async function fxZip(rows) {
  const paths = rows.map((r) => r.rel), dest = fxParent(paths[0]);
  const res = await fxOp('zip', { paths, dest }, `Compressing ${fxLabel(paths)}…`);
  if (res) toast(`Created ${fxLabel([fxMade(res)[0] || (paths.length === 1 ? `${paths[0]}.zip` : 'Archive.zip')])}`, { kind: 'success' });
}
async function fxUnzip(r) {
  const res = await fxOp('unzip', { path: r.rel, dest: fxParent(r.rel) }, `Extracting “${r.e.name}”…`);
  if (res) toast(`Extracted “${r.e.name}”${fxMade(res).length ? ` to ${fxLabel(fxMade(res))}` : ''}`, { kind: 'success' });
}
// Rename and New: the name is typed in place. Enter or leaving the field saves, Esc cancels; a refused name keeps the
// field open (the toast says why). The renamed or created entry ends up selected.
function fxRenameStart(r) {
  if (!r || fxFlat()) return;
  if (fxReadOnly() || r.e.protected) return toast(`${fxReadOnly() ? FX_RO : FX_PROT}.`, { kind: 'error' });
  fxSelect(r.rel);
  FX.edit = { kind: 'rename', rel: r.rel, name: r.e.name, dir: r.e.dir, value: r.e.name, fresh: true };
  fxRender();
}
// `dir`: the folder it goes in (the one shown, or a folder row's); its row sits at the top of the listing.
function fxNewStart(type, dir) {
  if (fxFlat() || !FX.data) return;
  FX.edit = { kind: 'new', type, dir, value: '', fresh: true };
  fxRender();
  $('fxMain').scrollTop = 0;
}
function fxNewRow(cls) {
  const o = el('div', `${cls} fx-new`), e = { name: '', dir: FX.edit.type === 'dir' };
  if (cls === 'fx-item') { o.append(iconFor(e, '', true), el('span', 'fx-name')); return o; }
  const name = el('span', 'fx-c name'), nm = el('span', 'fx-n');
  nm.append(el('span', 'fx-nt'));
  name.append(el('span', 'fx-disc-sp'), iconFor(e, '', false), nm);
  o.append(name);
  return o;
}
// Puts the field for FX.edit where the name shows (called by every render of a folder).
function fxEditMount() {
  const ed = FX.edit, main = $('fxMain');
  if (!ed) return;
  const i = ed.kind === 'rename' ? FX.rows.findIndex((r) => r.rel === ed.rel) : -1;
  const spot = ed.kind === 'new' ? main.querySelector('.fx-new :is(.fx-nt, .fx-name)') : i >= 0 && main.querySelector(`#fx-o-${i} :is(.fx-nt, .fx-name)`);
  if (!spot) { FX.edit = null; return; }
  const f = el('input', 'fx-edit');
  Object.assign(f, { type: 'text', value: ed.value, readOnly: !!ed.busy, autocomplete: 'off', spellcheck: false });
  f.setAttribute('autocapitalize', 'off');
  f.setAttribute('autocorrect', 'off');
  f.setAttribute('enterkeyhint', 'done');
  f.setAttribute('aria-label', ed.kind === 'rename' ? `Rename ${ed.name}` : ed.type === 'dir' ? 'New folder name' : 'New file name');
  f.placeholder = ed.kind === 'new' ? (ed.type === 'dir' ? 'Folder name' : 'File name') : '';
  f.addEventListener('input', () => { ed.value = f.value; });
  f.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); fxEditCommit(); }
    else if (e.key === 'Escape') { e.preventDefault(); fxEditCancel(); }
  });
  // Leaving the field saves, unless a redraw just moved the focus to its replacement (or the window lost focus).
  f.addEventListener('blur', () => setTimeout(() => { if (FX.edit === ed && !ed.busy && !document.activeElement?.classList.contains('fx-edit')) fxEditCommit(); }));
  spot.replaceWith(f);
  f.focus({ preventScroll: true });
  f.scrollIntoView({ block: 'nearest' });
  if (ed.fresh) {
    ed.fresh = false;
    const dot = ed.kind === 'rename' && !ed.dir ? f.value.lastIndexOf('.') : -1; // Finder selects the name, not the extension
    f.setSelectionRange(0, dot > 0 ? dot : f.value.length);
  }
}
function fxEditCancel() {
  FX.edit = null;
  fxRender();
  fxFocus();
}
async function fxEditCommit() {
  const ed = FX.edit;
  if (!ed || ed.busy) return;
  const name = ed.value.trim();
  if (!name || (ed.kind === 'rename' && name === ed.name)) return fxEditCancel();
  ed.busy = true;
  const field = $('fxMain').querySelector('.fx-edit');
  if (field) field.readOnly = true;
  const res = ed.kind === 'rename' ? await fxOp('rename', { path: ed.rel, name }) : await fxOp('new', { dir: ed.dir, name, type: ed.type });
  if (FX.edit !== ed) return;
  if (!res) { ed.busy = false; ed.fresh = true; return; } // fxOp's refresh puts the field back
  FX.edit = null;
  let rel;
  if (ed.kind === 'rename') {
    rel = typeof res.to === 'string' ? res.to : join(fxParent(ed.rel), name);
    for (const k of [...FX.expanded]) if (k === ed.rel || k.startsWith(ed.rel + '/')) { FX.expanded.delete(k); FX.expanded.add(rel + k.slice(ed.rel.length)); }
  } else {
    rel = typeof res.created === 'string' ? res.created : join(ed.dir, name);
    if (ed.dir !== FX.path && FX.view === 'list') FX.expanded.add(ed.dir); // shown in place, under its folder
    else if (ed.dir !== FX.path) { toast(`Created “${name}” in “${fxFolderName(ed.dir)}”`, { kind: 'success' }); rel = ed.dir; }
  }
  FX.sel = rel; FX.picked = new Set([rel]); FX.anchor = rel; // the refresh fxOp started selects it
}
// Delete: an in-page confirm (a sheet on phones), then /api/files/delete; the next row down takes the selection.
function fxConfirmDelete(rows) {
  const paths = rows.map((r) => r.rel);
  if (!paths.length || $('fxConfirm')) return;
  if (fxReadOnly() || rows.some((r) => r.e.protected)) return toast(`${fxReadOnly() ? FX_RO : FX_PROT}.`, { kind: 'error' });
  const back = document.activeElement;
  const m = el('div', 'modal sheet fx-confirm');
  m.id = 'fxConfirm';
  m.innerHTML = `
    <div class="modal-backdrop" data-close></div>
    <div class="modal-panel fx-cf-panel" role="alertdialog" aria-modal="true" aria-labelledby="fxCfTitle" aria-describedby="fxCfText">
      <span class="sheet-grip" aria-hidden="true"></span>
      <h2 id="fxCfTitle"></h2>
      <p class="m-sub" id="fxCfText">This can't be undone.</p>
      <div class="fx-cf-acts"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn fx-cf-del" id="fxCfDel">Delete</button></div>
    </div>`;
  m.querySelector('h2').textContent = `Delete ${fxLabel(paths)}?`;
  const close = (ok) => {
    m.remove();
    if (ok) fxDelete(paths);
    else if (back?.isConnected) back.focus({ preventScroll: true }); else fxFocus();
  };
  m.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(false); else if (e.target.closest('#fxCfDel')) close(true); });
  m.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(false); }
    else if (e.key === 'Tab') { // the two buttons are all there is
      e.preventDefault();
      const bs = [...m.querySelectorAll('.fx-cf-acts .btn')];
      bs[(bs.indexOf(document.activeElement) + 1) % bs.length].focus();
    }
  });
  document.body.append(m);
  m.querySelector('.fx-cf-acts [data-close]').focus(); // not the destructive one (HIG)
}
async function fxDelete(paths) {
  const gone = (rel) => paths.some((p) => rel === p || rel.startsWith(p + '/'));
  const at = FX.rows.findIndex((r) => gone(r.rel));
  const next = FX.rows.slice(at + 1).find((r) => !gone(r.rel)) || FX.rows.slice(0, Math.max(0, at)).reverse().find((r) => !gone(r.rel));
  if (FX.ql && gone(FX.ql.r.rel)) fxClosePreview();
  const res = await fxOp('delete', { paths }, paths.length > 1 ? `Deleting ${fxLabel(paths)}…` : '');
  if (!res) return;
  if (FX.clip) FX.clip.paths = FX.clip.paths.filter((p) => !gone(p));
  const deleted = Array.isArray(res.deleted) ? res.deleted : [], skipped = Array.isArray(res.skipped) ? res.skipped : [];
  FX.sel = next?.rel ?? null; FX.picked = new Set(FX.sel ? [FX.sel] : []); FX.anchor = FX.sel;
  if (skipped.length) toast(`Couldn't delete ${skipped.map((x) => `“${String(x.path).split('/').pop()}” (${x.reason})`).join(', ')}`, { kind: 'error' });
  else if (deleted.length) toast(`Deleted ${fxLabel(deleted)}`, { kind: 'success', duration: 2500 });
}
// What an operation made, as project paths, from whatever the server named ({path} | {paths} | {name} | {dest}).
function fxMade(res) {
  if (Array.isArray(res?.paths)) return res.paths.filter((p) => typeof p === 'string');
  const one = res?.path || res?.name || res?.dest;
  return typeof one === 'string' && one ? [one] : [];
}
// POST /api/files/<kind>; busy text shows a progress bar meanwhile. Errors toast; the listing refreshes either way.
async function fxOp(kind, body, busy) {
  const cid = FX.cid;
  if (busy) { $('fxBusyText').textContent = busy; $('fxBusy').hidden = false; }
  try {
    return await api(`/api/files/${kind}?cid=${encodeURIComponent(cid)}`, 'POST', body);
  } catch (e) {
    toast(e.message, { kind: 'error' });
    return null;
  } finally {
    if (busy) $('fxBusy').hidden = true;
    if (cid === FX.cid) fxLoad(true);
  }
}
function fxMenuClose(refocus) {
  const m = FX.menu;
  if (!m) return;
  FX.menu = null;
  m.el.remove();
  document.removeEventListener('pointerdown', m.outside, true);
  window.removeEventListener('resize', m.close);
  $('fxMain').removeEventListener('scroll', m.close);
  if (refocus) fxFocus();
}
// The context menu for row r (null: the folder's background) at (x, y), kept inside the viewport.
function fxMenuOpen(r, x, y) {
  fxMenuClose();
  if (r && !FX.picked.has(r.rel)) fxSelect(r.rel);
  else if (!r) fxSelect(null);
  const rows = fxPickedRows(), paths = rows.map((x) => x.rel), dest = r?.e.dir ? r.rel : FX.path;
  const zip = rows.length === 1 && !rows[0].e.dir && extOf(rows[0].e.name) === 'zip';
  // Write actions: off in a read-only location (and for protected files), with the reason as their tooltip.
  const ro = fxReadOnly(), prot = rows.some((x) => x.e.protected), why = (bad) => (bad ? (ro ? FX_RO : FX_PROT) : '');
  const destRo = !fxWritableDir(dest);
  const items = [
    ['open', 'Open', '', !!r, () => fxOpen(r)],
    '-',
    ['copy', 'Copy', fxKeys('C'), !!rows.length && !prot, () => fxClipSet('copy'), prot ? FX_PROT : ''],
    ['cut', 'Cut', fxKeys('X'), !!rows.length && !ro && !prot, () => fxClipSet('cut'), why(ro || prot)],
    ['paste', r?.e.dir ? `Paste into “${r.e.name}”` : 'Paste', fxKeys('V'), fxClipOk() && !destRo, () => fxPaste(dest), destRo ? FX_RO : ''],
    '-',
    ['zip', 'Compress to ZIP', '', !!rows.length && !ro && !prot, () => fxZip(rows), why(ro || prot)],
    ...(zip ? [['unzip', 'Extract here', '', !ro, () => fxUnzip(rows[0]), ro ? FX_RO : '']] : []),
    '-',
    ['rename', 'Rename…', 'F2', rows.length === 1 && !!r && !ro && !prot, () => fxRenameStart(r), why(ro || prot)],
    ['newfile', 'New file…', '', (!r || r.e.dir) && !destRo, () => fxNewStart('file', dest), destRo ? FX_RO : ''],
    ['newdir', 'New folder…', '', (!r || r.e.dir) && !destRo, () => fxNewStart('dir', dest), destRo ? FX_RO : ''],
    '-',
    ['delete', 'Delete', FX_MAC ? '⌫' : 'Del', !!rows.length && !ro && !prot, () => fxConfirmDelete(rows), why(ro || prot)],
    '-',
    ['path', paths.length > 1 ? 'Copy paths' : 'Copy path', '', !!rows.length, async () => {
      toast((await copyToClipboard(paths.join('\n'))) ? `${paths.length > 1 ? 'Paths' : 'Path'} copied` : "Couldn't copy", { duration: 2000 });
    }],
    ['ask', 'Ask in chat', '⇧Enter', !!rows.length, () => fxAskAbout(paths.map(fxRel).join(' '))],
  ];
  fxMenuShow(items, r ? r.e.name : fxFolderName(FX.path), x, y, ro ? `${FX_RO}.` : '');
}
// Builds and shows a menu: items are '-' or [act, label, keys, enabled, run, tooltip]; note: a line of text at the end.
function fxMenuShow(items, label, x, y, note = '') {
  fxMenuClose();
  const m = el('div', 'cmenu fx-menu');
  m.id = 'fxMenu';
  m.setAttribute('role', 'menu');
  m.setAttribute('aria-label', label);
  for (const it of items) {
    if (it === '-') { m.append(el('div', 'cm-sep')); continue; }
    const [act, text, keys, on, run, tip] = it;
    const b = el('button', 'cm-opt');
    b.type = 'button'; b.tabIndex = -1; b.disabled = !on; b.dataset.act = act;
    if (tip) b.title = tip;
    b.setAttribute('role', 'menuitem');
    b.append(el('span', 'cm-l', text));
    if (keys) b.append(el('span', 'cm-h', keys));
    if (act === 'delete') b.classList.add('fx-danger');
    b.onclick = () => { fxMenuClose(!['open', 'ask', 'place', 'goto', 'rename', 'newfile', 'newdir', 'delete'].includes(act)); run(); };
    m.append(b);
  }
  if (note) m.append(el('div', 'fx-menu-note', note));
  m.addEventListener('keydown', (e) => {
    const opts = [...m.querySelectorAll('.cm-opt:not(:disabled)')], k = opts.indexOf(document.activeElement), n = opts.length;
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); fxMenuClose(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); opts[e.key === 'ArrowDown' ? (k + 1) % n : k <= 0 ? n - 1 : k - 1]?.focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); opts[e.key === 'Home' ? 0 : opts.length - 1]?.focus(); }
  });
  document.body.append(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  m.style.top = `${Math.max(8, y + h > innerHeight - 8 ? Math.min(y - h, innerHeight - h - 8) : y)}px`;
  const close = () => fxMenuClose();
  const outside = (e) => { if (!m.contains(e.target) && !e.target.closest?.('#fxPlaces')) fxMenuClose(); }; // Places toggles its own
  FX.menu = { el: m, close, outside };
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', close);
  $('fxMain').addEventListener('scroll', close);
  m.querySelector('.cm-opt:not(:disabled)')?.focus({ preventScroll: true });
  return m;
}
// Places: the project, home, / and /tmp (as the server names them), then Go to folder.
function fxPlacesOpen(x, y) {
  if (FX.menu?.el.dataset.places) return fxMenuClose(true);
  const places = FX.places || [{ label: 'Project', path: FX.proj || '' }, { label: '/', path: '/' }, { label: '/tmp', path: '/tmp' }];
  const m = fxMenuShow([
    ...places.map((p) => ['place', p.label, p.label === p.path ? '' : fxTilde(p.path), !!FX.cid, () => fxNav(p.path), p.path]),
    '-',
    ['goto', 'Go to folder…', fxKeys('L'), !!FX.cid, () => fxGotoOpen()],
  ], 'Places', x, y);
  m.dataset.places = '1';
  m.querySelectorAll('[data-act="place"]').forEach((b, i) => { if (places[i].path === FX.path) b.setAttribute('aria-current', 'location'); });
}

// ----- Go to folder (⌘L): an absolute, ~ or relative path; folder names complete from the listings (Tab, ↓↑, a click)
const fxHome = () => (FX.places || []).find((p) => p.label === 'Home')?.path || null;
const fxTilde = (p) => { const h = fxHome(); return h && (p === h || p.startsWith(h + '/')) ? '~' + p.slice(h.length) : p; };
// A typed path as a clean absolute one ('..' and '.' resolved); null when it names ~ but home isn't known.
function fxResolve(t) {
  t = t.trim();
  if (t === '~' || t.startsWith('~/')) { const h = fxHome(); if (!h) return null; t = h + t.slice(1); }
  else if (!t.startsWith('/')) t = fxJoin(FX.path.startsWith('/') ? FX.path : FX.proj || '/', t);
  const out = [];
  for (const s of t.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return '/' + out.join('/');
}
function fxGotoOpen() {
  fxMenuClose();
  const bar = $('fxGotoBar'), input = $('fxGoto');
  bar.hidden = false;
  FX.goto.cache.clear();
  if (!input.value) input.value = FX.path.startsWith('/') ? fxTilde(FX.path) + (FX.path === '/' ? '' : '/') : '';
  input.focus();
  input.select();
  fxGotoSuggest();
}
function fxGotoClose(refocus) {
  if (!FX.built) return;
  $('fxGotoBar').hidden = true;
  $('fxGoto').value = '';
  fxGotoList([]);
  if (refocus) fxFocus();
}
function fxGotoGo(p) {
  const t = p ?? $('fxGoto').value;
  if (!t.trim()) return;
  const to = fxResolve(t);
  if (!to) return toast("Home isn't known yet: type the full path.", { kind: 'error' });
  fxGotoClose();
  fxNav(to);
}
// The folders in the typed path's folder that start with its last part (the open listing when it's this folder).
async function fxGotoSuggest() {
  const t = $('fxGoto').value, seq = ++FX.goto.seq;
  const slash = t.lastIndexOf('/'), head = t.slice(0, slash + 1), part = t.slice(slash + 1).toLowerCase();
  const dir = head ? fxResolve(head) : t.startsWith('~') ? null : FX.path;
  if (!dir || !t.trim()) return fxGotoList([]);
  let entries = dir === FX.path && FX.data?.dir === dir ? FX.data.entries : FX.goto.cache.get(dir);
  if (!entries) {
    try { entries = (await api(fxListUrl(dir))).entries; } catch { entries = []; }
    FX.goto.cache.set(dir, entries);
    if (seq !== FX.goto.seq) return;
  }
  const opts = entries.filter((e) => e.dir && e.name.toLowerCase().startsWith(part) && (FX.hidden || !e.hidden || part.startsWith('.')))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })).slice(0, 8)
    .map((e) => ({ name: e.name, value: `${head}${e.name}/`, path: fxJoin(dir, e.name) }));
  fxGotoList(opts.length === 1 && opts[0].value === t ? [] : opts);
}
function fxGotoList(opts, i = -1) {
  const box = $('fxSugg'), input = $('fxGoto');
  FX.goto.opts = opts; FX.goto.i = i;
  box.textContent = '';
  box.hidden = !opts.length;
  input.setAttribute('aria-expanded', String(!!opts.length));
  input.removeAttribute('aria-activedescendant');
  opts.forEach((o, k) => {
    const b = el('div', 'fx-sug');
    b.id = `fx-sug-${k}`;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(k === i));
    b.title = o.path;
    b.innerHTML = FOLDER_SVG;
    b.append(el('span', '', o.name));
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the focus in the field
    b.onclick = () => fxGotoPick(o);
    box.append(b);
  });
  if (i >= 0) input.setAttribute('aria-activedescendant', `fx-sug-${i}`);
}
function fxGotoPick(o) {
  const input = $('fxGoto');
  input.value = o.value;
  input.focus();
  fxGotoSuggest();
}
function fxGotoKey(e) {
  const { opts, i } = FX.goto;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (opts.length) fxGotoList([]); else fxGotoClose(true); }
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && opts.length) {
    e.preventDefault();
    fxGotoList(opts, e.key === 'ArrowDown' ? (i + 1) % opts.length : i <= 0 ? opts.length - 1 : i - 1);
  } else if (e.key === 'Tab' && !e.shiftKey && opts.length) { e.preventDefault(); fxGotoPick(opts[Math.max(0, i)]); }
  else if (e.key === 'Enter' && i >= 0 && opts[i]) { e.preventDefault(); fxGotoGo(opts[i].path); }
}

// ----- Quick Look: text (line numbers), Markdown (rendered or source), images and diffs (Changed view: coloured or
// source; File opens the file itself); ←/→ step through the folder's files
function fxQuickLook() {
  if ($('fxQL')) return $('fxQL');
  const m = el('div', 'modal fx-ql');
  m.id = 'fxQL';
  m.hidden = true;
  m.innerHTML = `
    <div class="modal-backdrop" data-close></div>
    <div class="modal-panel fx-ql-panel" role="dialog" aria-modal="true" aria-labelledby="fxQLTitle">
      <div class="m-head">
        <div><h2 id="fxQLTitle"></h2><p class="m-sub" id="fxQLSub"></p></div>
        <div class="seg-sm fx-md" id="fxQLMode" role="radiogroup" aria-label="Show" hidden>
          <button type="button" role="radio" data-mode="preview">Preview</button><button type="button" role="radio" data-mode="source">Source</button>
        </div>
        <button type="button" class="icon-btn" id="fxQLAsk" aria-label="Ask in chat" title="Ask in chat">${ICON_ASK}</button>
        <a class="btn small fx-ql-file" id="fxQLFile" target="_blank" rel="noopener" title="Open the file itself in a new tab" hidden>File</a>
        <a class="icon-btn" id="fxQLOpen" target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
        <button type="button" class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      </div>
      <div class="fx-ql-body" id="fxQLBody"></div>
    </div>`;
  document.body.append(m);
  m.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) fxClosePreview(); });
  $('fxQLAsk').onclick = () => { const r = FX.ql?.r; if (r) fxAskAbout(r.file || r.rel, r.hit?.line); };
  m.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { store.set(FX.ql?.r.ch ? 'cw.files.diff' : 'cw.files.md', b.dataset.mode); if (FX.ql) fxPreview(FX.ql.r); }));
  m.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || (e.key === ' ' && !e.target.closest('button, a'))) { e.preventDefault(); e.stopPropagation(); fxClosePreview(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const files = FX.rows.filter((r) => !r.e.dir), k = files.findIndex((r) => r.rel === FX.ql?.r.rel);
      const next = files[k + (e.key === 'ArrowRight' ? 1 : -1)];
      if (next) { e.preventDefault(); fxSelect(next.rel); }
    }
  });
  return m;
}
async function fxPreview(r) {
  const m = fxQuickLook(), seq = ++FX.qseq;
  const wasOpen = !m.hidden;
  FX.ql = { r, back: wasOpen ? FX.ql?.back : document.activeElement };
  m.hidden = false;
  const url = fxUrl('raw', r.file || r.rel), body = $('fxQLBody');
  $('fxQLTitle').textContent = r.e.name;
  $('fxQLSub').textContent = r.hit ? `${r.file} · line ${r.hit.line}` : `${kindOf(r.e)} · ${fxSize(r.e.size)} · ${fxDate(r.e.mtime)}`;
  $('fxQLOpen').href = url;
  $('fxQLOpen').title = 'Open in a new tab';
  $('fxQLOpen').hidden = !!r.e.protected;
  $('fxQLFile').hidden = true;
  $('fxQLMode').hidden = !r.ch; // a diff always has Preview | Source: hiding it would drop the focus of the one just clicked
  body.className = 'fx-ql-body';
  body.textContent = '';
  if (!wasOpen) m.querySelector('[data-close].icon-btn').focus();
  if (r.ch) return fxDiff(r, seq);
  if (r.e.protected) return body.append(fxEmpty(FX_PROT, 'agent-orch never shows secrets such as keys, tokens and credentials.', 'fx-prot'));
  if (isImage(r.e.name)) {
    body.classList.add('img');
    const img = el('img');
    img.alt = r.e.name; img.src = url;
    img.onerror = () => { body.textContent = ''; body.append(fxEmpty('No preview', 'This image could not be shown.')); };
    body.append(img);
    return;
  }
  body.append(el('div', 'fx-loading', 'Loading…'));
  let text, truncated = false;
  try {
    const res = await fetch(url);
    if (res.status === 401) { location.href = '/login'; return; }
    if (!res.ok) throw Object.assign(new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`), { status: res.status });
    text = await res.text();
    truncated = res.headers.get('X-Truncated') === '1';
  } catch (e) {
    if (seq !== FX.qseq || FX.ql?.r !== r) return;
    body.textContent = '';
    body.append(fxEmpty(e.status === 415 ? 'No preview for this file' : "Couldn't open it", e.status === 415 ? `${kindOf(r.e)} · ${fxSize(r.e.size)}. Only text and images open here.` : e.message));
    return;
  }
  if (seq !== FX.qseq || FX.ql?.r !== r) return;
  body.textContent = '';
  if (truncated) body.append(el('div', 'fx-trunc', `Showing the first 1 MB of ${fxSize(r.e.size)}.`));
  const mdFile = /^(md|markdown|mdx)$/.test(extOf(r.e.name));
  const mode = store.get('cw.files.md') === 'source' ? 'source' : 'preview';
  if (mdFile) {
    $('fxQLMode').hidden = false;
    $('fxQLMode').querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  }
  if (mdFile && mode === 'preview') {
    const doc = el('div', 'fx-md-doc md');
    doc.innerHTML = md(text);
    body.append(doc);
    return;
  }
  // Two <pre>s side by side: a line-number gutter and the text (cheap even for 30k lines).
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  const code = el('div', 'fx-code');
  code.append(el('pre', 'fx-gutter', Array.from({ length: Math.max(1, lines) }, (_, k) => k + 1).join('\n')), el('pre', 'fx-text', text));
  body.append(code);
  if (r.hit) body.scrollTop = Math.max(0, code.offsetTop + 12 + (r.hit.line - 1) * (parseFloat(getComputedStyle(code).lineHeight) || 19) - body.clientHeight / 3);
}
// A changed file's diff in Quick Look: Preview colours it line by line (added, removed, hunk headers), Source is the text.
async function fxDiff(r, seq) {
  const c = r.ch, body = $('fxQLBody'), url = fxUrl('diff', r.rel);
  $('fxQLSub').textContent = `${FX_STATUS[c.status] || c.status}${c.from ? ` from ${c.from}` : ''} · ${c.binary ? 'binary' : `+${c.add} −${c.del}`}`;
  $('fxQLOpen').href = url;
  $('fxQLOpen').title = 'Open the diff in a new tab';
  $('fxQLFile').href = fxUrl('raw', r.rel);
  $('fxQLFile').hidden = c.status === 'D';
  body.append(el('div', 'fx-loading', 'Loading…'));
  let text, truncated = false;
  try {
    const res = await fetch(url);
    if (res.status === 401) { location.href = '/login'; return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    text = await res.text();
    truncated = res.headers.get('X-Truncated') === '1';
  } catch (e) {
    if (seq !== FX.qseq || FX.ql?.r !== r) return;
    body.textContent = '';
    $('fxQLMode').hidden = true;
    body.append(fxEmpty("Couldn't show the diff", e.message));
    return;
  }
  if (seq !== FX.qseq || FX.ql?.r !== r) return;
  body.textContent = '';
  if (truncated) body.append(el('div', 'fx-trunc', 'Showing the first 200 KB of the diff.'));
  const mode = store.get('cw.files.diff') === 'source' ? 'source' : 'preview';
  $('fxQLMode').hidden = false;
  $('fxQLMode').querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  const code = el('div', 'fx-code');
  if (mode === 'source') code.append(el('pre', 'fx-text', text));
  else {
    // One span per line (textContent, so nothing in the diff is markup); lines before the first @@ of a file are headers.
    const pre = el('pre', 'fx-diff');
    let head = true;
    for (const line of text.replace(/\n$/, '').split('\n')) {
      if (line.startsWith('diff --git')) head = true; // a rename can show as two files
      else if (line.startsWith('@@')) head = false;
      const cls = line.startsWith('@@') ? 'hunk' : head || line[0] === '\\' ? 'meta' : line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
      pre.append(el('span', `fx-dl ${cls}`, `${line}\n`));
    }
    code.append(pre);
  }
  body.append(code);
}
function fxClosePreview() {
  const m = $('fxQL');
  if (!m || m.hidden) return;
  m.hidden = true;
  const back = FX.ql?.back;
  FX.ql = null;
  if (back?.isConnected) back.focus(); else fxFocus();
}

// Hooks for app.js: setView('files') shows it; a chat switch while it's open reloads it; returning to the tab refreshes.
window.FilesView = { show: filesShow };
document.addEventListener('visibilitychange', () => {
  if (document.hidden || $('app').dataset.view !== 'files' || !FX.cid) return;
  fxLoad();
  if (FX.view === 'changed') fxChanged();
});
if ($('app').dataset.view === 'files') filesShow();
