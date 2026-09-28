// Composer attachments: images and files the owner adds to a message (paste, drop or the paperclip).
// Each upload is stored at <DATA>/uploads/<id>/<name> with meta.json; images also go into the media store (media.mjs)
// so chat can show them. On send, placeUploads copies them into <project>/.agent-orch/uploads/, which ignores itself in
// git (never pushed), so every agent reads them by absolute path; the message carries the list (attachmentNote).
// Those project copies are a convenience: each placeUploads first sweeps ones older than PROJECT_UPLOADS_MAX_AGE_MS
// (sweepProjectUploads), except the ones being placed; a swept copy is re-copied from <DATA>/uploads when sent again.
// Images also go to the agent directly: Claude as image blocks, Codex with -i.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { saveMedia, sniffImage, MEDIA_TYPES } from './media.mjs';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const UPLOAD_ID_RE = /^[a-f0-9]{24}$/;
export const PROJECT_UPLOADS = path.join('.agent-orch', 'uploads');
export const PROJECT_UPLOADS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Largest image sent inline to Claude (the API's per-image limit); bigger ones are read from their path.
export const INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

// A file name that is safe on disk and in a prompt: no directories, control characters or leading dots.
export function safeName(name) {
  const base = path.basename(String(name || '')).normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return base || 'file';
}

// Stores one upload; returns its public meta {id, name, size, type, image?: {id, w, h}} (image: the media-store entry).
export function saveUpload(dataDir, buf, { name, type } = {}) {
  if (!buf?.length) return { error: 'The file is empty', status: 400 };
  if (buf.length > MAX_UPLOAD_BYTES) return { error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`, status: 413 };
  const id = crypto.randomBytes(12).toString('hex');
  const sniffed = sniffImage(buf);
  const meta = { id, name: safeName(name), size: buf.length, at: Date.now(),
    // Images are typed from their bytes; anything else keeps the browser's type (display only, never trusted to serve).
    type: sniffed ? MEDIA_TYPES[sniffed.ext] : String(type || 'application/octet-stream').slice(0, 100) };
  if (sniffed) {
    const img = saveMedia(dataDir, buf, meta.name);
    if (img) meta.image = { id: img.id, ...(img.w && { w: img.w }), ...(img.h && { h: img.h }) };
  }
  const dir = path.join(dataDir, 'uploads', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, meta.name), buf);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return meta;
}

export function readUpload(dataDir, id) {
  if (!UPLOAD_ID_RE.test(String(id))) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'uploads', id, 'meta.json'), 'utf8'));
    return { ...meta, file: path.join(dataDir, 'uploads', id, meta.name) };
  } catch { return null; }
}

// The public view a chat log keeps for each attachment.
export const attachmentView = (u) => ({ id: u.id, name: u.name, size: u.size, type: u.type, ...(u.image && { image: u.image }), ...(u.path && { path: u.path }) });

// Copies uploads (by id, in order, unknown ids dropped) into <cwd>/.agent-orch/uploads/<id8>-<name>; returns
// [{...meta, path}] with the absolute path agents read. The folder's own .gitignore keeps them out of every commit.
export function placeUploads(dataDir, ids, cwd) {
  const out = [];
  const dir = path.join(cwd, PROJECT_UPLOADS);
  const want = [...new Set(ids || [])].slice(0, MAX_ATTACHMENTS);
  sweepProjectUploads(cwd, { keep: want });
  for (const id of want) {
    const u = readUpload(dataDir, id);
    if (!u) continue;
    fs.mkdirSync(dir, { recursive: true });
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# Chat attachments: kept on this machine, never committed\n*\n');
    const dest = path.join(dir, `${id.slice(0, 8)}-${u.name}`);
    if (!fs.existsSync(dest)) fs.copyFileSync(u.file, dest);
    out.push({ ...u, path: dest });
  }
  return out;
}

// Deletes plain files in <cwd>/.agent-orch/uploads/ older than maxAgeMs (by mtime), except the .gitignore and copies of
// the ids in keep (name starts with <id8>-); never directories or symlinks. Returns the removed names; a missing folder
// or a file that can't be read or removed is skipped.
export function sweepProjectUploads(cwd, { maxAgeMs = PROJECT_UPLOADS_MAX_AGE_MS, keep = [] } = {}) {
  const dir = path.join(cwd, PROJECT_UPLOADS);
  const prefixes = keep.filter(Boolean).map((id) => `${String(id).slice(0, 8)}-`);
  const cutoff = Date.now() - maxAgeMs, removed = [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return removed; }
  for (const name of names) {
    if (name === '.gitignore' || prefixes.some((p) => name.startsWith(p))) continue;
    try {
      const file = path.join(dir, name), st = fs.lstatSync(file);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      fs.unlinkSync(file);
      removed.push(name);
    } catch { /* one bad file never stops the sweep */ }
  }
  return removed;
}

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

// The text an agent gets with a message: where each attachment is and what it is.
export function attachmentNote(files) {
  if (!files?.length) return '';
  const lines = files.map((f) => `- ${f.path} (${f.image ? 'image' : f.type || 'file'}, ${fmtSize(f.size)})`);
  return `\n\n[The owner attached ${files.length === 1 ? 'a file' : `${files.length} files`}, saved in this project. Open ${files.length === 1 ? 'it' : 'them'} with your file tools and use ${files.length === 1 ? 'it' : 'them'} as the message asks:]\n${lines.join('\n')}`;
}

// Images Claude can see directly (inline base64 image blocks); the rest it reads from their paths.
export function claudeImageBlocks(files) {
  return (files || []).filter((f) => f.image && f.size <= INLINE_IMAGE_BYTES).map((f) => ({
    type: 'image', source: { type: 'base64', media_type: f.type, data: fs.readFileSync(f.path).toString('base64') },
  }));
}
