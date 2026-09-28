'use strict';
// ---------- Files: a Finder-style, read-only browser of the open chat's project (server: files.mjs) ----------
// Icon and list views (list folders open in place with disclosure triangles), back/forward, a path bar, a name filter,
// hidden files on request (⌘⇧.), project-wide search by name or inside files (Enter in the search field; Names | Contents), and Quick Look (Space or double-click) for text, Markdown and images.
// Ask in chat (Quick Look's header, a Contents hit's trailing button, Shift+Enter on a row) puts `path[:line]` into the composer. Loaded after
// app.js and uses its helpers ($, el, api, store, md, currentConvo).
const FX = {
  cid: null, path: '', data: null, err: '', seq: 0, qseq: 0, fseq: 0, find: null, back: [], fwd: [], sel: null, filter: '', rows: [],
  view: store.get('cw.files.view') === 'list' ? 'list' : 'icons',
  sort: (() => { try { const s = JSON.parse(store.get('cw.files.sort')); if (s?.key) return s; } catch {} return { key: 'name', dir: 1 }; })(),
  hidden: store.get('cw.files.hidden') === '1',
  mode: store.get('cw.files.mode') === 'contents' ? 'contents' : 'names', // what Search project looks at
  expanded: new Set(), kids: new Map(), built: false, ql: null,
};
const FX_THUMB_MAX = 3e6; // images up to this size show as their own thumbnail in the icon view
const touch = () => matchMedia('(pointer: coarse)').matches;
const fxUrl = (kind, rel) => `/api/files/${kind}?cid=${encodeURIComponent(FX.cid)}&path=${encodeURIComponent(rel)}`;
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
function iconFor(e, rel, big) {
  const box = el('span', 'fx-ico');
  if (e.dir) box.innerHTML = FOLDER_SVG;
  else if (big && isImage(e.name) && e.size <= FX_THUMB_MAX) {
    const img = el('img');
    img.loading = 'lazy'; img.decoding = 'async'; img.alt = ''; img.src = fxUrl('raw', rel);
    img.onerror = () => { box.innerHTML = pageSvg(extOf(e.name)); };
    box.classList.add('thumb');
    box.append(img);
  } else box.innerHTML = pageSvg(extOf(e.name));
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
      </div>
      <h2 class="fx-title" id="fxTitle">Files</h2>
      <div class="fx-tools">
        <div class="fx-views seg-sm" role="radiogroup" aria-label="View as">
          <button type="button" role="radio" data-fxview="icons" aria-label="Icons" title="as Icons">${ICON_GRID}</button>
          <button type="button" role="radio" data-fxview="list" aria-label="List" title="as List">${ICON_LIST}</button>
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
    <div class="fx-main" id="fxMain"></div>
    <div class="fx-path" id="fxPath"></div>`;
  $('fxBack').onclick = () => fxHistory(-1);
  $('fxFwd').onclick = () => fxHistory(1);
  $('fxRefresh').onclick = () => (FX.find ? fxFind(FX.find.q) : fxLoad());
  v.querySelectorAll('[data-fxmode]').forEach((b) => b.addEventListener('click', () => {
    FX.mode = b.dataset.fxmode; store.set('cw.files.mode', FX.mode);
    if (FX.find) fxFind(FX.find.q); else fxRender();
  }));
  $('fxFindBtn').onclick = () => fxFind($('fxFilter').value.trim());
  $('fxHidden').onclick = () => fxToggleHidden();
  v.querySelectorAll('[data-fxview]').forEach((b) => b.addEventListener('click', () => {
    FX.view = b.dataset.fxview; store.set('cw.files.view', FX.view); fxRender(); fxFocus();
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
  v.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === '.') { e.preventDefault(); fxToggleHidden(); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === '[' || e.key === ']')) { e.preventDefault(); fxHistory(e.key === '[' ? -1 : 1); }
  });
}

// ----- data
// Shows the open chat's project; a different chat starts at its last folder (remembered per chat).
function filesShow() {
  fxBuild();
  const cid = currentConvo()?.id || null;
  if (cid !== FX.cid) {
    Object.assign(FX, { cid, path: (cid && store.get('cw.files.path.' + cid)) || '', back: [], fwd: [], sel: null, filter: '', data: null, err: '', find: null });
    FX.expanded.clear(); FX.kids.clear();
    $('fxFilter').value = ''; $('fxFindBar').hidden = true;
  }
  if (!cid) { fxRender(); return; }
  fxLoad();
}
async function fxLoad(focus = false) {
  if (!FX.cid) return fxRender();
  const seq = ++FX.seq, { cid, path } = FX;
  $('filesView').classList.add('loading');
  try {
    const d = await api(fxUrl('list', path));
    if (seq !== FX.seq || cid !== FX.cid) return;
    FX.data = d; FX.err = ''; FX.path = d.path;
    // Refresh any folders opened in place in the list view.
    for (const rel of [...FX.expanded]) {
      try { FX.kids.set(rel, (await api(fxUrl('list', rel))).entries); } catch { FX.expanded.delete(rel); FX.kids.delete(rel); }
    }
    if (seq !== FX.seq) return;
  } catch (e) {
    if (seq !== FX.seq) return;
    FX.data = null; FX.err = e.message;
    if (FX.path && /Not found|Not a folder|Outside/.test(e.message)) { FX.path = ''; store.del('cw.files.path.' + cid); return fxLoad(focus); }
  } finally { if (seq === FX.seq) $('filesView').classList.remove('loading'); }
  fxRender();
  if (focus) fxFocus();
}
function fxGo(rel, { push = true } = {}) {
  if (push && rel !== FX.path) { FX.back.push(FX.path); FX.fwd = []; }
  FX.path = rel; FX.sel = null; FX.filter = ''; FX.find = null; $('fxFilter').value = ''; $('fxFindBar').hidden = true;
  FX.expanded.clear(); FX.kids.clear();
  store.set('cw.files.path.' + FX.cid, rel);
  fxLoad(true);
}
function fxHistory(dir) {
  const from = dir < 0 ? FX.back : FX.fwd, to = dir < 0 ? FX.fwd : FX.back;
  if (!from.length) return;
  const prev = FX.path;
  to.push(prev);
  fxGo(from.pop(), { push: false });
  FX.sel = prev.startsWith(FX.path) ? prev : null; // back out of a folder: it stays selected
}
function fxUp() {
  if (!FX.path) return;
  const child = FX.path;
  fxGo(FX.path.split('/').slice(0, -1).join('/'));
  FX.sel = child;
}
function fxToggleHidden() {
  FX.hidden = !FX.hidden; store.set('cw.files.hidden', FX.hidden ? '1' : '0'); fxRender();
}
// Project-wide search, by name (find) or inside files (grep) as FX.mode says: results replace the folder until a name
// result is opened, Escape, or the field is cleared.
async function fxFind(q) {
  if (!FX.cid || q.length < 2) return;
  const seq = ++FX.fseq, cid = FX.cid, mode = FX.mode;
  FX.find = { q, mode, data: null, err: '' }; FX.sel = null;
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
function fxFindExit(clear) {
  FX.fseq++; FX.find = null; FX.sel = null;
  if (clear) { FX.filter = ''; $('fxFilter').value = ''; $('fxFindBar').hidden = true; }
  fxRender();
}
// Opening a result shows its folder with it selected (hidden files turn on when it is one).
function fxReveal(r) {
  const parts = r.rel.split('/');
  if (!FX.hidden && parts.some((p) => p.startsWith('.'))) fxToggleHidden();
  fxGo(parts.slice(0, -1).join('/'));
  FX.sel = r.rel;
}
const join = (a, b) => (a ? `${a}/${b}` : b);
const ICON_ASK = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
// `rel[:line]` into the composer at the caret (spaced from its neighbours), then back to the chat with the caret after it.
function fxAskAbout(rel, line) {
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
  $('fxHidden').setAttribute('aria-pressed', String(FX.hidden));
  $('filesView').querySelectorAll('[data-fxview]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.fxview === FX.view)));
  $('filesView').querySelectorAll('[data-fxmode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fxmode === FX.mode)));
  $('fxTitle').textContent = d?.name || currentConvo()?.title || 'Files';
  main.textContent = '';
  main.className = `fx-main ${FX.view}`;
  if (!FX.cid) {
    main.append(fxEmpty('No project yet', 'Files shows the project of the chat you have open. Pick a project in Vibecode to browse it here.'));
    $('fxPath').textContent = '';
    return;
  }
  if (FX.find) return fxFound(main);
  if (!d) {
    main.append(FX.err ? fxEmpty("Couldn't open this folder", FX.err) : el('div', 'fx-loading', 'Loading…'));
    $('fxPath').textContent = '';
    return;
  }
  FX.rows = [];
  const add = (entries, base, depth) => {
    for (const e of fxSorted(entries)) {
      const rel = join(base, e.name);
      FX.rows.push({ e, rel, depth });
      if (FX.view === 'list' && e.dir && FX.expanded.has(rel) && FX.kids.has(rel)) add(FX.kids.get(rel), rel, depth + 1);
    }
  };
  add(d.entries, FX.path, 0);
  if (FX.sel && !FX.rows.some((r) => r.rel === FX.sel)) FX.sel = null;
  if (!FX.rows.length) main.append(fxEmpty(FX.filter ? 'No matches' : 'This folder is empty', FX.filter ? `Nothing here is named like “${FX.filter}”.` : d.entries.length ? 'It only has hidden files (⌘⇧. shows them).' : ''));
  else if (FX.view === 'icons') main.append(fxIcons());
  else main.append(fxList());
  fxPathBar();
}
function fxFound(main) {
  const { q, mode, data, err } = FX.find;
  $('fxPath').textContent = '';
  if (!data) { FX.rows = []; return main.append(err ? fxEmpty("Couldn't search this project", err) : el('div', 'fx-loading', 'Searching…')); }
  if (mode === 'contents') return fxFoundLines(main);
  FX.rows = data.entries.map((e) => ({ e, rel: e.path, depth: 0 }));
  if (FX.sel && !FX.rows.some((r) => r.rel === FX.sel)) FX.sel = null;
  if (!FX.rows.length) main.append(fxEmpty(`No files named like “${q}”`, data.truncated ? 'The project is too big to search all of it.' : 'Hidden folders, .git and node_modules are skipped.'));
  else {
    const t = el('div', 'fx-rows fx-found');
    t.setAttribute('role', 'listbox');
    t.setAttribute('aria-label', `Files named like “${q}”, ${FX.rows.length} found`);
    t.tabIndex = 0;
    FX.rows.forEach((r, i) => {
      const o = optionFor(r, i, 'fx-row'), folder = r.rel.split('/').slice(0, -1).join('/') || FX.data?.crumbs[0].name || '/';
      const name = el('span', 'fx-c name'), nm = el('span', 'fx-n');
      nm.append(el('span', 'fx-nt', r.e.name), el('span', 'fx-sub', r.e.dir ? folder : `${folder} · ${fxSize(r.e.size)}`)); // sub: phones only
      name.append(el('span', 'fx-disc-sp'), iconFor(r.e, r.rel, false), nm);
      o.title = r.rel;
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
// Contents results: a heading per file, then one row per matching line (`line · text`, the match in <mark>). A row's
// rel is unique per line; `file` is what Quick Look opens.
function fxFoundLines(main) {
  const { q, data } = FX.find;
  FX.rows = data.hits.map((h) => ({ e: { name: h.path.split('/').pop(), dir: false, size: null, mtime: null }, rel: `${h.path}#L${h.line}`, file: h.path, hit: h, depth: 0 }));
  if (FX.sel && !FX.rows.some((r) => r.rel === FX.sel)) FX.sel = null;
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
function fxEmpty(title, text) {
  const box = el('div', 'fx-empty');
  box.innerHTML = FOLDER_SVG;
  box.append(el('strong', '', title), el('p', '', text));
  return box;
}
function optionFor(r, i, cls) {
  const o = el('div', cls);
  o.id = `fx-o-${i}`;
  o.dataset.i = String(i);
  o.setAttribute('role', FX.view === 'list' && !FX.find ? 'treeitem' : 'option');
  o.setAttribute('aria-selected', String(r.rel === FX.sel));
  o.title = r.e.name;
  o.addEventListener('click', (ev) => { if (ev.target.closest('.fx-disc, .fx-ask')) return; fxSelect(r.rel); if (touch()) fxOpen(r); });
  o.addEventListener('dblclick', () => { if (!touch()) fxOpen(r); });
  return o;
}
function fxIcons() {
  const g = el('div', 'fx-grid');
  g.setAttribute('role', 'listbox');
  g.setAttribute('aria-label', `${FX.data.name}, ${FX.rows.length} items`);
  g.tabIndex = 0;
  FX.rows.forEach((r, i) => {
    const o = optionFor(r, i, 'fx-item');
    o.append(iconFor(r.e, r.rel, true), el('span', 'fx-name', r.e.name));
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
  t.setAttribute('aria-label', `${FX.data.name}, ${FX.rows.length} items`);
  t.tabIndex = 0;
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
    name.append(iconFor(r.e, r.rel, false), nm);
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
function fxPathBar() {
  const bar = $('fxPath');
  bar.textContent = '';
  const crumbs = el('nav', 'fx-crumbs');
  crumbs.setAttribute('aria-label', 'Path');
  FX.data.crumbs.forEach((c, i) => {
    if (i) crumbs.append(el('span', 'fx-sep', '›'));
    const b = el('button', 'fx-crumb');
    b.type = 'button';
    b.innerHTML = FOLDER_SVG;
    b.append(el('span', '', c.name));
    if (i === FX.data.crumbs.length - 1) b.setAttribute('aria-current', 'location');
    b.onclick = () => fxGo(c.path);
    crumbs.append(b);
  });
  const n = FX.rows.length, hiddenCount = FX.hidden ? 0 : FX.data.entries.filter((e) => e.hidden).length;
  bar.append(crumbs, el('span', 'fx-count', `${n} item${n === 1 ? '' : 's'}${hiddenCount && !FX.filter ? ` · ${hiddenCount} hidden` : ''}${FX.data.truncated ? ' · first 5,000 shown' : ''}`));
  crumbs.scrollLeft = crumbs.scrollWidth;
}
async function fxExpand(rel, open) {
  if (!open) { for (const k of [...FX.expanded]) if (k === rel || k.startsWith(rel + '/')) FX.expanded.delete(k); fxRender(); return; }
  FX.expanded.add(rel);
  if (!FX.kids.has(rel)) {
    try { FX.kids.set(rel, (await api(fxUrl('list', rel))).entries); } catch (e) { FX.expanded.delete(rel); toast(e.message, { kind: 'error' }); }
  }
  fxRender();
  fxFocus();
}

// ----- selection, keyboard, opening
function fxSelect(rel) {
  FX.sel = rel;
  const c = $('fxMain').querySelector('[role="listbox"], [role="tree"]');
  if (!c) return;
  c.querySelectorAll('[aria-selected="true"]').forEach((o) => o.setAttribute('aria-selected', 'false'));
  const i = FX.rows.findIndex((r) => r.rel === rel);
  const o = c.querySelector(`#fx-o-${i}`);
  if (o) { o.setAttribute('aria-selected', 'true'); o.scrollIntoView({ block: 'nearest' }); }
  fxActive(c);
  if (FX.ql && i >= 0 && !FX.rows[i].e.dir) fxPreview(FX.rows[i]); // Quick Look follows the selection
}
function fxFocus(selectFirst) {
  const c = $('fxMain').querySelector('[role="listbox"], [role="tree"]');
  if (!c) return;
  if (selectFirst && !FX.sel && FX.rows[0]) fxSelect(FX.rows[0].rel);
  c.focus({ preventScroll: true });
  c.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); // e.g. a revealed find result
}
function fxOpen(r) {
  if (r.hit) fxPreview(r);
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
  const move = (d) => { const n = Math.min(FX.rows.length - 1, Math.max(0, (i < 0 ? (d > 0 ? -1 : FX.rows.length) : i) + d)); if (FX.rows[n]) fxSelect(FX.rows[n].rel); };
  const mod = e.metaKey || e.ctrlKey;
  if (FX.find && (e.key === 'Escape' || e.key === 'Backspace' || (mod && e.key === 'ArrowUp'))) { e.preventDefault(); fxFindExit(true); $('fxFilter').focus(); }
  else if (FX.find && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) e.preventDefault();
  else if (mod && e.key === 'ArrowUp') { e.preventDefault(); fxUp(); }
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
    else if (cur?.depth) fxSelect(cur.rel.split('/').slice(0, -1).join('/'));
  } else if (e.key === 'Home') { e.preventDefault(); if (FX.rows[0]) fxSelect(FX.rows[0].rel); }
  else if (e.key === 'End') { e.preventDefault(); if (FX.rows.length) fxSelect(FX.rows.at(-1).rel); }
}

// ----- Quick Look: text (line numbers), Markdown (rendered or source) and images; ←/→ step through the folder's files
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
        <a class="icon-btn" id="fxQLOpen" target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
        <button type="button" class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      </div>
      <div class="fx-ql-body" id="fxQLBody"></div>
    </div>`;
  document.body.append(m);
  m.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) fxClosePreview(); });
  $('fxQLAsk').onclick = () => { const r = FX.ql?.r; if (r) fxAskAbout(r.file || r.rel, r.hit?.line); };
  m.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { store.set('cw.files.md', b.dataset.mode); if (FX.ql) fxPreview(FX.ql.r); }));
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
  $('fxQLMode').hidden = true;
  body.className = 'fx-ql-body';
  body.textContent = '';
  if (!wasOpen) m.querySelector('[data-close].icon-btn').focus();
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
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('app').dataset.view === 'files' && FX.cid) fxLoad(); });
if ($('app').dataset.view === 'files') filesShow();
