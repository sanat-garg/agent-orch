// digest.mjs over a DB built from orchestrator.mjs's and approvals.mjs's own CREATE TABLE text (read from source, so a
// schema change there reaches this test): every bucket, ordering, caps, one-line results and the empty cases.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { digest, resultLine } from '../digest.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-digest-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const SCHEMA = /const SCHEMA = `([\s\S]*?)`;/.exec(src('orchestrator.mjs'))[1];
const APPROVALS = /db\.exec\(`(CREATE TABLE IF NOT EXISTS approvals[\s\S]*?)`\);/.exec(src('approvals.mjs'))[1];

const T = 1790000000; // epoch s, as tasks store it
const SINCE = (T + 1000) * 1000; // epoch ms

function build(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  for (const c of ['agent', 'model', 'ran_agent', 'ran_model']) db.exec(`ALTER TABLE tasks ADD COLUMN ${c} TEXT`);
  db.exec(APPROVALS);
  const proj = db.prepare('INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)');
  proj.run(1, '/p/one', 'one', T); proj.run(2, '/p/two', 'two', T); proj.run(3, '/p/quiet', 'quiet', T);
  const task = db.prepare(`INSERT INTO tasks (id, project_id, kind, title, prompt, status, result, commit_sha, created_at, started_at, finished_at,
    agent, model, ran_agent, ran_model) VALUES (:id, :p, :kind, :title, 'x', :status, :result, :sha, :c, :c, :f, :agent, :model, :ran_agent, :ran_model)`);
  const add = (o) => task.run({ kind: 'work', result: null, sha: null, c: T, f: null, agent: null, model: null, ran_agent: null, ran_model: null, ...o });
  add({ id: 1, p: 1, title: 'Old done', status: 'done', f: T + 500 }); // before since: left out
  add({ id: 2, p: 1, title: 'Add a', status: 'done', f: T + 2000, sha: 'abc123', result: JSON.stringify({ summary: 'Added a\nand more' }),
    agent: 'claude', model: 'opus', ran_agent: 'codex', ran_model: 'gpt-5' });
  add({ id: 3, p: 1, title: 'Add b', status: 'done', f: T + 3000, result: `\n  ${'y'.repeat(300)}\nsecond line`, agent: 'claude', model: 'sonnet' });
  add({ id: 4, p: 1, kind: 'reflect', title: 'Reflect', status: 'done', f: T + 2500, result: '{"message":"Queued 3 tasks"}' });
  add({ id: 5, p: 1, title: 'Broke', status: 'failed', f: T + 1500, result: 'boom\ntrace' });
  add({ id: 6, p: 1, title: 'Conflict', status: 'needs_integration', f: T + 1800 });
  add({ id: 7, p: 1, title: 'Old failure', status: 'failed', f: T + 10 });
  add({ id: 8, p: 2, title: 'Checkpoint', status: 'awaiting_review', f: T + 100 }); // old, still needs you
  add({ id: 9, p: 2, title: 'Held', status: 'paused', c: T + 200, f: null });
  add({ id: 10, p: 2, title: 'Browser send', status: 'running', f: null });
  add({ id: 11, p: 2, title: 'Queued', status: 'queued', f: null });
  add({ id: 12, p: 3, title: 'Long ago', status: 'done', f: T + 1 });
  const appr = db.prepare("INSERT INTO approvals (id, task_id, created_at, expires_at, action, status) VALUES (?, ?, ?, ?, ?, ?)");
  appr.run('appr-1', 10, (T + 4000) * 1000, (T + 90000) * 1000, 'Send email to bob', 'pending');
  appr.run('appr-2', 10, (T + 3500) * 1000, (T + 90000) * 1000, 'Click buy', 'approved');
  db.close();
}

const file = path.join(tmp, 'agent-orch.db');
build(file);

