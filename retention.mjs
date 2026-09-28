// Retention GC: run logs and media otherwise pile up forever. gcRetention({dataDir, runsDir?, db?, now?, runDays, mediaDays})
// deletes <runsDir>/run-NNNNNN.jsonl once its task finished (done/failed/cancelled) more than runDays ago (the run's
// finished_at when the task row is gone, the file mtime when the run row is gone too; a live task's log always stays),
// then <DATA>/media/<sha256>.<ext> files older than mediaDays whose id appears in no chat log (<DATA>/logs) and no
// surviving run log. Synchronous; returns {runs, media, bytes}. Callers catch: see orchestrator.mjs retentionGc.

import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_ID_RE } from './media.mjs';

const DAY = 86400e3;
const RUN_RE = /^run-(\d+)\.jsonl$/;
const FINISHED = new Set(['done', 'failed', 'cancelled']);

const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
const stat = (f) => { try { return fs.statSync(f); } catch { return null; } };

// Every 64-hex token in a file, or in the files under a dir (media ids are "<sha256>.<ext>").
function scanFile(f, ids) { try { for (const m of fs.readFileSync(f, 'latin1').matchAll(/[a-f0-9]{64}/g)) ids.add(m[0]); } catch {} }
function scanDir(dir, ids, depth = 0) {
  for (const e of list(dir)) {
    const f = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) scanDir(f, ids, depth + 1);
    else if (e.isFile()) scanFile(f, ids);
  }
}

export function gcRetention({ dataDir, runsDir = path.join(dataDir, 'orchestrator', 'runs'), db = null, now = Date.now(), runDays = 30, mediaDays = 7 }) {
  const out = { runs: 0, media: 0, bytes: 0 };
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

  const mediaDir = path.join(dataDir, 'media');
  const old = list(mediaDir).filter((e) => e.isFile() && MEDIA_ID_RE.test(e.name))
    .map((e) => ({ name: e.name, st: stat(path.join(mediaDir, e.name)) }))
    .filter((x) => x.st && now - x.st.mtimeMs > mediaDays * DAY);
  if (!old.length) return out;
  const ids = new Set();
  scanDir(path.join(dataDir, 'logs'), ids);
  for (const f of surviving) scanFile(f, ids);
  for (const { name, st } of old) {
    if (ids.has(name.slice(0, 64))) continue;
    try { fs.rmSync(path.join(mediaDir, name)); out.media++; out.bytes += st.size; } catch {}
  }
  return out;
}
