// File browsing (and the context menu's copy/move/zip/unzip) for the Files view: the whole disk, opening on one chat's
// project folder. A path from the client is ABSOLUTE ('/home/ubuntu/x': anywhere, as the server's user) or relative to
// the project (then it must stay inside the project's own real path, links out of it are 403 and left out of listings).
// Either is resolved through realpath (symlinks count by where they point). Guardrails: PROTECTED secrets are listed
// but never served, searched, copied, zipped or moved (403), and every write (copy/move/zip/unzip) lands only under
// the project, the home dir or /tmp (writeRoots; elsewhere 403 'Read-only location'). `raw` serves one file: images as
// themselves, everything else as plain text (capped), under a sandbox CSP so nothing served can run as a page.
//   GET /api/files/list?cid=<chat>&dir=<abs|rel> → {dir, parent (null at '/'), entries: [{name, path, type, size, mtime,
//       isSymlink, readable, writable, protected, dir, hidden}], places: [{label, path}], truncated, name, path, crumbs}
//       (`path=` works as well as `dir=`; dir/parent/entry paths are absolute real paths; the top-level `path` and crumbs
//       are project-relative for a relative request, absolute otherwise; type is 'dir' or 'file', of what a link points to;
//       at most LIST_MAX entries; an entry it can't stat is kept with readable: false)
//   GET /api/files/raw?cid=<chat>&path=<abs|rel> → the file (images), or text/plain (first TEXT_MAX bytes; 415 for binary)
//   GET /api/files/find?cid=<chat>&q=<text>[&dir=] → {q, entries: [{name, path, dir, size, mtime}], truncated} (q: 2+ chars)
//   GET /api/files/grep?cid=<chat>&q=<text>[&dir=] → {q, hits: [{path, line, text}], files, truncated} (q: 2–200 chars; text files ≤ 1 MB)
//       (find/grep search under dir, default the project; paths are absolute when dir is, else project-relative)
//   GET /api/files/changed?cid=<chat>          → {branch, entries: [{path, status, add, del, binary, from?}], truncated}, status
//       M/A/D/R/? against HEAD (R: path is the new name, from the old); {branch: null, entries: [], notGit: true} outside git
//   GET /api/files/diff?cid=<chat>&path=<rel>  → text/plain unified diff of one changed file against HEAD (first DIFF_MAX bytes)
//   POST /api/files/copy  {cid, paths, dest}        → {created: [rel]}   (any path may be absolute; then results are too)
//   POST /api/files/move  {cid, paths, dest}        → {moved: [{from, to}]}
//   POST /api/files/zip   {cid, paths, dest?, name?} → {zip: rel}
//   POST /api/files/unzip {cid, path, dest?}        → {extracted: rel, skipped}
//   (the rules for these four are above copyPaths; errors are {error} with 400/403/404/409/413)
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

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
const within = (p, dir) => p === dir || p.startsWith(dir === '/' ? '/' : dir + path.sep);
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const denied = (e) => (e.code === 'EACCES' || e.code === 'EPERM' ? new FileError(403, 'Permission denied') : new FileError(404, 'Not found'));

