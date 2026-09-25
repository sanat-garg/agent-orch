// Agent screenshots: images from tool results and from <project>/.agent-orch/shots/ are stored once, by content
// hash, in <DATA>/media/<sha256>.<ext> and shown in chat / the task drawer as {k|t:'image', id, name, w?, h?}.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MEDIA_ID_RE = /^[a-f0-9]{64}\.(png|jpe?g|webp|gif)$/;
export const MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const SHOTS_DIR = path.join('.agent-orch', 'shots');

// Format and size from the bytes themselves (never the claimed media type); null for anything but png/jpeg/webp/gif.
export function sniffImage(b) {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { ext: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8') return { ext: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length >= 16 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16), out = { ext: 'webp' };
    if (kind === 'VP8 ' && b.length >= 30) Object.assign(out, { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff });
    else if (kind === 'VP8L' && b.length >= 25) { const v = b.readUInt32LE(21); Object.assign(out, { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }); }
    else if (kind === 'VP8X' && b.length >= 30) Object.assign(out, { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 });
    return out;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the segments to the first start-of-frame marker for the size.
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff || m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { ext: 'jpg', w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return { ext: 'jpg' };
  }
  return null;
}

// Stores `buf` (deduplicated by hash) and returns the image event body, or null if it isn't an allowed image.
export function saveMedia(dataDir, buf, name = 'image') {
  if (!buf?.length || buf.length > MAX_MEDIA_BYTES) return null;
  const info = sniffImage(buf);
  if (!info) return null;
  const id = `${crypto.createHash('sha256').update(buf).digest('hex')}.${info.ext}`;
  const dir = path.join(dataDir, 'media'), file = path.join(dir, id);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  const ev = { id, name: String(name).slice(0, 200) };
  if (info.w && info.h) Object.assign(ev, { w: info.w, h: info.h });
  return ev;
}

export function saveBase64(dataDir, data, name) {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 4) return null;
  return saveMedia(dataDir, Buffer.from(data, 'base64'), name);
}

// Base64 image blocks inside a tool_result's content: [{mediaType, data}].
export function toolResultImages(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c?.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string')
    .map((c) => ({ mediaType: c.source.media_type || null, data: c.source.data }));
}
const imageName = (mediaType) => `screenshot.${{ 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mediaType] || 'png'}`;

// Image files under <cwd>/.agent-orch/shots/ (relative name -> mtime+size), at most 500 of them.
function scanShots(cwd) {
  const root = path.join(cwd, SHOTS_DIR), out = new Map();
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.size >= 500) return;
      const f = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(f, depth + 1);
      else if (e.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(e.name)) {
        try { const s = fs.statSync(f); out.set(path.relative(root, f), `${s.mtimeMs}:${s.size}`); } catch {}
      }
    }
  };
  walk(root, 0);
  return out;
}

// One per chat turn / task run: images({mediaType,data}) stores tool-result images; shots() returns image events for
// files under .agent-orch/shots/ that are new or changed since the collector was made (or since the last call).
export function mediaCollector(dataDir, cwd) {
  let seen = cwd ? scanShots(cwd) : new Map();
  return {
    image(img) {
      try { return saveBase64(dataDir, img.data, imageName(img.mediaType)); } catch (e) { console.error('[media] save failed', e.message); return null; }
    },
    shots() {
      if (!cwd) return [];
      const now = scanShots(cwd), out = [];
      for (const [rel, sig] of now) {
        if (seen.get(rel) === sig || Number(sig.split(':')[1]) > MAX_MEDIA_BYTES) continue;
        try {
          const ev = saveMedia(dataDir, fs.readFileSync(path.join(cwd, SHOTS_DIR, rel)), rel);
          if (ev) out.push(ev);
        } catch (e) { console.error('[media] shot failed', rel, e.message); }
      }
      seen = now;
      return out;
    },
  };
}
