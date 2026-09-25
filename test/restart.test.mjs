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

  const r = await fetch(base + '/api/restart-when-idle', { method: 'POST', headers: { cookie } });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { draining: true });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const code = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, `server exited with ${code}:\n${out}`);
  assert.match(out, /\[restart\]/);
});