// Secrets: listed (protected: true) but never previewed, downloaded, searched, copied, zipped or moved. {data} is the
// agent-orch data dir (CW_DATA_DIR, as in server.mjs), ~ the home dir; ** crosses folders, * doesn't. A path counts
// when it or its realpath matches. The literal folder before a pattern's first * (data dir, ~/.ssh…) is never moved
// or written into, nor is any folder holding one.
export const PROTECTED = ['{data}/**/auth.json', '{data}/**/secrets*', '{data}/**/sessions*', '{data}/**/*.db', '{data}/**/*.db-*',
  '{data}/**/push-vapid.json', '~/.ssh', '~/.ssh/**', '~/.claude/.credentials.json', '~/.claude.json', '~/.codex/auth.json',
  '~/.config/gh/hosts.yml', '~/.git-credentials', '**/*.pem', '**/*.key'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const globRe = (g) => g.split(/(\*\*\/|\*\*|\*)/).map((p) => (p === '**/' ? '(?:.*/)?' : p === '**' ? '.*' : p === '*' ? '[^/]*' : esc(p))).join('');
let rules = { key: null };
function protectRules() {
  const home = os.homedir(), data = process.env.CW_DATA_DIR ? path.resolve(process.env.CW_DATA_DIR) : path.join(HERE, 'data');
  const bases = { '{data}': [...new Set([data, realOr(data) || data])], '~': [...new Set([home, realOr(home) || home])], '': [''] };
  const key = JSON.stringify(bases);
  if (rules.key === key) return rules;
  rules = { key, res: [], anchors: [] };
  for (const g of PROTECTED) {
    const pre = g.startsWith('{data}') ? '{data}' : g.startsWith('~') ? '~' : '', rest = g.slice(pre.length), star = rest.indexOf('*');
    for (const base of bases[pre]) {
      rules.res.push(new RegExp(`^${esc(base)}${globRe(rest)}$`, 'i'));
      if (pre) rules.anchors.push(base + (star < 0 ? rest : rest.slice(0, rest.lastIndexOf('/', star))));
    }
  }
  return rules;
}
export const isSecret = (...paths) => paths.some((p) => p && protectRules().res.some((r) => r.test(p)));
// A folder a secret's fixed location sits in (or is): never moved, never written into.
const holdsSecret = (real) => protectRules().anchors.some((a) => within(a, real) || within(real, a));

// Where writes may land: the project, the home dir and /tmp (os.tmpdir() too), by real path.
export function writeRoots(root) {
  return [...new Set([root, os.homedir(), '/tmp', os.tmpdir()].filter(Boolean).map(realOr).filter(Boolean))];
}
function assertWritable(root, real) {
  if (!writeRoots(root).some((r) => within(real, r))) throw new FileError(403, 'Read-only location');
}

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

// A client path: absolute → anywhere (realpath; `at` is the path as asked), else resolveInside the project. root: the
// project's real path (null if it's gone and the path is absolute).
export function resolvePath(rootDir, p = '') {
  const s = String(p ?? '');
  if (!s.startsWith('/')) { const r = resolveInside(rootDir, s); return { ...r, at: path.join(r.root, r.rel), abs: false }; }
  if (s.includes('\0')) throw new FileError(400, 'Invalid path');
  const at = path.resolve(s);
  let real;
  try { real = fs.realpathSync(at); } catch (e) { throw denied(e); }
  return { root: realOr(rootDir), real, rel: real, at, abs: true };
}

export function listDir(rootDir, p) {
  const { root, real, rel, abs } = resolvePath(rootDir, p);
  if (!fs.statSync(real).isDirectory()) throw new FileError(400, 'Not a folder');
  const names = [];
  let truncated = false;
  const d = fs.opendirSync(real); // read only up to the cap, however big the folder
  try { for (let e; (e = d.readSync());) { if (names.length >= LIST_MAX) { truncated = true; break; } names.push(e.name); } }
  finally { d.closeSync(); }
  const roots = writeRoots(root), can = (p, mode) => { try { fs.accessSync(p, mode); return true; } catch { return false; } };
  const entries = [];
  for (const name of names) {
    const at = path.join(real, name);
    let lst, st, target;
    try { lst = fs.lstatSync(at); } catch { // a folder we may list but not search
      entries.push({ name, path: at, dir: false, type: 'file', size: null, mtime: null, hidden: name.startsWith('.'), isSymlink: false,
        readable: false, writable: false, protected: isSecret(at) });
      continue;
    }
    const link = lst.isSymbolicLink();
    try { target = link ? fs.realpathSync(at) : at; st = link ? fs.statSync(target) : lst; } catch { continue; } // broken link
    if (!abs && !within(target, root)) continue; // a link out of the project
    if (!st.isDirectory() && !st.isFile()) continue; // sockets, fifos, devices
    const isDir = st.isDirectory(), secret = isSecret(at, target);
    entries.push({ name, path: at, dir: isDir, type: isDir ? 'dir' : 'file', size: st.isFile() ? st.size : null, mtime: Math.round(st.mtimeMs),
      hidden: name.startsWith('.'), isSymlink: link, readable: can(target, isDir ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK),
      writable: !secret && roots.some((r) => within(target, r)) && can(target, fs.constants.W_OK), protected: secret });
  }
  const crumbs = abs ? [{ name: '/', path: '/' }] : [{ name: path.basename(root), path: '' }];
  const segs = rel.split('/').filter(Boolean);
  segs.forEach((s, i) => crumbs.push({ name: s, path: (abs ? '/' : '') + segs.slice(0, i + 1).join('/') }));
  const places = [{ label: 'Project', path: root || path.resolve(rootDir) }, { label: 'Home', path: os.homedir() }, { label: '/', path: '/' }, { label: '/tmp', path: '/tmp' }];
  return { dir: real, parent: real === '/' ? null : path.dirname(real), entries, places, truncated, name: crumbs.at(-1).name, path: rel, crumbs };
}

// Breadth-first walk of a folder (the project, or find/grep's dir), shared by find and grep, so shallow entries come
// first. Skips FIND_SKIP and hidden folders (unless `dotted`), never descends a symlink (no loops or duplicates) and
// leaves out links that point outside that folder. Yields {name, path (relative to root), abs, real, st} for files and
// folders; after FIND_VISIT_MAX entries it sets state.truncated.
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
      let st, link = false, real = abs;
      try {
        st = fs.lstatSync(abs);
        if (st.isSymbolicLink()) {
          link = true;
          real = fs.realpathSync(abs);
          if (!within(real, root)) continue; // a link out of the folder
          st = fs.statSync(real);
        }
      } catch { continue; } // broken link, or gone mid-walk
      if (!st.isDirectory() && !st.isFile()) continue;
      if (st.isDirectory() && (FIND_SKIP.has(name) || (name.startsWith('.') && !dotted))) continue;
      yield { name, path: relPath, abs, real, st };
      if (st.isDirectory() && !link) queue.push(relPath);
    }
  }
}

