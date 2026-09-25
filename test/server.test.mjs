// Smoke test: boots server.mjs on a spare port against a throwaway data dir and checks the login gate.
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
const PASSWORD = 'smoke-test-password';
let child, base, dataDir, binDir;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const get = (p, headers = {}) => fetch(base + p, { redirect: 'manual', headers });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  // A logged-out `codex` on PATH (the stub answers `codex login status` with "Not logged in").
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-bin-'));
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/codex-stub.mjs'), path.join(binDir, 'codex'));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CODEX_STUB_LOGIN: 'out', PORT: String(port), CW_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (binDir) fs.rmSync(binDir, { recursive: true, force: true });
});

test('GET / without a session redirects to the login page', async () => {
  const r = await get('/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login');
  const login = await get('/login');
  assert.equal(login.status, 200);
  assert.match(await login.text(), /<form|password/i);
});

test('public static assets are served without a session', async () => {
  for (const p of ['/login.css', '/icon.svg', '/manifest.webmanifest']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    await r.arrayBuffer();
  }
});

test('protected API routes return 401 without a session', async () => {
  for (const p of ['/api/convos', '/api/status']) {
    const r = await get(p);
    assert.equal(r.status, 401, p);
    await r.arrayBuffer();
  }
});

test('login rejects a wrong password and accepts the right one', async () => {
  const post = (password) => fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const bad = await post('not-the-password');
  assert.equal(bad.status, 401);
  await bad.arrayBuffer();
  const ok = await post(PASSWORD);
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^cw_session=./);
  const home = await get('/', { cookie });
  assert.equal(home.status, 200);
  await home.arrayBuffer();
});

test('a malformed cookie does not crash the server (AUDIT #1)', async () => {
  const bad = await get('/api/status', { cookie: 'cw_session=%E0%A4%A' });
  assert.equal(bad.status, 401);
  await bad.arrayBuffer();
  // The WebSocket upgrade path parses cookies too; fetch can't send upgrade headers, so use a raw socket.
  const reply = await new Promise((resolve) => {
    const s = net.connect(Number(new URL(base).port), '127.0.0.1', () => s.write('GET /ws HTTP/1.1\r\nHost: x\r\nCookie: cw_session=%E0%A4%A\r\n'
      + 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
    let buf = '';
    s.on('data', (d) => { buf += d; });
    s.on('close', () => resolve(buf));
    s.on('error', () => {});
  });
  assert.match(reply, /^HTTP\/1\.1 401/);
  assert.equal(child.exitCode, null);
  const ok = await get('/login');
  assert.equal(ok.status, 200);
  await ok.arrayBuffer();
});

test('GET /api/agents lists the agent registry, including claude', async () => {
  const unauth = await get('/api/agents');
  assert.equal(unauth.status, 401);
  await unauth.arrayBuffer();
  const ok = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  await ok.arrayBuffer();
  const r = await get('/api/agents', { cookie });
  assert.equal(r.status, 200);
  const { agents } = await r.json();
  const claude = agents.find((a) => a.id === 'claude');
  assert.ok(claude, 'claude is listed');
  assert.equal(claude.label, 'Claude Code');
  assert.equal(typeof claude.available, 'boolean');
  assert.ok(claude.models.includes('opus'));
  for (const a of agents) assert.ok(a.login, `${a.id} has a login hint`);
  for (const a of agents) assert.equal(typeof a.loggedIn, 'boolean', `${a.id} reports loggedIn`);
  const codex = agents.find((a) => a.id === 'codex');
  assert.equal(codex.available, true);
  assert.equal(codex.loggedIn, false);
});
