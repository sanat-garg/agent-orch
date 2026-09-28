// Rolling restart, server half (#426): with Apply updates at its default ('auto') and server code changed since boot,
// server.mjs preflights the new code, exits 0 on its own and records the restart; the process started next reports
// "Updated to vX.YY" in /api/status. "Restart now" is auth-gated. Runs its own server.mjs on spare ports and throwaway
// data dirs; never the live one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatVersion } from '../version.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'rolling-test-password';
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

async function boot(dir, extraEnv = {}) {
  const port = await freePort();
  assert.notEqual(port, 3000);
  const proc = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dir, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const s = { proc, base: `http://127.0.0.1:${port}`, out: '' };
  s.exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  after(() => proc.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${s.out}`)), 20000);
    const onData = (d) => { s.out += d; if (s.out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    s.exited.then((code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${s.out}`)); });
  });
  return s;
}
async function login(s) {
  const r = await fetch(s.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  await r.arrayBuffer();
  return r.headers.get('set-cookie').split(';')[0];
}

test('by default new server code restarts the server on its own, and the next boot reports the update', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rolling-srv-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const latest = git('log', '-1', '--format=%H', '--', 'server.mjs');
  const a = await boot(dir, { AGENT_ORCH_BOOT_COMMIT: git('rev-parse', `${latest}^`), AGENT_ORCH_RESTART_POLL_MS: '200', AGENT_ORCH_ROLLING_DELAY_MS: '1500' });

  const unauth = await fetch(a.base + '/api/restart-now', { method: 'POST' });
  assert.equal(unauth.status, 401);
  await unauth.arrayBuffer();
  const cookie = await login(a);
  const st = await (await fetch(a.base + '/api/status', { headers: { cookie } })).json();
  assert.equal(st.applyUpdates, 'auto');

  const timer = setTimeout(() => a.proc.kill('SIGKILL'), 60000);
  const code = await a.exited;
  clearTimeout(timer);
  assert.equal(code, 0, `server exited with ${code}:\n${a.out}`);
  assert.match(a.out, /\[restart\] rolling: \d+ server file\(s\) changed since boot/);
  assert.match(a.out, /\[restart\] rolling: exiting for restart/);
  const head = git('rev-parse', 'HEAD');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'restart.json'), 'utf8'));
  assert.equal(rec.to, head);
  assert.equal(rec.version, formatVersion(Number(git('rev-list', '--count', head))).slice(1));

  // The process systemd starts next: "Updated to vX.YY" for its clients, and nothing more to apply.
  const b = await boot(dir, { AGENT_ORCH_RESTART_POLL_MS: '200' });
  const bst = await (await fetch(b.base + '/api/status', { headers: { cookie: await login(b) } })).json();
  assert.equal(bst.updated?.version, rec.version);
  assert.equal(bst.update, null);
  assert.equal(bst.restartPending, false);
  assert.equal(b.proc.exitCode, null);
});
