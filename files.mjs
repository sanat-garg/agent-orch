// Read-only file browsing for the Files view: one chat's project folder, never anything outside it. Paths from the
// client are relative to the project; each is resolved through realpath (so symlinks count by where they point) and
// must stay inside the project's own real path. Listing gives names, sizes and dates; `raw` serves one file: images
// as themselves, everything else as plain text (capped), under a sandbox CSP so nothing served can run as a page.
//   GET /api/files/list?cid=<chat>&path=<rel>  → {name, path, crumbs, entries: [{name, dir, size, mtime, hidden}], truncated}
//   GET /api/files/raw?cid=<chat>&path=<rel>   → the file (images), or text/plain (first TEXT_MAX bytes; 415 for binary)
//   GET /api/files/find?cid=<chat>&q=<text>    → {q, entries: [{name, path, dir, size, mtime}], truncated} (q: 2+ chars)
//   GET /api/files/grep?cid=<chat>&q=<text>[&cs=1][&w=1][&re=1] → {q, hits: [{path, line, text}], files, truncated}
//       (q: 2–200 chars; text files ≤ 1 MB). cs=1 match case, w=1 whole word only, re=1 q is a JavaScript regular
//       expression (400 {error: 'Invalid regular expression: …'} when it doesn't compile or nests quantifiers).
import fs from 'node:fs';
import path from 'node:path';

export const TEXT_MAX = 1024 * 1024;
export const IMAGE_MAX = 25 * 1024 * 1024;
export const LIST_MAX = 5000;
export const FIND_VISIT_MAX = 20000;
export const GREP_TEXT = 200;
const FIND_SKIP = new Set(['.git', 'node_modules', '.agent-orch-worktrees']);
export const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const SANDBOX = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

class FileError extends Error { constructor(status, message) { super(message); this.status = status; } }

// The project's real root and the real path of `rel` inside it; throws 403/404 when it leaves the root or is missing.
export function resolveInside(rootDir, rel = '') {
  let root;
  try { root = fs.realpathSync(rootDir); } catch { throw new FileError(404, 'The project folder no longer exists'); }
  const parts = String(rel || '').split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..' || s.includes('\0'))) throw new FileError(400, 'Invalid path');
  let real;
  try { real = fs.realpathSync(path.join(root, ...parts)); } catch { throw new FileError(404, 'Not found'); }
  if (real !== root && !real.startsWith(root + path.sep)) throw new FileError(403, 'Outside the project');
  return { root, real, rel: parts.join('/') };
}

export function listDir(rootDir, rel) {
  const { root, real, rel: clean } = resolveInside(rootDir, rel);
  if (!fs.statSync(real).isDirectory()) throw new FileError(400, 'Not a folder');
  const names = fs.readdirSync(real);
  const entries = [];
  for (const name of names.slice(0, LIST_MAX)) {
    let st, target;
    try { target = fs.realpathSync(path.join(real, name)); st = fs.statSync(target); } catch { continue; } // broken link
    if (target !== root && !target.startsWith(root + path.sep)) continue; // a link out of the project
    if (!st.isDirectory() && !st.isFile()) continue; // sockets, fifos, devices
    entries.push({ name, dir: st.isDirectory(), size: st.isFile() ? st.size : null, mtime: Math.round(st.mtimeMs), hidden: name.startsWith('.') });
  }
  const crumbs = [{ name: path.basename(root), path: '' }];
  clean.split('/').filter(Boolean).forEach((s, i, a) => crumbs.push({ name: s, path: a.slice(0, i + 1).join('/') }));
  return { name: crumbs.at(-1).name, path: clean, crumbs, entries, truncated: names.length > LIST_MAX };
}