// Where find/grep look: `dir` (default the project) and how a found path is shown: absolute when dir is, else
// relative to the project.
function searchBase(rootDir, dir) {
  const { root, real, abs } = resolvePath(rootDir, dir || '');
  if (!fs.statSync(real).isDirectory()) throw new FileError(400, 'Not a folder');
  return { base: real, show: (rel) => (abs ? path.join(real, rel) : relOf(root, path.join(real, rel))) };
}

// Find by name (case-insensitive substring) over walkProject. Stops after `max` hits or FIND_VISIT_MAX
// entries looked at (truncated: true).
export function findFiles(rootDir, q, { max = 200, dir } = {}) {
  const { base, show } = searchBase(rootDir, dir);
  const needle = String(q || '').toLowerCase(), state = { truncated: false }, entries = [];
  for (const { name, path: relPath, st } of walkProject(base, needle.startsWith('.'), state)) {
    if (!name.toLowerCase().includes(needle)) continue;
    if (entries.length >= max) { state.truncated = true; break; }
    entries.push({ name, path: show(relPath), dir: st.isDirectory(), size: st.isFile() ? st.size : null, mtime: Math.round(st.mtimeMs) });
  }
  return { q: String(q || ''), entries, truncated: state.truncated };
}

// Search inside files (case-insensitive substring) over walkProject: one hit per matching line, `line`
// 1-based, `text` the line trimmed to GREP_TEXT characters around the match. Reads only regular files up to `fileMax`
// bytes and skips binary and PROTECTED ones (a NUL in the first 8 KB). `files` counts the files searched. Stops after `max` hits or
// FIND_VISIT_MAX entries (truncated: true); yields to the event loop every 50 files so a big project can't stall the server.
export async function grepFiles(rootDir, q, { max = 200, fileMax = 1024 * 1024, dir } = {}) {
  const { base, show } = searchBase(rootDir, dir);
  const needle = String(q || '').toLowerCase(), state = { truncated: false }, hits = [];
  let files = 0, seen = 0;
  walk: for (const { path: relPath, abs, real, st } of walkProject(base, needle.startsWith('.'), state)) {
    if (!st.isFile() || isSecret(abs, real)) continue;
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
      hits.push({ path: show(relPath), line: i + 1, text: grepSnippet(lines[i].replace(/\r$/, ''), at, needle.length) });
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
  const { real, at } = resolvePath(rootDir, rel);
  if (isSecret(at, real)) throw new FileError(403, 'This file is protected');
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
  if (isSecret(path.join(root, clean))) throw new FileError(403, 'This file is protected');
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

// ── Changing files: copy, move, zip, unzip ──────────────────────────────────────────────────────────────────────────
// Every path is resolved like resolvePath (realpath; a relative one inside the project). A source is the entry itself,
// not what a link points to: moving or copying a link moves or copies the link (a relative one must still point inside
// the project), and a folder's contents are copied with their links as they are. The project root and '/' are never a
// source; a PROTECTED one is refused (403), and a copied or zipped folder leaves its secrets out. Writes land only in
// writeRoots (a move's source too), by real path, so a link never carries one elsewhere: else 403 'Read-only location'.
// In the project, data/ (at the top) and anything under a .git/ are read-only: never a destination, never moved, and
// no new item may land there; reading them (copy out, zip) is fine. A clash with an existing name gets 'name copy', 'name copy 2'… (copy, move) or
// 'name 2', 'name 3'… (zip, unzip). Zips are written and read in plain node (zlib, no zip/unzip binaries, no zip64):
// the same code on the head and on macOS workers, and every archive entry is checked before anything is written.
export const OPS_ENTRY_MAX = 20000;
export const ZIP_INPUT_MAX = 2 * 1024 ** 3;
export const UNZIP_MAX = 500 * 1024 ** 2;

const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
// Project-relative path of `abs`, or null outside the project.
const projRel = (root, abs) => (root && within(abs, root) ? relOf(root, abs) : null);
const isProtected = (rel) => { if (rel == null) return false; const s = rel.split('/'); return s[0] === 'data' || s.includes('.git'); };
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
// How results name paths: absolute when the request used any absolute path, else project-relative.
const shower = (root, inputs) => (inputs.flat().some((p) => typeof p === 'string' && p.startsWith('/')) ? (a) => a : (a) => relOf(root, a));

// One source the client named: {root, abs (the entry, in its real parent folder), real, rel, name, dir, link}.
function sourceOf(rootDir, p) {
  const s = String(p ?? '');
  let parentPath, name;
  if (s.startsWith('/')) {
    const at = path.resolve(s);
    if (at === '/') throw new FileError(400, 'Pick a file or folder, not /');
    [parentPath, name] = [path.dirname(at), path.basename(at)];
  } else {
    const parts = s.split('/').filter((x) => x && x !== '.');
    if (parts.some((x) => x === '..' || x.includes('\0'))) throw new FileError(400, 'Invalid path');
    if (!parts.length) throw new FileError(400, 'Pick a file or folder, not the project itself');
    [parentPath, name] = [parts.slice(0, -1).join('/'), parts.at(-1)];
  }
  const { root, real: parent } = resolvePath(rootDir, parentPath);
  const abs = path.join(parent, name), shown = projRel(root, abs) ?? abs;
  let lst, real;
  try { lst = fs.lstatSync(abs); real = fs.realpathSync(abs); } catch (e) { throw e.code === 'EACCES' ? denied(e) : new FileError(404, `Not found: ${shown}`); }
  if (!s.startsWith('/')) resolveInside(root, relOf(root, abs)); // a link out of the project
  if (isSecret(abs, real)) throw new FileError(403, `${shown} is protected`);
  return { root, abs, real, rel: projRel(root, abs), name, dir: fs.statSync(real).isDirectory(), link: lst.isSymbolicLink(), shown };
}
// The selection: distinct sources, leaving out any inside another selected folder (it comes along with it).
function sourcesOf(rootDir, paths) {
  if (!Array.isArray(paths) || !paths.length) throw new FileError(400, 'Pick at least one file or folder');
  if (paths.length > OPS_ENTRY_MAX) throw new FileError(413, 'Too many items');
  const all = [...new Map(paths.map((p) => sourceOf(rootDir, p)).map((s) => [s.abs, s])).values()];
  return all.filter((s) => !all.some((o) => o !== s && o.dir && !o.link && s.abs.startsWith(o.abs + path.sep)));
}
function destOf(rootDir, p) {
  if (typeof p !== 'string') throw new FileError(400, 'Pick a destination folder');
  const d = resolvePath(rootDir, p);
  if (!fs.statSync(d.real).isDirectory()) throw new FileError(400, 'The destination is not a folder');
  assertWritable(d.root, d.real);
  const rel = projRel(d.root, d.real);
  if (isProtected(rel) || isSecret(d.real) || protectRules().anchors.some((a) => within(d.real, a))) throw new FileError(403, `${rel ?? d.real} is read-only`);
  return { root: d.root, real: d.real, rel };
}
// A free name in `dir` for `name`; style 'copy' → 'a copy.txt', 'a copy 2.txt'; 'number' → 'a 2.zip', 'a 3.zip'.
function freeName(root, dir, name, { isDir = false, style = 'copy' } = {}) {
  const ext = isDir ? '' : path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n <= 1000; n++) {
    const cand = n === 1 ? name : style === 'copy' ? `${stem} copy${n === 2 ? '' : ` ${n - 1}`}${ext}` : `${stem} ${n}${ext}`;
    const at = path.join(dir, cand);
    if (lexists(at)) continue;
    if (isProtected(projRel(root, at)) || isSecret(at)) throw new FileError(403, `${projRel(root, at) ?? at} is read-only`);
    return at;
  }
  throw new FileError(409, `Too many items named like ${name}`);
}
function intoItself(s, dest, verb) {
  if (s.dir && !s.link && within(dest.real, s.real)) throw new FileError(400, `Can't ${verb} ${s.shown} into itself`);
}

// POST /api/files/copy {paths, dest} → {created: [rel]}
export async function copyPaths(rootDir, paths, destRel) {
  const dest = destOf(rootDir, destRel), srcs = sourcesOf(rootDir, paths), show = shower(dest.root, [paths, destRel]);
  for (const s of srcs) intoItself(s, dest, 'copy');
  const created = [];
  for (const s of srcs) {
    const to = freeName(dest.root, dest.real, s.name, { isDir: s.dir && !s.link });
    await fs.promises.cp(s.abs, to, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true, preserveTimestamps: true,
      filter: (from) => !isSecret(from) });
    created.push(show(to));
  }
  return { created };
}

