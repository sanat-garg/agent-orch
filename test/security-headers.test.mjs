// AUDIT #34: every response forbids framing, and duplicate session cookies resolve to the first one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'security-headers-password';
let child, base, dataDir;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const get = (p, headers = {}) => fetch(base + p, { redirect: 'manual', headers });
const login = async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0].split('=')[1];
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sec-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, CW_NO_ORCHESTRATOR: '1', PORT: String(port), CW_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const assertNoFraming = (r, what) => {
  assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'none'", what);
  assert.equal(r.headers.get('x-frame-options'), 'DENY', what);
};

test('every response forbids framing (AUDIT #34)', async () => {
  const token = await login();
  for (const [p, headers, status] of [['/', {}, 302], ['/', { cookie: `cw_session=${token}` }, 200], ['/login.html', {}, 302], ['/login', {}, 200], ['/login.css', {}, 200], ['/api/status', {}, 401]]) {
    const r = await get(p, headers);
    assert.equal(r.status, status, p);
    assertNoFraming(r, p);
    await r.arrayBuffer();
  }
});

test('with two cw_session cookies the first one wins (AUDIT #34)', async () => {
  const token = await login();
  const ok = await get('/api/status', { cookie: `cw_session=${token}; cw_session=x` });
  assert.equal(ok.status, 200);
  await ok.arrayBuffer();
  // A later (e.g. Domain=sslip.io) cookie can't displace the owner's; nor does a trailing valid one rescue a bad first.
  const bad = await get('/api/status', { cookie: `cw_session=x; cw_session=${token}` });
  assert.equal(bad.status, 401);
  await bad.arrayBuffer();
});
