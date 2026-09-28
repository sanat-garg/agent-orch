// Read-only file browsing for the Files view: one chat's project folder, never anything outside it. Paths from the
// client are relative to the project; each is resolved through realpath (so symlinks count by where they point) and
// must stay inside the project's own real path. Listing gives names, sizes and dates; `raw` serves one file: images
// as themselves, everything else as plain text (capped), under a sandbox CSP so nothing served can run as a page.
//   GET /api/files/list?cid=<chat>&path=<rel>  → {name, path, crumbs, entries: [{name, dir, size, mtime, hidden}], truncated}
//   GET /api/files/raw?cid=<chat>&path=<rel>   → the file (images), or text/plain (first TEXT_MAX bytes; 415 for binary)
//   GET /api/files/find?cid=<chat>&q=<text>    → {q, entries: [{name, path, dir, size, mtime}], truncated} (q: 2+ chars)
//   GET /api/files/grep?cid=<chat>&q=<text>    → {q, hits: [{path, line, text}], files, truncated} (q: 2–200 chars; text files ≤ 1 MB)
//   GET /api/files/changed?cid=<chat>          → {branch, entries: [{path, status, add, del, binary, from?}], truncated}, status
//       M/A/D/R/? against HEAD (R: path is the new name, from the old); {branch: null, entries: [], notGit: true} outside git
//   GET /api/files/diff?cid=<chat>&path=<rel>  → text/plain unified diff of one changed file against HEAD (first DIFF_MAX bytes)
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

export const TEXT_MAX = 1024 * 1024;
export const IMAGE_MAX = 25 * 1024 * 1024;
export const LIST_MAX = 5000;
export const FIND_VISIT_MAX = 20000;
export const GREP_TEXT = 200;
export const CHANGED_MAX = 2000;
export const DIFF_MAX = 200 * 1024;
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

