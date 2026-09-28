// version.mjs in a throwaway repo (build numbers, commits ahead, buildOf), then GET /api/version and the ws 'version'
// frame on a real server.mjs (spare port, temp data dir, no orchestrator): the running build is `git rev-list --count
// HEAD` of this checkout and carries a startedAt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createVersion, readBuild, commitsAhead, formatVersion } from '../version.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'version-test-password';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-version-'));
let child;
after(() => { child?.kill('SIGKILL'); fs.rmSync(tmp, { recursive: true, force: true }); });

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

test('formatVersion: v<build / 100>.<build % 100, two digits>', () => {
  assert.equal(formatVersion(352), 'v3.52');
  assert.equal(formatVersion(709), 'v7.09');
  assert.equal(formatVersion(5), 'v0.05');
  assert.equal(formatVersion(1000), 'v10.00');
  assert.equal(formatVersion(null), null);
});

test('build numbers and commits ahead in a temp repo', async () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  const commit = (msg) => { fs.writeFileSync(path.join(repo, 'f.txt'), msg); g('add', '.'); g('commit', '-qm', msg); return g('rev-parse', 'HEAD'); };
  g('init', '-q');
  commit('one'); const second = commit('two'); commit('three');
  assert.equal(await readBuild(path.join(tmp)), null, 'not a checkout');

  const v = createVersion({ dir: repo });
  await v.ready;
  const r = v.running();
  assert.equal(r.build, 3);
  assert.equal(r.version, 'v0.03');
  assert.equal(r.sha, g('rev-parse', 'HEAD'));
  assert.equal(r.subject, 'three');
  assert.ok(Math.abs(r.committedAt - Date.now()) < 60e3);
  assert.ok(r.startedAt > 0 && r.startedAt <= Date.now());
  assert.deepEqual(await v.disk(), { build: 3, version: 'v0.03', sha: r.sha, subject: 'three', ahead: 0 });

  commit('four'); const head = commit('five: the newest');
  assert.deepEqual(await v.disk(), { build: 5, version: 'v0.05', sha: head, subject: 'five: the newest', ahead: 2 });
  assert.equal(v.running().build, 3, 'the running build is fixed at boot');
  assert.equal(await commitsAhead(repo, second, head), 3);
  assert.equal(await commitsAhead(repo, '', head), 0);

  // boot: an older commit (what AGENT_ORCH_BOOT_COMMIT sets) is the running build.
  const old = createVersion({ dir: repo, boot: second });
  await old.ready;
  assert.equal(old.running().build, 2);
  assert.equal((await old.disk()).ahead, 3);
  // buildOf: counted lazily for another machine's sha.
  assert.equal(old.buildOf('nope'), null);
  assert.equal(old.buildOf(second), 2);
  old.buildOf(head);
  await waitFor(() => old.buildOf(head) === 5, { timeout: 5000, message: 'buildOf(head)' });
});

test('GET /api/version and the ws version frame report the running build', async () => {
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  assert.notEqual(port, 3000);
  const base = `http://127.0.0.1:${port}`;
  const before = Date.now();
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1', AGENT_ORCH_BOOT_COMMIT: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });

  const unauth = await fetch(base + '/api/version');
  assert.equal(unauth.status, 401);
  await unauth.arrayBuffer();
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await login.arrayBuffer();

  const count = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim());
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const r = await fetch(base + '/api/version', { headers: { cookie } });
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.equal(v.running.build, count);
  assert.equal(v.running.version, formatVersion(count));
  assert.match(v.running.version, /^v\d+\.\d\d$/);
  assert.equal(v.running.sha, sha);
  assert.equal(typeof v.running.subject, 'string');
  assert.equal(typeof v.running.committedAt, 'number');
  assert.equal(typeof v.running.startedAt, 'number');
  assert.ok(v.running.startedAt <= Date.now() && v.running.startedAt > before - 60e3, `startedAt ${v.running.startedAt}`);
  assert.deepEqual(v.disk, { build: count, version: formatVersion(count), sha, subject: v.running.subject, ahead: 0 });
  assert.deepEqual(v.restart, { pending: false, reason: null, auto: false });

  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie } });
  const frame = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no version frame')), 10000);
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'version') { clearTimeout(timer); resolve(m); } });
    ws.on('error', reject);
  });
  ws.terminate();
  assert.equal(frame.running.build, count);
  assert.equal(frame.running.startedAt, v.running.startedAt);
});
