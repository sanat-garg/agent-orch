// Digest: what finished, failed or needs the owner since they last looked, per project, so the phone app opened after
// hours away can say what happened. Read-only like stats.mjs: its own read-only connection per call, closed after;
// a missing DB or table gives an empty digest, never a throw. Every time is epoch ms and nothing is formatted (app.js does).
//   digest({ dbFile, since, now, limit }) → { since, at, projects: [{ id, name, done, failed, needsYou }], counts: { done, failed, needsYou } }
// done/failed: tasks finished after `since` (newest first); needsYou: awaiting review, paused or holding a pending
// approval, whatever their age. The server route and the Queue group come later (not wired yet).
import { DatabaseSync } from 'node:sqlite';

const RESULT_MAX = 200;
const ms = (s) => (s == null ? null : Math.round(s * 1000));

// tasks.result → one line of at most RESULT_MAX chars: a JSON result's `summary`/`message`, else the first line of text.
export function resultLine(result) {
  if (result == null) return null;
  let s = String(result);
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object') s = typeof j.summary === 'string' ? j.summary : typeof j.message === 'string' ? j.message : '';
  } catch {}
  const line = s.split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (!line) return null;
  return line.length > RESULT_MAX ? `${line.slice(0, RESULT_MAX - 1)}…` : line;
}

// A task's DB columns that may not exist yet in an old DB are read only when present.
function columns(db) {
  try { return new Set(db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name)); } catch { return new Set(); }
}

export function digest({ dbFile, since = 0, now = Date.now(), limit = 50 } = {}) {
  since = Number(since) || 0;
  limit = Math.max(1, Math.floor(Number(limit)) || 50);
  const out = { since, at: now, projects: [], counts: { done: 0, failed: 0, needsYou: 0 } };
  let db;
  try { db = new DatabaseSync(dbFile, { readOnly: true }); } catch { return out; }
  try {
    const cols = columns(db);
    if (!cols.size) return out;
    const opt = (c) => (cols.has(c) ? c : `NULL AS ${c}`);
    const pick = `id, project_id, title, kind, status, finished_at, commit_sha, result, ${['agent', 'model', 'ran_agent', 'ran_model'].map(opt).join(', ')}`;
    let projects;
    try { projects = db.prepare('SELECT id, name FROM projects ORDER BY id').all(); } catch { return out; }
    const finished = db.prepare(`SELECT ${pick} FROM tasks WHERE project_id=:p AND status IN (SELECT value FROM json_each(:st))
      AND finished_at > :since ORDER BY finished_at DESC, id DESC LIMIT :lim`);
    const waiting = db.prepare(`SELECT id, title, status, COALESCE(finished_at, started_at, created_at) AS t FROM tasks
      WHERE project_id=:p AND status IN ('awaiting_review','paused')`);
    let held = null;
    try {
      held = db.prepare(`SELECT a.id AS aid, a.action, a.created_at, t.id, t.title FROM approvals a JOIN tasks t ON t.id=a.task_id
        WHERE t.project_id=:p AND a.status='pending'`);
    } catch {} // no approvals table yet
    const shape = (t) => ({
      id: t.id, title: t.title, kind: t.kind, finished_at: ms(t.finished_at), commit_sha: t.commit_sha || null, result: resultLine(t.result),
      agent: (t.ran_agent ? t.ran_agent : t.agent) || null, model: (t.ran_agent ? t.ran_model : t.model) || null,
    });
    const args = (p, st) => ({ p, st: JSON.stringify(st), since: since / 1000, lim: limit });
    for (const p of projects) {
      const done = finished.all(args(p.id, ['done'])).map(shape);
      const failed = finished.all(args(p.id, ['failed', 'needs_integration'])).map((t) => ({ ...shape(t), status: t.status }));
      // Newest first: a pending approval by when it was asked (ms), a review/pause by the task's latest time (s).
      const needs = [
        ...waiting.all({ p: p.id }).map((t) => ({ t: ms(t.t) || 0, v: { id: t.id, title: t.title, why: t.status === 'paused' ? 'paused' : 'review' } })),
        ...(held ? held.all({ p: p.id }) : []).map((a) => ({ t: a.created_at || 0, v: { id: a.id, title: a.title, why: 'approval', approval: a.aid, action: a.action ?? null } })),
      ];
      const needsYou = needs.sort((a, b) => b.t - a.t || b.v.id - a.v.id).slice(0, limit).map((n) => n.v);
      if (!done.length && !failed.length && !needsYou.length) continue;
      out.projects.push({ id: p.id, name: p.name, done, failed, needsYou });
      out.counts.done += done.length; out.counts.failed += failed.length; out.counts.needsYou += needsYou.length;
    }
    return out;
  } catch {
    return { since, at: now, projects: [], counts: { done: 0, failed: 0, needsYou: 0 } };
  } finally {
    db.close();
  }
}