test('resultLine: JSON summary/message, else the first non-empty line, trimmed to 200 chars', () => {
  assert.equal(resultLine('{"summary":"S\\nmore","message":"M"}'), 'S');
  assert.equal(resultLine('{"message":"M"}'), 'M');
  assert.equal(resultLine('\n\n  first  \nsecond'), 'first');
  assert.equal(resultLine('42'), '42');
  assert.equal(resultLine(null), null);
  assert.equal(resultLine('{"other":1}'), null);
  const long = resultLine('z'.repeat(500));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
});

test('digest: done, failed and needs-you per project, newest first, quiet projects skipped', () => {
  const d = digest({ dbFile: file, since: SINCE, now: 123 });
  assert.equal(d.since, SINCE);
  assert.equal(d.at, 123);
  assert.deepEqual(d.projects.map((p) => [p.id, p.name]), [[1, 'one'], [2, 'two']]);
  const [one, two] = d.projects;
  assert.deepEqual(one.done.map((t) => t.id), [3, 4, 2]);
  assert.deepEqual(one.done[2], { id: 2, title: 'Add a', kind: 'work', finished_at: (T + 2000) * 1000, commit_sha: 'abc123', result: 'Added a',
    agent: 'codex', model: 'gpt-5' });
  assert.equal(one.done[0].result.length, 200);
  assert.ok(!one.done[0].result.includes('\n'));
  assert.deepEqual([one.done[0].agent, one.done[0].model], ['claude', 'sonnet'], 'agent/model when it never recorded a run');
  assert.deepEqual(one.done[1], { id: 4, title: 'Reflect', kind: 'reflect', finished_at: (T + 2500) * 1000, commit_sha: null, result: 'Queued 3 tasks',
    agent: null, model: null });
  assert.deepEqual(one.failed.map((t) => [t.id, t.status, t.result]), [[6, 'needs_integration', null], [5, 'failed', 'boom']]);
  assert.deepEqual(one.needsYou, []);
  assert.deepEqual(two.done, []);
  assert.deepEqual(two.failed, []);
  assert.deepEqual(two.needsYou, [
    { id: 10, title: 'Browser send', why: 'approval', approval: 'appr-1', action: 'Send email to bob' },
    { id: 9, title: 'Held', why: 'paused' },
    { id: 8, title: 'Checkpoint', why: 'review' },
  ]);
  assert.deepEqual(d.counts, { done: 3, failed: 2, needsYou: 3 });
  for (const p of d.projects) for (const t of [...p.done, ...p.failed]) assert.equal(typeof t.finished_at, 'number');
});

test('digest: each list is capped at limit', () => {
  const d = digest({ dbFile: file, since: SINCE, limit: 1 });
  const [one, two] = d.projects;
  assert.deepEqual(one.done.map((t) => t.id), [3]);
  assert.deepEqual(one.failed.map((t) => t.id), [6]);
  assert.deepEqual(two.needsYou.map((t) => t.why), ['approval']);
  assert.deepEqual(d.counts, { done: 1, failed: 1, needsYou: 1 });
});

test('digest: since 0 reports everything finished', () => {
  const d = digest({ dbFile: file, since: 0 });
  assert.deepEqual(d.projects.map((p) => p.id), [1, 2, 3]);
  assert.deepEqual(d.projects[0].done.map((t) => t.id), [3, 4, 2, 1]);
});

test('digest: a missing DB, or one without tables, is an empty digest', () => {
  const empty = { since: SINCE, at: 5, projects: [], counts: { done: 0, failed: 0, needsYou: 0 } };
  assert.deepEqual(digest({ dbFile: path.join(tmp, 'nope', 'agent-orch.db'), since: SINCE, now: 5 }), empty);
  const bare = path.join(tmp, 'bare.db');
  new DatabaseSync(bare).close();
  assert.deepEqual(digest({ dbFile: bare, since: SINCE, now: 5 }), empty);
  assert.ok(!fs.existsSync(path.join(tmp, 'nope')), 'read-only: nothing created');
});