// POST /api/files/move {paths, dest} → {moved: [{from, to}]}; an item already in dest stays put (from === to).
export async function movePaths(rootDir, paths, destRel) {
  const dest = destOf(rootDir, destRel), srcs = sourcesOf(rootDir, paths), show = shower(dest.root, [paths, destRel]);
  for (const s of srcs) {
    assertWritable(s.root, path.dirname(s.abs));
    if (isProtected(s.rel) || (!s.link && holdsSecret(s.real))) throw new FileError(403, `${s.shown} is read-only`);
    intoItself(s, dest, 'move');
  }
  const moved = [];
  for (const s of srcs) {
    if (path.dirname(s.abs) === dest.real) { moved.push({ from: show(s.abs), to: show(s.abs) }); continue; }
    const to = freeName(dest.root, dest.real, s.name, { isDir: s.dir && !s.link });
    try { await fs.promises.rename(s.abs, to); }
    catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fs.promises.cp(s.abs, to, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true, preserveTimestamps: true });
      await fs.promises.rm(s.abs, { recursive: true });
    }
    moved.push({ from: show(s.abs), to: show(to) });
  }
  return { moved };
}

// A name the client typed for a new item: one plain path component.
function plainName(name) {
  const n = String(name).trim();
  if (!n || n === '.' || n === '..' || /[/\\\0]/.test(n)) throw new FileError(400, 'Invalid name');
  return n;
}

