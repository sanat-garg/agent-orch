// GET /api/orch/digest over HTTP: boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir), seeds finished and waiting
// tasks straight into its DB, then checks the JSON shape, the 24 h default for a missing or bad `since`, and that a
// `since` in the future leaves the done/failed lists empty (needs-you items stay, whatever their age).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'digest-api-password';
let child, base, dataDir, cookie, ids;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-digest-api-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  // The server has migrated the DB; seed behind its back (WAL allows a second writer).
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const now = Date.now() / 1000;
  const pid = Number(db.prepare('INSERT INTO projects (path, name, created_at) VALUES (?, ?, ?)').run(path.join(dataDir, 'p'), 'Invoices', now - 9000).lastInsertRowid);
  const add = db.prepare(`INSERT INTO tasks (project_id, kind, title, prompt, status, result, created_at, finished_at) VALUES (?, 'work', ?, 'x', ?, ?, ?, ?)`);
  ids = {
    done: Number(add.run(pid, 'Add totals', 'done', '{"summary":"Added totals\\nmore"}', now - 7200, now - 3600).lastInsertRowid),
    failed: Number(add.run(pid, 'Fix rounding', 'failed', 'boom\ntrace', now - 7200, now - 1800).lastInsertRowid),
    old: Number(add.run(pid, 'Ancient', 'done', null, now - 3 * 86400, now - 2 * 86400).lastInsertRowid),
    review: Number(add.run(pid, 'Checkpoint', 'awaiting_review', null, now - 7200, now - 600).lastInsertRowid),
  };
  db.close();
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});

after(() => {
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const get = async (q) => { const r = await fetch(`${base}/api/orch/digest${q}`, { headers: { cookie } }); return { status: r.status, body: JSON.parse(await r.text()) }; };

test('needs a session', async () => {
  const r = await fetch(`${base}/api/orch/digest`);
  assert.equal(r.status, 401);
  await r.arrayBuffer();
});

test('since=<epoch ms>: done, failed and needs-you per project with counts', async () => {
  const since = Date.now() - 4 * 3600e3, before = Date.now();
  const { status, body } = await get(`?since=${since}`);
  assert.equal(status, 200);
  assert.equal(body.since, since);
  assert.ok(body.at >= before && body.at <= Date.now() + 1000, 'at is the server time in ms');
  assert.deepEqual(body.counts, { done: 1, failed: 1, needsYou: 1 });
  assert.equal(body.projects.length, 1);
  const [p] = body.projects;
  assert.equal(p.name, 'Invoices');
  assert.equal(typeof p.id, 'number');
  assert.deepEqual(p.done.map((t) => [t.id, t.title, t.result]), [[ids.done, 'Add totals', 'Added totals']]);
  assert.equal(typeof p.done[0].finished_at, 'number');
  assert.ok(p.done[0].finished_at > since, 'finished_at in ms');
  assert.deepEqual(p.failed.map((t) => [t.id, t.status, t.result]), [[ids.failed, 'failed', 'boom']]);
  assert.deepEqual(p.needsYou, [{ id: ids.review, title: 'Checkpoint', why: 'review' }]);
});

test('a missing or bad since means the last 24 h', async () => {
  for (const q of ['', '?since=', '?since=nope', '?since=-5']) {
    const t0 = Date.now(), { status, body } = await get(q);
    assert.equal(status, 200, q);
    assert.ok(Math.abs(body.since - (t0 - 24 * 3600e3)) < 5000, `${q}: since ≈ 24 h ago`);
    assert.deepEqual(body.projects[0].done.map((t) => t.id), [ids.done], `${q}: the 2-day-old task is left out`);
  }
});

test('a since in the future gives empty done and failed lists', async () => {
  const { status, body } = await get(`?since=${Date.now() + 3600e3}`);
  assert.equal(status, 200);
  assert.equal(body.counts.done, 0);
  assert.equal(body.counts.failed, 0);
  for (const p of body.projects) assert.deepEqual([p.done, p.failed], [[], []]);
  assert.deepEqual(body.projects.flatMap((p) => p.needsYou.map((n) => n.id)), [ids.review], 'needs-you holds whatever its age');
});
