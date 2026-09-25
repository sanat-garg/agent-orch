// A convo's cached repo link is replaced by its folder's real git origin at startup (and cleared without one).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'repo-link-password';
let child, base, dataDir, moved, noRemote;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const stale = { full: 'sanat-garg/claude-web', url: 'https://github.com/sanat-garg/claude-web' };

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-repo-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  moved = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-moved-'));
  noRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-noremote-'));
  for (const d of [moved, noRemote]) execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/sanat-garg/agent-orch.git'], { cwd: moved });
  const now = Date.now();
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([
    { id: 'c-moved', title: path.basename(moved), cwd: moved, mode: 'bypassPermissions', fullAccess: true, model: '', createdAt: now, updatedAt: now, repo: stale },
    { id: 'c-noremote', title: path.basename(noRemote), cwd: noRemote, mode: 'bypassPermissions', fullAccess: true, model: '', createdAt: now, updatedAt: now, repo: stale },
  ]));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
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
  for (const d of [dataDir, moved, noRemote]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test('a stale convo.repo is replaced by the git origin, and cleared without a remote', async () => {
  const ok = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  const convos = await (await fetch(base + '/api/convos', { headers: { cookie } })).json();
  const byId = Object.fromEntries(convos.map((c) => [c.id, c]));
  assert.deepEqual(byId['c-moved'].repo, { full: 'sanat-garg/agent-orch', url: 'https://github.com/sanat-garg/agent-orch' });
  assert.equal(byId['c-noremote'].repo, undefined);
  const away = await (await fetch(base + '/api/away?since=0', { headers: { cookie } })).json();
  assert.deepEqual(away.repos, { [moved]: 'https://github.com/sanat-garg/agent-orch' });
  // Persisted, so the next start (and the orchestrator) sees the refreshed value too.
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'convos.json'), 'utf8'));
  assert.equal(saved.find((c) => c.id === 'c-moved').repo.full, 'sanat-garg/agent-orch');
  assert.equal(saved.find((c) => c.id === 'c-noremote').repo, undefined);
});