// Breadth-first walk of the project, shared by find and grep, so shallow entries come first. Skips FIND_SKIP and hidden
// folders (unless `dotted`), never descends a symlink (no loops or duplicates) and leaves out links that point outside
// the project. Yields {name, path, abs, st} for files and folders; after FIND_VISIT_MAX entries it sets state.truncated.
function* walkProject(root, dotted, state) {
  const queue = [''];
  let visited = 0;
  while (queue.length) {
    const rel = queue.shift();
    let names;
    try { names = fs.readdirSync(path.join(root, rel)).sort(); } catch { continue; }
    for (const name of names) {
      if (++visited > FIND_VISIT_MAX) { state.truncated = true; return; }
      const abs = path.join(root, rel, name), relPath = rel ? `${rel}/${name}` : name;
      let st, link = false;
      try {
        st = fs.lstatSync(abs);
        if (st.isSymbolicLink()) {
          link = true;
          const target = fs.realpathSync(abs);
          if (target !== root && !target.startsWith(root + path.sep)) continue; // a link out of the project
          st = fs.statSync(target);
        }
      } catch { continue; } // broken link, or gone mid-walk
      if (!st.isDirectory() && !st.isFile()) continue;
      if (st.isDirectory() && (FIND_SKIP.has(name) || (name.startsWith('.') && !dotted))) continue;
      yield { name, path: relPath, abs, st };
      if (st.isDirectory() && !link) queue.push(relPath);
    }
  }
}

// Project-wide find by name (case-insensitive substring) over walkProject. Stops after `max` hits or FIND_VISIT_MAX
// entries looked at (truncated: true).
export function findFiles(rootDir, q, { max = 200 } = {}) {
  const { root } = resolveInside(rootDir, '');
  const needle = String(q || '').toLowerCase(), state = { truncated: false }, entries = [];
  for (const { name, path: relPath, st } of walkProject(root, needle.startsWith('.'), state)) {
    if (!name.toLowerCase().includes(needle)) continue;
    if (entries.length >= max) { state.truncated = true; break; }
    entries.push({ name, path: relPath, dir: st.isDirectory(), size: st.isFile() ? st.size : null, mtime: Math.round(st.mtimeMs) });
  }
  return { q: String(q || ''), entries, truncated: state.truncated };
}

// Project-wide search inside files over walkProject: one hit per matching line, `line` 1-based, `text` the line trimmed
// to GREP_TEXT characters around the match. Case-insensitive substring unless opts say otherwise (see grepMatcher).
// Reads only regular files up to `fileMax` bytes and skips binary ones (a NUL in the first 8 KB). `files` counts the
// files searched. Stops after `max` hits or FIND_VISIT_MAX entries (truncated: true); yields to the event loop every 50
// files so a big project can't stall the server.
export async function grepFiles(rootDir, q, { max = 200, fileMax = 1024 * 1024, cs = false, w = false, re = false } = {}) {
  const { root } = resolveInside(rootDir, '');
  const find = grepMatcher(String(q || ''), { cs, w, re }), state = { truncated: false }, hits = [];
  let files = 0, seen = 0;
  walk: for (const { path: relPath, abs, st } of walkProject(root, !re && String(q || '').startsWith('.'), state)) {
    if (!st.isFile()) continue;
    if (++seen % 50 === 0) await new Promise((r) => setImmediate(r));
    if (st.size > fileMax) continue;
    let buf;
    try { buf = await fs.promises.readFile(abs); } catch { continue; }
    if (buf.subarray(0, 8192).includes(0)) continue; // binary
    files++;
    const text = buf.toString('utf8');
    if (find.literal != null && !(cs ? text : text.toLowerCase()).includes(find.literal)) continue; // cheap whole-file check
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, ''), [at, len] = find(line);
      if (at < 0) continue;
      if (hits.length >= max) { state.truncated = true; break walk; }
      hits.push({ path: relPath, line: i + 1, text: grepSnippet(line, at, len) });
    }
  }
  return { q: String(q || ''), hits, files, truncated: state.truncated };
}
// One matcher per search: line → [index of the first match or -1, its length]. Plain text is escaped; `w` (whole word)
// wants each end of the match to be a word boundary: \b where the match starts/ends with a word character, nothing more
// where it starts/ends with a non-word one (so `cat` misses `concat`, `(x)` still hits `concat(x)`). `re` compiles q as a JavaScript regex (flags g, plus i unless `cs`; no u), throwing a 400
// FileError when it doesn't compile or nests quantifiers like (a+)+, which can backtrack for ever. `literal` (plain text
// only) is what a file must contain, lower-cased unless `cs`.
export function grepMatcher(q, { cs = false, w = false, re = false } = {}) {
  let src = re ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (re && nestedQuantifier(q)) throw new FileError(400, 'Invalid regular expression: nested quantifiers like (a+)+ can take forever');
  if (w) src = `(?:(?<!\\w)|(?!\\w))(?:${src})(?:(?!\\w)|(?<!\\w))`;
  let rx;
  try { rx = new RegExp(src, cs ? 'g' : 'gi'); } catch (e) {
    throw new FileError(400, /^Invalid regular expression/.test(e.message) ? e.message : `Invalid regular expression: ${e.message}`);
  }
  const find = (line) => { rx.lastIndex = 0; const m = rx.exec(line); return m ? [m.index, m[0].length] : [-1, 0]; };
  find.literal = re ? null : cs ? q : q.toLowerCase();
  return find;
}
// True when a group that holds a quantifier is itself quantified: (a+)+, (\w*x)*, ((a+)b){2,}. Escapes and character
// classes are blanked first so \( or [+] don't count; groups are folded innermost first.
function nestedQuantifier(q) {
  let s = q.replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'x'), m;
  while ((m = /\(([^()]*)\)/.exec(s))) {
    const quantified = /[+*}\0]/.test(m[1]);
    if (quantified && /^[+*{]/.test(s.slice(m.index + m[0].length))) return true;
    s = s.slice(0, m.index) + (quantified ? '\0' : 'x') + s.slice(m.index + m[0].length);
  }
  return false;
}
function grepSnippet(line, at, len) {
  if (line.length <= GREP_TEXT) return line.trim();
  const start = Math.max(0, Math.min(at - Math.floor((GREP_TEXT - len) / 2), line.length - GREP_TEXT));
  return line.slice(start, start + GREP_TEXT).trim();
}

