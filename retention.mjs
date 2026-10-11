// Retention GC: run logs, screenshots and uploads otherwise pile up forever. gcRetention({dataDir, runsDir?, db?, now?,
// runDays, mediaDays, uploadDays, projectDirs, stars?}) deletes <runsDir>/run-NNNNNN.jsonl once its task finished
// (done/failed/cancelled) more than runDays ago (the run's finished_at when the task row is gone, the file mtime when the
// run row is gone too; a live task's log always stays), then <browserDir>/<task id> screen-prompt workspaces (browserDir
// defaults to <DATA>/orchestrator/browser-tasks; their .agent-orch/shots are duplicates of the media store) whose task is
// done/failed/cancelled (any age) or has no row (any other status keeps it; without a DB only those whose mtime is older
// than runDays go), then <DATA>/uploads/<id>/ dirs (uploads.mjs) whose meta.json `at` (else the dir mtime) is older than
// uploadDays and whose 24-hex id appears in no chat log. Then screenshots (owner, 2026-10-11): <DATA>/media/<sha256>.<ext>
// files and every projectDirs' .agent-orch/shots/ images whose mtime is older than mediaDays (3) go even when a chat or
// task shows them, except: starred ones (media.mjs readStars; a shot file by its content hash), ones used by a webpage
// (a media id, or a shot file's name, appears in one of the project's web files: see webFiles), a surviving upload's
// image (an attachment, not a screenshot) and a pending approval's screenshot. saveMedia touches a re-saved image, which
// restarts its clock. Non-integer names are left alone. Synchronous, never throws per file; returns
// {runs, media, shots, uploads, browserTasks, bytes}. Callers catch: see orchestrator.mjs retentionGc.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MEDIA_ID_RE, SHOTS_DIR, readStars } from './media.mjs';
import { UPLOAD_ID_RE } from './uploads.mjs';

