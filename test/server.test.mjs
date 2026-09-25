// Smoke test: boots server.mjs on a spare port against a throwaway data dir and checks the login gate.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

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
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CODEX_STUB_LOGIN: 'out', CW_WS_KEEPALIVE_MS: '200', PORT: String(port), CW_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
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

test('a parallel burst of wrong passwords cannot bypass the login lockout (AUDIT #8)', async () => {
  // A fake client IP (trusted X-Forwarded-For) so the lockout doesn't hit the other tests on 127.0.0.1.
  // Headers go out first and bodies only once all are in flight, so every request passes the pre-body check.
  // The 11th request carries the right password; its body lands last, after the lock, so it must not be tested.
  const pws = [...Array(10).fill('wrong'), PASSWORD];
  const reqs = pws.map((password) => {
    const body = JSON.stringify({ password });
    const r = http.request(base + '/api/login', { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-forwarded-for': '203.0.113.8' } });
    r.body = body;
    return r;
  });
  const done = reqs.map((r) => new Promise((resolve, reject) => r.on('response', (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
  }).on('error', reject)));
  reqs.forEach((r) => r.flushHeaders());
  await new Promise((r) => setTimeout(r, 300));
  reqs.slice(0, 10).forEach((r) => r.end(r.body));
  const rs = await Promise.all(done.slice(0, 10));
  reqs[10].end(reqs[10].body);
  const last = await done[10];
  const wrong = rs.filter((r) => r.status === 401 && r.body.error === 'wrong').length;
  const locked = rs.filter((r) => r.status === 429 && r.body.error === 'locked').length;
  assert.ok(wrong <= 5, `${wrong} parallel attempts got a 'wrong password' answer`);
  assert.equal(wrong + locked, 10);
  assert.equal(last.status, 429, 'a right password in the same burst must be refused once locked');
});

test('an oversized login body gets a 413 or a closed connection, not a hang (AUDIT #14)', async () => {
  const body = Buffer.alloc(2e6, 'a');
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('oversized request hung for 3 s')), 3000);
    const settle = (v) => { clearTimeout(timer); resolve(v); };
    const r = http.request(base + '/api/login', { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': body.length, 'x-forwarded-for': '203.0.113.14' } });
    r.on('response', (res) => { res.resume(); settle(res.statusCode); });
    r.on('error', () => settle('closed'));
    r.on('close', () => settle('closed'));
    r.end(body);
  });
  assert.ok(outcome === 413 || outcome === 'closed', `oversized body answered ${outcome}`);
  const bad = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.14' }, body: '{not json' });
  assert.equal(bad.status, 400);
  await bad.arrayBuffer();
  assert.equal(child.exitCode, null);
  const ok = await get('/login');
  assert.equal(ok.status, 200);
  await ok.arrayBuffer();
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
  for (const a of agents) {
    assert.ok(Array.isArray(a.models), `${a.id} lists models`);
    for (const m of a.models) assert.ok(m.id && m.label, `${a.id} model has id and label`);
    if (!a.models.length) assert.ok(a.modelsError, `${a.id} says why it has no models`);
  }
  for (const a of agents) assert.ok(a.login, `${a.id} has a login hint`);
  for (const a of agents) assert.equal(typeof a.loggedIn, 'boolean', `${a.id} reports loggedIn`);
  const codex = agents.find((a) => a.id === 'codex');
  assert.equal(codex.available, true);
  assert.equal(codex.loggedIn, false);
  // Signed out: no models, never placeholders (discovery runs at boot; 'loading' only until it finishes).
  assert.deepEqual(codex.models, []);
  assert.match(codex.modelsError, /not signed in|loading/);
});

test('boot discovery caches every agent in models.json; a signed-out agent is stored empty with the reason', async () => {
  const file = path.join(dataDir, 'models.json');
  let saved = null;
  for (let i = 0; i < 150 && !saved; i++) {
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  assert.ok(saved, 'models.json written');
  assert.ok(saved.saved > 0);
  assert.deepEqual(Object.keys(saved.agents).sort(), ['antigravity', 'claude', 'codex']);
  assert.deepEqual(saved.agents.codex.models, []);
  assert.equal(saved.agents.codex.error, 'not signed in');
  assert.ok(saved.agents.codex.at > 0);
});

test('GET /api/connections lists claude, codex, antigravity and github; actions are login-protected', async () => {
  const unauth = await get('/api/connections');
  assert.equal(unauth.status, 401);
  await unauth.arrayBuffer();
  const ok = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  await ok.arrayBuffer();
  const r = await get('/api/connections', { cookie });
  assert.equal(r.status, 200);
  const { connections } = await r.json();
  assert.deepEqual(connections.map((c) => c.id), ['claude', 'codex', 'antigravity', 'github']);
  for (const c of connections) {
    assert.equal(typeof c.installed, 'boolean', `${c.id} reports installed`);
    assert.equal(typeof c.signedIn, 'boolean', `${c.id} reports signedIn`);
    assert.equal(c.login, null, `${c.id} has no login in progress`);
  }
  const codex = connections.find((c) => c.id === 'codex');
  assert.deepEqual([codex.installed, codex.signedIn, codex.canLogin, codex.canLogout], [true, false, true, true]);
  const post = (p, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  const anon = await post('/api/connections/codex/cancel');
  assert.equal(anon.status, 401);
  await anon.arrayBuffer();
  const claude = connections.find((c) => c.id === 'claude'), agy = connections.find((c) => c.id === 'antigravity');
  assert.deepEqual([claude.canLogin, claude.canLogout, agy.canLogin, agy.canLogout], [true, true, true, false]);
  assert.match(claude.logoutWarning, /Every chat and orchestrator agent/);
  const nope = await post('/api/connections/claude/logout', { cookie });
  assert.equal(nope.status, 409); // needs {confirm: true}: nothing is signed out
  assert.equal((await nope.json()).needsConfirm, true);
  const code = await post('/api/connections/codex/code', { cookie });
  assert.equal(code.status, 409); // no sign-in in progress
  await code.arrayBuffer();
});

test('WebSockets of removed or expired sessions close with 4001 (AUDIT #9)', async () => {
  const login = async () => {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    await r.arrayBuffer();
    return r.headers.get('set-cookie').split(';')[0];
  };
  const open = async (cookie) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie } });
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    return ws;
  };
  const [gone, stale, kept] = await Promise.all([login(), login(), login()]);
  const sockets = await Promise.all([gone, stale, kept].map(open));
  // Rewrite sessions.json from outside, like `set-password` does: drop one session, expire another.
  const file = path.join(dataDir, 'sessions.json');
  const sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tok = (c) => decodeURIComponent(c.slice(c.indexOf('=') + 1));
  delete sessions[tok(gone)];
  sessions[tok(stale)].exp = Date.now() - 1000;
  fs.writeFileSync(file, JSON.stringify(sessions));
  const timeout = (ms) => new Promise((r) => setTimeout(() => r('open'), ms));
  assert.equal(await Promise.race([sockets[0].closed, timeout(3000)]), 4001, 'removed session');
  assert.equal(await Promise.race([sockets[1].closed, timeout(3000)]), 4001, 'expired session');
  assert.equal(await Promise.race([sockets[2].closed, timeout(500)]), 'open', 'a valid session stays connected');
  sockets[2].close();
});

