// POST /api/restart-when-idle: auth-gated, and with nothing running the server drains and exits 0.
// Runs its own server.mjs on a spare port and throwaway data dir; never the live one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'restart-test-password';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-restart-'));
let child;

after(() => {
  child?.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

test('restart-when-idle rejects unauthenticated calls, then drains and exits 0', async () => {
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  assert.notEqual(port, 3000);
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    exited.then((code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });

  const unauth = await fetch(base + '/api/restart-when-idle', { method: 'POST' });
  assert.equal(unauth.status, 401);
  await unauth.arrayBuffer();
  assert.equal(child.exitCode, null);

  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await login.arrayBuffer();
  const st = await (await fetch(base + '/api/status', { headers: { cookie } })).json();
  assert.equal(st.restartPending, false);
  assert.equal(typeof st.commitsSinceBoot, 'number');

  const c = await fetch(base + '/api/restart-when-idle', { method: 'POST', headers: { cookie }, body: JSON.stringify({ cancel: true }) });
  assert.equal(c.status, 200);
  assert.deepEqual(await c.json(), { draining: false });
  assert.equal(child.exitCode, null);

  const r = await fetch(base + '/api/restart-when-idle', { method: 'POST', headers: { cookie } });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { draining: true });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const code = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, `server exited with ${code}:\n${out}`);
  assert.match(out, /\[restart\]/);
});

// autoRestart: with the boot commit set before the latest server.mjs change, the poll drains and exits 0 once the
// owner turns the setting on, and stays up while it's off.
const bootBeforeServerChange = () => new Promise((resolve, reject) => {
  const g = spawn('git', ['log', '-2', '--format=%H', '--', 'server.mjs'], { cwd: ROOT });
  let o = '';
  g.stdout.on('data', (d) => { o += d; });
  g.on('exit', () => {
    const latest = o.trim().split('\n')[0];
    if (!latest) return reject(new Error('no commit touched server.mjs'));
    const p = spawn('git', ['rev-parse', `${latest}^`], { cwd: ROOT });
    let r = '';
    p.stdout.on('data', (d) => { r += d; });
    p.on('exit', (code) => (code === 0 ? resolve(r.trim()) : reject(new Error('no parent commit'))));
  });
});

async function bootServer(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-autorestart-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  assert.notEqual(port, 3000);
  const proc = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dir, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const s = { proc, dir, base: `http://127.0.0.1:${port}`, out: '' };
  s.exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  after(() => { proc.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${s.out}`)), 20000);
    const onData = (d) => { s.out += d; if (s.out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    s.exited.then((code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${s.out}`)); });
  });
  const login = await fetch(s.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  s.cookie = login.headers.get('set-cookie').split(';')[0];
  await login.arrayBuffer();
  return s;
}

test('autoRestart drains and exits 0 after server code changed since boot; stays up while off', async () => {
  const env = { AGENT_ORCH_BOOT_COMMIT: await bootBeforeServerChange(), AGENT_ORCH_RESTART_POLL_MS: '200' };
  const off = await bootServer(env);
  const on = await bootServer(env);

  const bad = await fetch(on.base + '/api/orch/parallel', { method: 'PUT', headers: { cookie: on.cookie }, body: JSON.stringify({ autoRestart: 'yes' }) });
  assert.equal(bad.status, 400);
  await bad.arrayBuffer();
  const put = await fetch(on.base + '/api/orch/parallel', { method: 'PUT', headers: { cookie: on.cookie }, body: JSON.stringify({ autoRestart: true }) });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).state.parallel.autoRestart, true);

  const timer = setTimeout(() => on.proc.kill('SIGKILL'), 10000);
  const code = await on.exited;
  clearTimeout(timer);
  assert.equal(code, 0, `server exited with ${code}:\n${on.out}`);
  assert.match(on.out, /\[restart\] auto:/);

  // The off server has polled all along (≥ 1 s at 200 ms) without restarting.
  const st = await (await fetch(off.base + '/api/status', { headers: { cookie: off.cookie } })).json();
  assert.equal(st.restartPending, false);
  assert.equal(off.proc.exitCode, null);
  assert.doesNotMatch(off.out, /\[restart\]/);
});