// POST /api/files/zip {paths, dest?, name?} → {zip: rel}. Each selected item sits at the top of the archive under its
// own name; folders go in whole (their links are left out: a zip never follows one). dest defaults to the selection's
// common parent folder, the name to '<item>.zip' for one item or 'Archive.zip' for several.
export async function zipPaths(rootDir, paths, { dest: destRel, name } = {}) {
  const srcs = sourcesOf(rootDir, paths);
  const { root } = srcs[0], show = shower(root, [paths, destRel ?? '']);
  let common = path.dirname(srcs[0].abs);
  for (const s of srcs) while (!within(path.dirname(s.abs), common)) common = path.dirname(common);
  const dest = destOf(rootDir, destRel ?? common);
  const seen = new Set();
  for (const s of srcs) {
    if (seen.has(s.name)) throw new FileError(409, `Two selected items are both named ${s.name}`);
    seen.add(s.name);
  }
  let file = name == null || name === '' ? (srcs.length === 1 ? `${srcs[0].name}.zip` : 'Archive.zip') : plainName(name);
  if (!/\.zip$/i.test(file)) file += '.zip';
  const entries = [];
  let bytes = 0;
  const add = (e) => {
    if (entries.push(e) > OPS_ENTRY_MAX) throw new FileError(413, `More than ${OPS_ENTRY_MAX} items to zip`);
    if ((bytes += e.size || 0) > ZIP_INPUT_MAX) throw new FileError(413, 'Too much to zip (2 GB at most)');
  };
  for (const s of srcs) {
    const st = fs.statSync(s.real);
    if (!st.isDirectory()) { add({ name: s.name, abs: s.real, size: st.size, st }); continue; }
    add({ name: `${s.name}/`, dir: true, st });
    const walk = (abs, prefix) => {
      for (const n of fs.readdirSync(abs).sort()) {
        const p = path.join(abs, n), l = fs.lstatSync(p);
        if (isSecret(p)) continue;
        if (l.isDirectory()) { add({ name: `${prefix}${n}/`, dir: true, st: l }); walk(p, `${prefix}${n}/`); }
        else if (l.isFile()) add({ name: `${prefix}${n}`, abs: p, size: l.size, st: l });
      }
    };
    walk(s.real, `${s.name}/`);
  }
  const partial = path.join(dest.real, `.${file}.${process.pid}-${Date.now()}.partial`);
  try {
    await writeZip(partial, entries);
    const to = freeName(root, dest.real, file, { style: 'number' });
    await fs.promises.rename(partial, to);
    return { zip: show(to) };
  } catch (e) { await fs.promises.rm(partial, { force: true }); throw e; }
}

