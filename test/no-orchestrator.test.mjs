// CW_NO_ORCHESTRATOR=1: the server boots on a copy of real data, migrates the DB and serves it, but never
// claims, requeues or schedules tasks and never takes the data-dir lock.
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
const PASSWORD = 'no-orch-test-password';
let child, base, dataDir, projDir, out = '';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-noorch-'));
  projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-noorch-proj-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  // A pre-migration DB (no agent/model/route columns) with a queued task, a running one and its unfinished run.
  fs.mkdirSync(path.join(dataDir, 'orchestrator'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  const t = Date.now() / 1000;
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL, convo_id TEXT,
      status TEXT NOT NULL DEFAULT 'active', priority INTEGER NOT NULL DEFAULT 50, mode TEXT NOT NULL DEFAULT 'build',
      model TEXT, perpetual INTEGER NOT NULL DEFAULT 1, autonomous INTEGER NOT NULL DEFAULT 0,
      chat_session_id TEXT, next_reflect_at REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'work', title TEXT NOT NULL,
      prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', priority INTEGER NOT NULL DEFAULT 50,
      urgency TEXT NOT NULL DEFAULT 'normal', deadline REAL, depends_on INTEGER, done_when TEXT,
      continuations INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'user', session_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, not_before REAL NOT NULL DEFAULT 0, result TEXT, last_error TEXT,
      verify_output TEXT, commit_sha TEXT, created_at REAL NOT NULL, started_at REAL, finished_at REAL);
    CREATE TABLE runs (id INTEGER PRIMARY KEY, task_id INTEGER, purpose TEXT NOT NULL, session_id TEXT, outcome TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      num_turns INTEGER DEFAULT 0, started_at REAL NOT NULL, finished_at REAL, log_path TEXT);`);
  db.prepare("INSERT INTO projects(id,path,name,autonomous,created_at) VALUES(1,?,'p',1,?)").run(projDir, t);
  db.prepare("INSERT INTO tasks(id,project_id,title,prompt,status,created_at) VALUES(1,1,'queued one','x','queued',?)").run(t);
  db.prepare("INSERT INTO tasks(id,project_id,title,prompt,status,created_at,started_at) VALUES(2,1,'running one','x','running',?,?)").run(t, t);
  db.prepare("INSERT INTO runs(task_id,purpose,started_at) VALUES(2,'work',?)").run(t);
  db.close();

  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, CW_NO_ORCHESTRATOR: '1', PORT: String(port), CW_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
});

after(() => {
  child?.kill('SIGKILL');
  for (const d of [dataDir, projDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test('CW_NO_ORCHESTRATOR=1 migrates and serves tasks but never requeues, claims or locks', async () => {
  assert.match(out, /\[orchestrator\] disabled/);
  await new Promise((r) => setTimeout(r, 7000)); // past the first scheduler tick (5 s) it would otherwise run
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const [id, status] of [[1, 'queued'], [2, 'running']]) {
    const r = await fetch(`${base}/api/orch/task/${id}`, { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).task.status, status, `task #${id}`);
  }
  assert.equal(child.exitCode, null);
  assert.ok(!fs.existsSync(path.join(dataDir, 'orchestrator', 'lock')), 'no data-dir lock taken');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'), { readOnly: true });
  try {
    assert.ok(db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'route_note'), 'migrations ran');
    assert.deepEqual(db.prepare('SELECT id, status, attempts FROM tasks ORDER BY id').all().map((r) => ({ ...r })),
      [{ id: 1, status: 'queued', attempts: 0 }, { id: 2, status: 'running', attempts: 0 }]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs WHERE finished_at IS NULL').get().n, 1, 'the open run is left alone');
  } finally { db.close(); }
});