// Project-wide search inside files (case-insensitive substring) over walkProject: one hit per matching line, `line`
// 1-based, `text` the line trimmed to GREP_TEXT characters around the match. Reads only regular files up to `fileMax`
// bytes and skips binary ones (a NUL in the first 8 KB). `files` counts the files searched. Stops after `max` hits or
// FIND_VISIT_MAX entries (truncated: true); yields to the event loop every 50 files so a big project can't stall the server.
export async function grepFiles(rootDir, q, { max = 200, fileMax = 1024 * 1024 } = {}) {
  const { root } = resolveInside(rootDir, '');
  const needle = String(q || '').toLowerCase(), state = { truncated: false }, hits = [];
  let files = 0, seen = 0;
  walk: for (const { path: relPath, abs, st } of walkProject(root, needle.startsWith('.'), state)) {
    if (!st.isFile()) continue;
    if (++seen % 50 === 0) await new Promise((r) => setImmediate(r));
    if (st.size > fileMax) continue;
    let buf;
    try { buf = await fs.promises.readFile(abs); } catch { continue; }
    if (buf.subarray(0, 8192).includes(0)) continue; // binary
    files++;
    const text = buf.toString('utf8'), lower = text.toLowerCase();
    if (!lower.includes(needle)) continue;
    const lines = text.split('\n'), lowers = lower.split('\n');
    for (let i = 0; i < lowers.length; i++) {
      const at = lowers[i].indexOf(needle);
      if (at < 0) continue;
      if (hits.length >= max) { state.truncated = true; break walk; }
      hits.push({ path: relPath, line: i + 1, text: grepSnippet(lines[i].replace(/\r$/, ''), at, needle.length) });
    }
  }
  return { q: String(q || ''), hits, files, truncated: state.truncated };
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

// git in the project's folder, never through a shell. Paths are pathspec-literal, and git takes no optional locks, so
// looking never fights the orchestrator's own git work on the same checkout. Exit codes in `ok` still resolve; a buffer
// output past maxBuffer resolves to what was read, flagged `overflow`.
const execFileP = promisify(execFile);
function git(root, args, { encoding = 'utf8', ok = [0] } = {}) {
  return execFileP('git', ['-C', root, '--literal-pathspecs', ...args],
    { encoding, timeout: 20000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
    .then((r) => r.stdout, (e) => {
      if (ok.includes(e.code)) return e.stdout;
      if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && encoding === 'buffer') return Object.assign(e.stdout, { overflow: true });
      throw e;
    });
}
const skipped = (rel) => rel.split('/').some((s) => FIND_SKIP.has(s));
function statusOf(xy) {
  if (xy === '??') return '?';
  if (xy.includes('R')) return 'R';
  if (xy[0] === 'A' || xy[0] === 'C') return 'A';
  return xy.includes('D') ? 'D' : 'M';
}

// Files that differ from HEAD in the project (relative to its root, even when that is a subfolder of the repo), sorted
// by path, at most `max`. add/del come from `git diff --numstat` (untracked: the line count); binary files have 0/0.
// Entries under FIND_SKIP folders or whose path leaves the project (a link out) are left out.
export async function changedFiles(rootDir, { max = CHANGED_MAX } = {}) {
  const { root } = resolveInside(rootDir, '');
  let prefix;
  try { await git(root, ['rev-parse', '--show-toplevel']); prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim(); }
  catch { return { branch: null, entries: [], notGit: true }; }
  const [status, numstat, branch] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
    git(root, ['diff', '--numstat', '-z', '--no-ext-diff', '--relative', 'HEAD', '--']).catch(() => ''), // no commits yet
    git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => git(root, ['rev-parse', '--short', 'HEAD'])).then((b) => b.trim() || null, () => null),
  ]);
  const counts = new Map(), nf = numstat.split('\0');
  for (let i = 0; i < nf.length - 1; i++) {
    const [add, del, p] = nf[i].split('\t');
    const at = p === '' ? nf[i += 2] : p; // a rename: add\tdel\t\0old\0new
    counts.set(at, add === '-' ? { add: 0, del: 0, binary: true } : { add: +add, del: +del, binary: false });
  }
  const strip = (p) => (p.startsWith(prefix) ? p.slice(prefix.length) : null);
  const entries = [], sf = status.split('\0');
  for (let i = 0; i < sf.length - 1; i++) {
    const xy = sf[i].slice(0, 2), rel = strip(sf[i].slice(3));
    const from = xy.includes('R') || xy.includes('C') ? strip(sf[++i]) : null;
    if (!rel || skipped(rel)) continue;
    const st = statusOf(xy);
    if (st !== 'D') try { resolveInside(root, rel); } catch { continue; }
    entries.push({ path: rel, status: st, add: 0, del: 0, binary: false, ...(st === 'R' && from ? { from } : {}), ...counts.get(rel) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const kept = entries.slice(0, max);
  for (const e of kept) {
    if (e.status !== '?') continue;
    try {
      const { real } = resolveInside(root, e.path);
      if ((await fs.promises.stat(real)).size > 16 * 1024 * 1024) continue;
      const buf = await fs.promises.readFile(real);
      if (buf.subarray(0, 8192).includes(0)) e.binary = true;
      else e.add = buf.length ? buf.toString('utf8').split('\n').length - (buf.at(-1) === 10 ? 1 : 0) : 0;
    } catch { /* gone, or too big to read */ }
  }
  return { branch, entries: kept, truncated: entries.length > max };
}

// One changed file's unified diff against HEAD (an untracked file: against /dev/null), under the same sandbox CSP as
// sendFile. 404 unless `rel` is in changedFiles; X-Truncated: 1 past DIFF_MAX bytes.
export async function sendDiff(req, res, rootDir, rel) {
  const clean = String(rel || '').split('/').filter((s) => s && s !== '.').join('/');
  const { root } = resolveInside(rootDir, '');
  const changed = await changedFiles(root, { max: Infinity });
  const entry = changed.entries.find((e) => e.path === clean);
  if (!entry) throw new FileError(404, changed.notGit ? 'Not a git repository' : 'No changes in this file');
  const opts = ['--no-color', '--no-ext-diff'];
  const out = entry.status === '?'
    ? await git(root, ['diff', '--no-index', ...opts, '--', '/dev/null', clean], { encoding: 'buffer', ok: [1] })
    : await git(root, ['diff', ...opts, '--relative', 'HEAD', '--', ...(entry.from ? [entry.from] : []), clean], { encoding: 'buffer' });
  if (!out.length) throw new FileError(404, 'No changes in this file');
  const cut = out.length > DIFF_MAX || out.overflow;
  res.writeHead(200, { 'Content-Security-Policy': SANDBOX, 'Cache-Control': 'private, no-cache', 'Content-Type': 'text/plain; charset=utf-8',
    ...(cut ? { 'X-Truncated': '1' } : {}) });
  res.end(out.subarray(0, DIFF_MAX));
}

// The route handler: rootFor(cid) → the chat's project folder, or null. Returns true (synchronously) when it answers;
// grep, changed and diff answer later, from their own promises.
export function handleFiles(req, res, url, { rootFor, json }) {
  const m = url.pathname.match(/^\/api\/files\/(list|raw|find|grep|changed|diff)$/);
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
      else grepFiles(root, q).then((r) => json(res, 200, r), fail);
    }
    else if (m[1] === 'changed') changedFiles(root).then((r) => json(res, 200, r), fail);
    else if (m[1] === 'diff') sendDiff(req, res, root, url.searchParams.get('path')).catch(fail);
    else sendFile(req, res, root, url.searchParams.get('path'));
  } catch (e) { fail(e); }
  return true;
}