function dosTime(ms) {
  const d = new Date(ms), y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
async function writeZip(file, entries) {
  const fh = await fs.promises.open(file, 'wx');
  let pos = 0;
  const central = [];
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8'), offset = pos, method = e.dir ? 0 : 8;
      let crc = 0, size = 0, csize = 0;
      pos += 30 + name.length;
      if (!e.dir) {
        await pipeline(fs.createReadStream(e.abs), new Transform({ transform(c, _, cb) { crc = zlib.crc32(c, crc); size += c.length; cb(null, c); } }),
          zlib.createDeflateRaw(), async (chunks) => {
            for await (const c of chunks) { await fh.write(c, 0, c.length, pos); pos += c.length; csize += c.length; }
          });
      }
      if (pos > 0xfffffff0) throw new FileError(413, 'The zip would be too large (4 GB at most)');
      const { time, date } = dosTime(e.st.mtimeMs);
      const mode = e.dir ? 0o40755 : 0o100000 | (e.st.mode & 0o111 ? 0o755 : 0o644);
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(method, 8);
      h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(csize, 18);
      h.writeUInt32LE(size, 22); h.writeUInt16LE(name.length, 26);
      await fh.write(Buffer.concat([h, name]), 0, 30 + name.length, offset);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); h.copy(c, 6, 4, 30); // version needed … name length
      c.writeUInt32LE(((mode << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38); c.writeUInt32LE(offset, 42);
      central.push(c, name);
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(pos, 16);
    const all = Buffer.concat([cd, end]);
    await fh.write(all, 0, all.length, pos);
  } finally { await fh.close(); }
}

// The archive's entries from its central directory, all checked before anything is written: no absolute, drive or '..'
// paths (zip-slip), no encryption or zip64, only stored/deflated data, at most OPS_ENTRY_MAX entries and UNZIP_MAX bytes
// uncompressed. Symlink entries and anything under a .git/ are skipped (counted in `skipped`).
async function readZip(fh, fileSize) {
  const bad = (m) => new FileError(400, m);
  const tailLen = Math.min(fileSize, 22 + 0xffff), tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, fileSize - tailLen);
  let at = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { at = i; break; }
  if (at < 0) throw bad('Not a zip file');
  const count = tail.readUInt16LE(at + 10), cdSize = tail.readUInt32LE(at + 12), cdOff = tail.readUInt32LE(at + 16);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw bad('Zip64 archives are not supported');
  if (count > OPS_ENTRY_MAX) throw new FileError(413, `The zip has more than ${OPS_ENTRY_MAX} entries`);
  if (cdOff + cdSize > fileSize) throw bad('The zip is damaged');
  if (cdSize > 64 * 1024 ** 2) throw new FileError(413, 'The zip\'s file list is too large');
  const cd = Buffer.alloc(cdSize);
  await fh.read(cd, 0, cdSize, cdOff);
  const entries = [];
  let p = 0, total = 0, skipped = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdSize || cd.readUInt32LE(p) !== 0x02014b50) throw bad('The zip is damaged');
    const host = cd.readUInt16LE(p + 4) >> 8, flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
    const time = cd.readUInt16LE(p + 12), date = cd.readUInt16LE(p + 14), crc = cd.readUInt32LE(p + 16);
    const csize = cd.readUInt32LE(p + 20), size = cd.readUInt32LE(p + 24), nlen = cd.readUInt16LE(p + 28);
    const xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32), attr = cd.readUInt32LE(p + 38), offset = cd.readUInt32LE(p + 42);
    const raw = cd.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nlen + xlen + clen;
    const name = raw.replace(/\\/g, '/'), mode = host === 3 ? attr >>> 16 : 0;
    if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.includes('\0')) throw bad(`Unsafe path in the zip: ${raw}`);
    const parts = name.split('/').filter((s) => s && s !== '.');
    if (parts.includes('..')) throw bad(`Unsafe path in the zip: ${raw}`);
    if ((mode & 0o170000) === 0o120000 || parts.includes('.git')) { skipped++; continue; }
    if (!parts.length) continue;
    const dir = name.endsWith('/') || (mode & 0o170000) === 0o040000 || (!mode && attr & 0x10);
    if (flags & 1) throw bad('Encrypted zips are not supported');
    if (csize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw bad('Zip64 archives are not supported');
    if (!dir && method !== 0 && method !== 8) throw bad(`Unsupported compression in ${raw}`);
    if (!dir && (total += size) > UNZIP_MAX) throw new FileError(413, 'The zip unpacks to more than 500 MB');
    entries.push({ rel: parts.join('/'), dir, method, crc, csize, size, offset, exec: !!(mode & 0o111),
      mtime: new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2) });
  }
  return { entries, skipped };
}

