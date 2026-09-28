// Retention GC: run logs and media otherwise pile up forever. gcRetention({dataDir, runsDir?, db?, now?, runDays, mediaDays})
// deletes <runsDir>/run-NNNNNN.jsonl once its task finished (done/failed/cancelled) more than runDays ago (the run's
// finished_at when the task row is gone, the file mtime when the run row is gone too; a live task's log always stays),
// then <DATA>/media/<sha256>.<ext> files older than mediaDays whose id appears nowhere it is still referenced: no chat log
// (<DATA>/logs), surviving run log, approval audit log (<DATA>/audit/<task>.jsonl), approvals.screenshot or tasks.result
// (review/checkpoint shots), then <DATA>/uploads/<id>/ dirs (uploads.mjs) whose meta.json `at` (else the dir mtime) is
// older than mediaDays and whose 24-hex id appears in no chat log. Synchronous, never throws per file; returns
// {runs, media, uploads, bytes}. Callers catch: see orchestrator.mjs retentionGc.

import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_ID_RE } from './media.mjs';
import { UPLOAD_ID_RE } from './uploads.mjs';

const DAY = 86400e3;
const RUN_RE = /^run-(\d+)\.jsonl$/;
const FINISHED = new Set(['done', 'failed', 'cancelled']);

const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
const stat = (f) => { try { return fs.statSync(f); } catch { return null; } };

// Collects every 64-hex token (media ids are "<sha256>.<ext>") into ids and, when up is given, every standalone 24-hex
// token (upload ids) into up; from a string, a file, or the files under a dir.
const MEDIA_TOKEN = /[a-f0-9]{64}/g, UPLOAD_TOKEN = /(?<![a-f0-9])[a-f0-9]{24}(?![a-f0-9])/g;
function scanText(s, ids, up) {
  for (const m of s.matchAll(MEDIA_TOKEN)) ids.add(m[0]);
  if (up) for (const m of s.matchAll(UPLOAD_TOKEN)) up.add(m[0]);
}
function scanFile(f, ids, up) { try { scanText(fs.readFileSync(f, 'latin1'), ids, up); } catch {} }
function scanDir(dir, ids, up, depth = 0) {
  for (const e of list(dir)) {
    const f = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) scanDir(f, ids, up, depth + 1);
    else if (e.isFile()) scanFile(f, ids, up);
  }
}
// Rows of a query as strings; [] when the table or column is missing (an old DB) or there is no DB.
function column(db, sql) {
  try { return db ? db.prepare(sql).all().map((r) => String(Object.values(r)[0] ?? '')) : []; } catch { return []; }
}
// Total bytes of the files under a dir (one level deep is all an upload has).
function dirBytes(dir) {
  let n = 0;
  for (const e of list(dir)) if (e.isFile()) n += stat(path.join(dir, e.name))?.size || 0;
  return n;
}

export function gcRetention({ dataDir, runsDir = path.join(dataDir, 'orchestrator', 'runs'), db = null, now = Date.now(), runDays = 30, mediaDays = 7 }) {
  const out = { runs: 0, media: 0, uploads: 0, bytes: 0 };
  const lookup = db?.prepare(`SELECT r.finished_at AS rf, t.id AS tid, t.status, t.finished_at AS tf
    FROM runs r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.id=?`);
  const surviving = [];
  for (const e of list(runsDir)) {
    const m = e.isFile() && RUN_RE.exec(e.name);
    if (!m) continue;
    const f = path.join(runsDir, e.name), st = stat(f);
    if (!st) continue;
    let finished = st.mtimeMs; // no DB or no run row: the file's last write
    const row = lookup?.get(Number(m[1]));
    if (row) finished = row.tid != null ? (FINISHED.has(row.status) && row.tf ? row.tf * 1000 : null) : (row.rf ? row.rf * 1000 : null);
    if (finished != null && now - finished > runDays * DAY) {
      try { fs.rmSync(f); out.runs++; out.bytes += st.size; continue; } catch {}
    }
    surviving.push(f);
  }

  const maxAge = mediaDays * DAY;
  const mediaDir = path.join(dataDir, 'media'), uploadsDir = path.join(dataDir, 'uploads');
  const oldMedia = list(mediaDir).filter((e) => e.isFile() && MEDIA_ID_RE.test(e.name))
    .map((e) => ({ name: e.name, st: stat(path.join(mediaDir, e.name)) }))
    .filter((x) => x.st && now - x.st.mtimeMs > maxAge);
  const oldUploads = list(uploadsDir).filter((e) => e.isDirectory() && UPLOAD_ID_RE.test(e.name)).filter((e) => {
    const dir = path.join(uploadsDir, e.name);
    let at = null;
    try { at = Number(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).at) || null; } catch {}
    at ??= stat(dir)?.mtimeMs;
    return at != null && now - at > maxAge;
  }).map((e) => e.name);
  if (!oldMedia.length && !oldUploads.length) return out;

  // Chat logs hold both kinds of id; the other sources only reference media.
  const ids = new Set(), upIds = new Set();
  scanDir(path.join(dataDir, 'logs'), ids, oldUploads.length ? upIds : null);
  if (oldMedia.length) {
    for (const f of surviving) scanFile(f, ids);
    scanDir(path.join(dataDir, 'audit'), ids);
    for (const s of column(db, 'SELECT screenshot FROM approvals WHERE screenshot IS NOT NULL')) scanText(s, ids);
    for (const s of column(db, 'SELECT result FROM tasks WHERE result IS NOT NULL')) scanText(s, ids);
  }
  for (const { name, st } of oldMedia) {
    if (ids.has(name.slice(0, 64))) continue;
    try { fs.rmSync(path.join(mediaDir, name)); out.media++; out.bytes += st.size; } catch {}
  }
  for (const id of oldUploads) {
    if (upIds.has(id)) continue;
    const dir = path.join(uploadsDir, id), size = dirBytes(dir);
    try { fs.rmSync(dir, { recursive: true }); out.uploads++; out.bytes += size; } catch {}
  }
  return out;
}