// Serves one file. Images (by extension) as their type; anything else as UTF-8 text, first TEXT_MAX bytes, or 415 when
// the start of it looks binary (a NUL byte).
export function sendFile(req, res, rootDir, rel) {
  const { real } = resolveInside(rootDir, rel);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new FileError(400, 'Not a file');
  const lastModified = new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString();
  const common = { 'Content-Security-Policy': SANDBOX, 'Cache-Control': 'private, no-cache', 'Last-Modified': lastModified,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(real))}` };
  if (req.headers['if-modified-since'] === lastModified) { res.writeHead(304, common); return res.end(); }
  const image = IMAGE_TYPES[path.extname(real).toLowerCase()];
  if (image) {
    if (st.size > IMAGE_MAX) throw new FileError(413, 'Image is too large to preview');
    res.writeHead(200, { ...common, 'Content-Type': image, 'Content-Length': st.size });
    return fs.createReadStream(real).pipe(res);
  }
  const fd = fs.openSync(real, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, TEXT_MAX));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.subarray(0, Math.min(n, 8192)).includes(0)) throw new FileError(415, 'Binary file');
    res.writeHead(200, { ...common, 'Content-Type': 'text/plain; charset=utf-8', 'X-File-Size': String(st.size), ...(st.size > n ? { 'X-Truncated': '1' } : {}) });
    return res.end(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
}

// The route handler: rootFor(cid) → the chat's project folder, or null. Returns true (synchronously) when it answers;
// grep answers later, from its own promise.
export function handleFiles(req, res, url, { rootFor, json }) {
  const m = url.pathname.match(/^\/api\/files\/(list|raw|find|grep)$/);
  if (!m || req.method !== 'GET') return false;
  const root = rootFor(url.searchParams.get('cid'));
  const fail = (e) => {
    if (res.headersSent) return res.destroy();
    json(res, e.status || (e.code === 'EACCES' ? 403 : 500), { error: e.status ? e.message : e.code === 'EACCES' ? 'Permission denied' : 'Could not read it' });
  };
  try {
    if (!root) throw new FileError(404, 'No project for this chat');
    if (m[1] === 'list') json(res, 200, listDir(root, url.searchParams.get('path')));
    else if (m[1] === 'find' || m[1] === 'grep') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) throw new FileError(400, 'Type at least 2 characters');
      if (m[1] === 'find') json(res, 200, findFiles(root, q));
      else if (q.length > 200) throw new FileError(400, 'Search for 200 characters at most');
      else {
        const flag = (k) => url.searchParams.get(k) === '1';
        grepFiles(root, q, { cs: flag('cs'), w: flag('w'), re: flag('re') }).then((r) => json(res, 200, r), fail);
      }
    }
    else sendFile(req, res, root, url.searchParams.get('path'));
  } catch (e) { fail(e); }
  return true;
}