// POST /api/files/unzip {path, dest?} → {extracted: rel, skipped}: into a new folder named after the zip in dest
// (default: the zip's own folder). It unpacks into a hidden staging folder first, renamed into place only when every
// entry came out whole (size and CRC match), so a bad archive leaves nothing behind.
export async function unzipPath(rootDir, rel, { dest: destRel } = {}) {
  const src = sourceOf(rootDir, rel), show = shower(src.root, [rel, destRel ?? '']);
  if (src.dir) throw new FileError(400, 'Not a zip file');
  const dest = destOf(rootDir, destRel ?? path.dirname(src.abs));
  const folder = src.name.replace(/\.zip$/i, '') || 'Archive';
  const fh = await fs.promises.open(src.real, 'r');
  const staging = path.join(dest.real, `.${folder}.${process.pid}-${Date.now()}.unzip`);
  try {
    const { size: fileSize } = await fh.stat();
    const { entries, skipped } = await readZip(fh, fileSize);
    await fs.promises.mkdir(staging);
    let total = 0;
    for (const e of entries) {
      const to = path.join(staging, ...e.rel.split('/'));
      try {
        if (e.dir) { await fs.promises.mkdir(to, { recursive: true }); continue; }
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        const lh = Buffer.alloc(30);
        await fh.read(lh, 0, 30, e.offset);
        if (lh.readUInt32LE(0) !== 0x04034b50) throw new FileError(400, 'The zip is damaged');
        const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        if (start + e.csize > fileSize) throw new FileError(400, 'The zip is damaged');
        let crc = 0, n = 0;
        const count = new Transform({ transform(c, _, cb) {
          n += c.length; total += c.length; crc = zlib.crc32(c, crc);
          if (n > e.size || total > UNZIP_MAX) return cb(new FileError(400, `${e.rel} is larger than the zip says`));
          cb(null, c);
        } });
        const data = e.csize ? fh.createReadStream({ start, end: start + e.csize - 1, autoClose: false }) : Readable.from([]);
        await pipeline(data, ...(e.method === 8 ? [zlib.createInflateRaw()] : []), count, fs.createWriteStream(to, { flags: 'wx', mode: e.exec ? 0o755 : 0o644 }));
        if (n !== e.size || crc !== e.crc) throw new FileError(400, `${e.rel} is damaged in the zip`);
        await fs.promises.utimes(to, e.mtime, e.mtime).catch(() => {});
      } catch (err) {
        if (['EEXIST', 'ENOTDIR', 'EISDIR'].includes(err.code)) throw new FileError(400, `The zip's entries clash at ${e.rel}`);
        if (err.code?.startsWith?.('Z_')) throw new FileError(400, `${e.rel} is damaged in the zip`);
        throw err;
      }
    }
    const to = freeName(src.root, dest.real, folder, { isDir: true, style: 'number' });
    await fs.promises.rename(staging, to);
    return { extracted: show(to), skipped };
  } catch (e) { await fs.promises.rm(staging, { recursive: true, force: true }); throw e; }
  finally { await fh.close(); }
}

