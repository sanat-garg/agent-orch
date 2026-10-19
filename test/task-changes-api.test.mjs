// GET /api/orch/tasks/:id/changes over HTTP: a merged task's 'agent-orch #<id>:' commit comes back as its file stat and
// patch; ?max= is clamped; an unknown task is a 404 and a project folder that isn't a git repo a readable 500.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedPath } from './helpers/isolated-path.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'task-changes-password';
let child, base, dataDir, home, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-changes-api-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-changes-api-home-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH: isolatedPath(bin), PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const ok = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = ok.headers.get('set-cookie').split(';')[0];
  await ok.arrayBuffer();
});

after(() => {
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const get = async (p) => { const r = await fetch(base + p, { headers: { cookie } }); return { status: r.status, body: JSON.parse(await r.text()) }; };
async function addTask(dir) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  try {
    const pid = Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,?,'paused',0)").run(dir, path.basename(dir)).lastInsertRowid);
    return Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,status,created_at) VALUES(?,'Change a','a','done',0)").run(pid).lastInsertRowid);
  } finally { db.close(); }
}

test('a merged task: its commit\'s files and patch; ?max= is clamped to 20 KB..1 MB', { timeout: 60000 }, async () => {
  const repo = path.join(dataDir, 'proj');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  const id = await addTask(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\n');
  fs.writeFileSync(path.join(repo, 'big.txt'), 'y\n'.repeat(15000));
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', `agent-orch #${id}: change a`);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'later work');

  const r = await get(`/api/orch/tasks/${id}/changes`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.source, 'commit');
  assert.deepEqual(r.body.commits, [git(repo, 'rev-parse', 'HEAD~1')]);
  assert.deepEqual(r.body.files, [
    { path: 'a.txt', add: 1, del: 1, binary: false },
    { path: 'big.txt', add: 15000, del: 0, binary: false },
  ]);
  assert.match(r.body.patch, /^-two\n\+TWO$/m);
  assert.equal(r.body.truncated, false);

  const small = await get(`/api/orch/tasks/${id}/changes?max=1`);
  assert.equal(small.body.truncated, true);
  const len = Buffer.byteLength(small.body.patch);
  assert.ok(len > 10_000 && len <= 20_000, `clamped up to 20 KB, got ${len}`);
  assert.equal(small.body.files.length, 2, 'the file stat is never cut');
  assert.equal((await get(`/api/orch/tasks/${id}/changes?max=99999999`)).body.truncated, false);
});

test('an unknown task is a 404; a project folder that is not a git repo a readable 500', { timeout: 30000 }, async () => {
  const r = await get('/api/orch/tasks/99999/changes');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'No such task');
  const plain = path.join(dataDir, 'plain');
  fs.mkdirSync(plain);
  const bad = await get(`/api/orch/tasks/${await addTask(plain)}/changes`);
  assert.equal(bad.status, 500);
  assert.match(bad.body.error, /git/);
  const unauth = await fetch(base + '/api/orch/tasks/99999/changes');
  assert.equal(unauth.status, 401);
  await unauth.arrayBuffer();
});