test('the served app wires the "Restart when idle" banner to its endpoint', async () => {
  const ok = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  const js = await get('/app.js', { cookie });
  assert.equal(js.status, 200);
  assert.match(await js.text(), /\/api\/restart-when-idle/);
  assert.match(await (await get('/', { cookie })).text(), /id="updateBanner"/);
});

test('GET /api/media/:id serves stored images to signed-in users only, with strict ids', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const id = `${crypto.createHash('sha256').update(png).digest('hex')}.png`;
  fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'media', id), png);
  const unauth = await get(`/api/media/${id}`);
  assert.equal(unauth.status, 401);
  await unauth.arrayBuffer();
  const ok = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  await ok.arrayBuffer();
  const r = await get(`/api/media/${id}`, { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('cache-control'), /max-age=31536000/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  const missing = await get(`/api/media/${'0'.repeat(64)}.png`, { cookie });
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
  for (const bad of [id.toUpperCase(), `${id.slice(0, -4)}.svg`, 'abc.png', `${id}x`, `..%2F..%2Fauth.json`, `..%2fsessions.json`, `%2e%2e%2F${id}`]) {
    const b = await get(`/api/media/${bad}`, { cookie });
    assert.equal(b.status, 400, bad);
    await b.arrayBuffer();
  }
  // A literal '../' (sent raw; fetch would normalise it) never reaches the data dir.
  const raw = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: Number(new URL(base).port), path: '/api/media/../../auth.json', headers: { cookie } }, (res) => {
      let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.notEqual(raw.status, 200);
  assert.doesNotMatch(raw.body, /salt|hash/);
});

test('GET /api/usage/history is login-protected and returns per-agent series', async () => {
  const unauth = await get('/api/usage/history?range=24h');
  assert.equal(unauth.status, 401);
  await unauth.arrayBuffer();
  // A window name no real reading uses: this test server may record the live Claude windows itself.
  const now = Date.now();
  const recs = [
    { t: now - 3600e3, agent: 'codex', kind: 'tokens', input: 10, output: 2, cached: 5, source: 'task', ref: 1 },
    { t: now - 1800e3, agent: 'claude', kind: 'window', window: 'test_window', pct: 42, resetsAt: Math.round(now / 1000) + 3600 },
    { t: now - 600e3, agent: 'codex', kind: 'limit', status: 'hit', resetsAt: Math.round(now / 1000) + 7200 },
  ];
  fs.mkdirSync(path.join(dataDir, 'metrics'), { recursive: true });
  fs.appendFileSync(path.join(dataDir, 'metrics', 'usage.jsonl'), recs.map((r) => JSON.stringify(r) + '\n').join(''));
  const ok = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  await ok.arrayBuffer();
  const r = await get('/api/usage/history?range=7d', { cookie });
  assert.equal(r.status, 200);
  const h = await r.json();
  assert.equal(h.range, '7d');
  assert.equal(h.bucketMs, 86400e3);
  assert.equal(h.agents.claude.windows.test_window[0].pct, 42);
  assert.equal(h.agents.claude.status.windows.test_window.pct, 42);
  assert.equal(h.agents.codex.tokens.reduce((s, b) => s + b.input, 0), 10);
  assert.equal(h.agents.codex.limits[0].status, 'hit');
  assert.equal(h.agents.codex.status.blocked, true);
  const bad = await get('/api/usage/history?range=1y', { cookie });
  assert.equal(bad.status, 400);
  await bad.arrayBuffer();
});
