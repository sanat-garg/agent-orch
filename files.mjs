// Read-only file browsing for the Files view: one chat's project folder, never anything outside it. Paths from the
// client are relative to the project; each is resolved through realpath (so symlinks count by where they point) and
// must stay inside the project's own real path. Listing gives names, sizes and dates; `raw` serves one file: images
// as themselves, everything else as plain text (capped), under a sandbox CSP so nothing served can run as a page.
//   GET /api/files/list?cid=<chat>&path=<rel>  → {name, path, crumbs, entries: [{name, dir, size, mtime, hidden}], truncated}
//   GET /api/files/raw?cid=<chat>&path=<rel>   → the file (images), or text/plain (first TEXT_MAX bytes; 415 for binary)
import fs from 'node:fs';
import path from 'node:path';

export const TEXT_MAX = 1024 * 1024;
export const IMAGE_MAX = 25 * 1024 * 1024;
export const LIST_MAX = 5000;
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

// The route handler: rootFor(cid) → the chat's project folder, or null. Returns true when it answered.
export function handleFiles(req, res, url, { rootFor, json }) {
  const m = url.pathname.match(/^\/api\/files\/(list|raw)$/);
  if (!m || req.method !== 'GET') return false;
  const root = rootFor(url.searchParams.get('cid'));
  try {
    if (!root) throw new FileError(404, 'No project for this chat');
    if (m[1] === 'list') json(res, 200, listDir(root, url.searchParams.get('path')));
    else sendFile(req, res, root, url.searchParams.get('path'));
  } catch (e) {
    if (res.headersSent) { res.destroy(); return true; }
    json(res, e.status || (e.code === 'EACCES' ? 403 : 500), { error: e.status ? e.message : e.code === 'EACCES' ? 'Permission denied' : 'Could not read it' });
  }
  return true;
}