// The route handler: rootFor(cid) → the chat's project folder, or null; readBody(req) → the parsed JSON body (POSTs).
// Returns true (synchronously) when it answers; grep, changed, diff and the POSTs answer later, from their own promises.
const OPS = { copy: (root, b) => copyPaths(root, b.paths, b.dest), move: (root, b) => movePaths(root, b.paths, b.dest),
  zip: (root, b) => zipPaths(root, b.paths, b), unzip: (root, b) => unzipPath(root, b.path, b) };
const FS_ERRORS = { EACCES: [403, 'Permission denied'], EPERM: [403, 'Permission denied'], EROFS: [403, 'The disk is read-only'],
  EEXIST: [409, 'Something with that name is already there'], ENOSPC: [507, 'The disk is full'], ENOENT: [404, 'Not found'] };
export function handleFiles(req, res, url, { rootFor, json, readBody }) {
  const m = url.pathname.match(/^\/api\/files\/(list|raw|find|grep|changed|diff|copy|move|zip|unzip)$/);
  if (!m || req.method !== (OPS[m[1]] ? 'POST' : 'GET')) return false;
  const fail = (e) => {
    if (res.headersSent) return res.destroy();
    const [status, error] = e.status ? [e.status, e.message] : FS_ERRORS[e.code] || [500, OPS[m[1]] ? `Could not ${m[1]} it` : 'Could not read it'];
    json(res, status, { error });
  };
  if (OPS[m[1]]) {
    readBody(req).then((b) => {
      const root = rootFor(b.cid ?? url.searchParams.get('cid'));
      if (!root) throw new FileError(404, 'No project for this chat');
      return OPS[m[1]](root, b);
    }).then((r) => json(res, 200, r), fail);
    return true;
  }
  const root = rootFor(url.searchParams.get('cid'));
  try {
    if (!root) throw new FileError(404, 'No project for this chat');
    if (m[1] === 'list') json(res, 200, listDir(root, url.searchParams.get('path') ?? url.searchParams.get('dir')));
    else if (m[1] === 'find' || m[1] === 'grep') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) throw new FileError(400, 'Type at least 2 characters');
      const dir = url.searchParams.get('dir') || '';
      if (m[1] === 'find') json(res, 200, findFiles(root, q, { dir }));
      else if (q.length > 200) throw new FileError(400, 'Search for 200 characters at most');
      else grepFiles(root, q, { dir }).then((r) => json(res, 200, r), fail);
    }
    else if (m[1] === 'changed') changedFiles(root).then((r) => json(res, 200, r), fail);
    else if (m[1] === 'diff') sendDiff(req, res, root, url.searchParams.get('path')).catch(fail);
    else sendFile(req, res, root, url.searchParams.get('path'));
  } catch (e) { fail(e); }
  return true;
}