const DAY = 86400e3;
const RUN_RE = /^run-(\d+)\.jsonl$/;
const TASK_ID_RE = /^\d+$/;
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
// Image files under a project's .agent-orch/shots/ last written before `before` (ms), at most 3 levels deep.
const SHOT_FILE = /\.(png|jpe?g|webp|gif)$/i;
function oldShots(dir, before, depth = 0, out = []) {
  for (const e of list(dir)) {
    const f = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) oldShots(f, before, depth + 1, out);
    else if (e.isFile() && SHOT_FILE.test(e.name) && (stat(f)?.mtimeMs ?? Infinity) < before) out.push(f);
  }
  return out;
}
// A project's files a webpage could use a screenshot from (markup, styles, scripts, docs, data): git's tracked and
// untracked-but-not-ignored files, else a walk that skips dot dirs and node_modules; never .agent-orch/, at most 5000.
// Tests and scripts don't count: the script that takes a screenshot names it, but that isn't a page using it.
const WEB_FILE = /\.(html?|css|scss|sass|less|[cm]?[jt]sx?|vue|svelte|astro|mdx?|json|php|erb|ejs|hbs|xml|svg)$/i;
const NOT_PAGE = /(^|\/)(tests?|e2e|__tests__|specs?|scripts?|bin)\/|\.(test|spec)\.[^./]+$/i;
const MAX_WEB_BYTES = 2 * 1024 * 1024;
function webFiles(dir) {
  let names;
  try {
    names = execFileSync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 30e3, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0');
  } catch {
    names = [];
    const walk = (rel, depth) => {
      for (const e of list(path.join(dir, rel))) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory() && depth < 4 && !e.name.startsWith('.') && e.name !== 'node_modules') walk(r, depth + 1);
        else if (e.isFile()) names.push(r);
      }
    };
    walk('', 0);
  }
  return names.filter((n) => n && WEB_FILE.test(n) && !NOT_PAGE.test(n) && !n.startsWith('.agent-orch/')).slice(0, 5000).map((n) => path.join(dir, n));
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
// Total bytes of everything under a path (a browser workspace nests its shots); symlinks count as themselves.
function treeBytes(f, depth = 0) {
  let st;
  try { st = fs.lstatSync(f); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  if (depth < 20) for (const e of list(f)) n += treeBytes(path.join(f, e.name), depth + 1);
  return n;
}

export function gcRetention({ dataDir, runsDir = path.join(dataDir, 'orchestrator', 'runs'),
  browserDir = path.join(dataDir, 'orchestrator', 'browser-tasks'), db = null, now = Date.now(), runDays = 30, mediaDays = 3, uploadDays = 7,
  projectDirs = [], stars = readStars(dataDir) }) {
  const out = { runs: 0, media: 0, shots: 0, uploads: 0, browserTasks: 0, bytes: 0 };
  const mediaDir = path.join(dataDir, 'media'), uploadsDir = path.join(dataDir, 'uploads');
  const lookup = db?.prepare(`SELECT r.finished_at AS rf, t.id AS tid, t.status, t.finished_at AS tf
    FROM runs r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.id=?`);
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
  }

  let taskStatus = null;
  try { taskStatus = db?.prepare('SELECT status FROM tasks WHERE id=?'); } catch {}
  for (const e of list(browserDir)) {
    if (!TASK_ID_RE.test(e.name)) continue;
    const f = path.join(browserDir, e.name);
    let gone;
    if (db) {
      if (!taskStatus) continue; // a DB we cannot read: never guess a task is finished
      try { const row = taskStatus.get(Number(e.name)); gone = !row || FINISHED.has(row.status); } catch { continue; }
    } else {
      const st = stat(f);
      gone = !!st && now - st.mtimeMs > runDays * DAY;
    }
    if (!gone) continue;
    const size = treeBytes(f);
    try { fs.rmSync(f, { recursive: true, force: true }); out.browserTasks++; out.bytes += size; } catch {}
  }

  // Uploads first: the media copies of the ones that survive are attachments, not screenshots, and stay.
  const oldUploads = list(uploadsDir).filter((e) => e.isDirectory() && UPLOAD_ID_RE.test(e.name)).filter((e) => {
    const dir = path.join(uploadsDir, e.name);
    let at = null;
    try { at = Number(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).at) || null; } catch {}
    at ??= stat(dir)?.mtimeMs;
    return at != null && now - at > uploadDays * DAY;
  }).map((e) => e.name);
  if (oldUploads.length) {
    const upIds = new Set();
    scanDir(path.join(dataDir, 'logs'), new Set(), upIds);
    for (const id of oldUploads) {
      if (upIds.has(id)) continue;
      const dir = path.join(uploadsDir, id), size = dirBytes(dir);
      try { fs.rmSync(dir, { recursive: true }); out.uploads++; out.bytes += size; } catch {}
    }
  }

  // Screenshots older than mediaDays go, chat or not, unless starred, used by a webpage or awaiting an approval.
  const maxAge = mediaDays * DAY, starred = new Set([...stars].map((id) => id.slice(0, 64)));
  const oldMedia = list(mediaDir).filter((e) => e.isFile() && MEDIA_ID_RE.test(e.name))
    .map((e) => ({ name: e.name, st: stat(path.join(mediaDir, e.name)) }))
    .filter((x) => x.st && now - x.st.mtimeMs > maxAge && !starred.has(x.name.slice(0, 64)));
  const dirs = [...new Set(projectDirs.filter(Boolean))].map((dir) => ({ dir, shots: oldShots(path.join(dir, SHOTS_DIR), now - maxAge) }));
  if (!oldMedia.length && !dirs.some((d) => d.shots.length)) return out;

  const keep = new Set();
  if (oldMedia.length) {
    for (const e of list(uploadsDir)) if (e.isDirectory()) scanFile(path.join(uploadsDir, e.name, 'meta.json'), keep);
    for (const s of column(db, "SELECT screenshot FROM approvals WHERE screenshot IS NOT NULL AND status='pending'")) scanText(s, keep);
  }
  for (const { dir, shots } of dirs) {
    if (!oldMedia.length && !shots.length) continue;
    const names = new Set(shots.map((f) => path.basename(f))), used = new Set();
    for (const f of webFiles(dir)) {
      let text;
      try { if ((stat(f)?.size ?? Infinity) > MAX_WEB_BYTES) continue; text = fs.readFileSync(f, 'latin1'); } catch { continue; }
      if (oldMedia.length) scanText(text, keep);
      for (const n of names) if (text.includes(n)) { used.add(n); names.delete(n); }
    }
    for (const f of shots) {
      if (used.has(path.basename(f))) continue;
      let size = 0;
      try {
        if (starred.size) {
          const buf = fs.readFileSync(f);
          if (starred.has(crypto.createHash('sha256').update(buf).digest('hex'))) continue;
        }
        size = stat(f)?.size || 0;
        fs.rmSync(f);
        out.shots++; out.bytes += size;
      } catch {}
    }
  }
  for (const { name, st } of oldMedia) {
    if (keep.has(name.slice(0, 64))) continue;
    try { fs.rmSync(path.join(mediaDir, name)); out.media++; out.bytes += st.size; } catch {}
  }
  return out;
}
