// Many-MacBook pairing (cluster.mjs): one multi-use code pairs up to N machines within an hour, each with its own node,
// token and a unique name; a one-time code still pairs one machine within 10 minutes. Codes expire, can be revoked and
// survive a controller restart (stored as hashes). Then the "Add machine" API over HTTP (POST {uses}, GET, DELETE) and
// the name a Mac pairs under (worker.mjs macName).
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCluster } from '../cluster.mjs';
import { CLAIM_PATH, PAIR_PATH, PAIRING_TTL_MS, PAIRING_MULTI_TTL_MS, MAX_PAIRING_USES } from '../cluster-protocol.mjs';
import { defaultName, macName } from '../worker.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'macos-pairing-password';
let tmp;
const hubs = [];
const hub = (file = 'hub.db') => { const h = createCluster({ dbFile: path.join(tmp, file) }); hubs.push(h); return h; };
const mac = (code, name) => ({ code, name, os: 'darwin', arch: 'arm64' });

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-macos-pair-')); });
after(() => {
  mock.timers.reset();
  for (const h of hubs) { try { h.close(); } catch {} }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a multi-use code pairs up to N machines, each with its own node, token and unique name, then refuses more', () => {
  const h = hub();
  const t0 = Date.now(), p = h.createPairing({ uses: 3 }), t1 = Date.now(); // the clock may tick during the call
  assert.match(p.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.deepEqual([p.uses, p.used, p.nodes], [3, 0, []]);
  assert.ok(p.expiresAt >= t0 + PAIRING_MULTI_TTL_MS && p.expiresAt <= t1 + PAIRING_MULTI_TTL_MS && PAIRING_MULTI_TTL_MS === 3600e3, 'valid 1 hour');
  const a = h.claim(mac(p.code, 'MacBook Pro (Sanat-MBP)'));
  const b = h.claim(mac(p.code.toLowerCase().replace('-', ''), 'MacBook Air (Sanat-MBA)'));
  assert.deepEqual(h.pairing(p.code), { state: 'waiting', expiresAt: p.expiresAt, uses: 3, used: 2, nodes: [h.node(a.node), h.node(b.node)] });
  const c = h.claim(mac(p.code, 'MacBook Pro (Sanat-MBP)')); // two Macs with the same host name
  assert.equal(new Set([a.node, b.node, c.node]).size, 3);
  assert.equal(new Set([a.token, b.token, c.token]).size, 3);
  assert.deepEqual([a.name, b.name, c.name], ['MacBook Pro (Sanat-MBP)', 'MacBook Air (Sanat-MBA)', 'MacBook Pro (Sanat-MBP) 2']);
  const full = h.claim(mac(p.code, 'MacBook Pro (Sanat-MBP-4)'));
  assert.equal(full.status, 401);
  assert.match(full.error, /already used by 3 machines/);
  const v = h.pairing(p.code);
  assert.deepEqual([v.state, v.used, v.nodes.map((n) => n.name)], ['paired', 3, [a.name, b.name, c.name]]);
  assert.equal(JSON.stringify(v).includes('token'), false, 'no token or hash in the view');
  // Renaming later keeps the node; the owner's name wins.
  assert.equal(h.update(c.node, { name: 'Studio MacBook' }).node.name, 'Studio MacBook');
});

test('a one-time code still pairs exactly one machine; bad use counts are refused', () => {
  const h = hub();
  const t0 = Date.now(), p = h.createPairing(), t1 = Date.now();
  assert.equal(p.uses, undefined);
  assert.ok(p.expiresAt >= t0 + PAIRING_TTL_MS && p.expiresAt <= t1 + PAIRING_TTL_MS, 'valid 10 minutes');
  assert.deepEqual(h.pairing(p.code), { state: 'waiting', expiresAt: p.expiresAt });
  const a = h.claim(mac(p.code, 'mini'));
  assert.match(a.token, /^aon_/);
  assert.match(h.claim(mac(p.code, 'second')).error, /already used/);
  assert.deepEqual(h.pairing(p.code), { state: 'paired', expiresAt: p.expiresAt, node: h.node(a.node) });
  for (const uses of [0, MAX_PAIRING_USES + 1, 2.5, '4']) assert.equal(h.createPairing({ uses }).status, 400, String(uses));
  assert.equal(h.createPairing({ uses: MAX_PAIRING_USES }).uses, MAX_PAIRING_USES);
  assert.equal(h.claim(mac('ZZZZ-ZZZZ', 'x')).status, 401);
});

test('multi-use codes expire after an hour, one-time codes after 10 minutes', () => {
  const h = hub();
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const multi = h.createPairing({ uses: 4 }), once = h.createPairing();
    assert.equal(h.claim(mac(multi.code, 'MacBook Pro (one)')).name, 'MacBook Pro (one)');
    mock.timers.tick(PAIRING_TTL_MS + 1000);
    const late = h.claim(mac(once.code, 'late'));
    assert.deepEqual([late.status, h.pairing(once.code).state], [401, 'expired']);
    assert.match(late.error, /expired/);
    assert.equal(h.claim(mac(multi.code, 'MacBook Pro (two)')).name, 'MacBook Pro (two)', 'still valid after 10 minutes');
    mock.timers.tick(PAIRING_MULTI_TTL_MS - PAIRING_TTL_MS);
    const r = h.claim(mac(multi.code, 'MacBook Pro (three)'));
    assert.equal(r.status, 401);
    assert.match(r.error, /expired/);
    const v = h.pairing(multi.code);
    assert.deepEqual([v.state, v.used, v.nodes.map((n) => n.name)], ['expired', 2, ['MacBook Pro (one)', 'MacBook Pro (two)']], 'the machines that paired stay listed');
  } finally { mock.timers.reset(); }
});

test('a revoked code pairs no more machines; the ones that paired stay', () => {
  const h = hub();
  const p = h.createPairing({ uses: 4 });
  const a = h.claim(mac(p.code, 'MacBook Pro (kept)'));
  const v = h.revokePairing(p.code);
  assert.deepEqual([v.state, v.used, v.uses], ['revoked', 1, 4]);
  const r = h.claim(mac(p.code, 'MacBook Pro (refused)'));
  assert.equal(r.status, 401);
  assert.match(r.error, /revoked/);
  assert.equal(h.node(a.node).name, 'MacBook Pro (kept)');
  assert.equal(h.revokePairing('ZZZZ-ZZZZ').status, 404);
});

test('codes survive a controller restart and only their hashes are stored', () => {
  const first = hub('restart.db');
  const p = first.createPairing({ uses: 2 });
  first.claim(mac(p.code, 'MacBook Pro (before)'));
  first.close();
  const again = hub('restart.db');
  const b = again.claim(mac(p.code, 'MacBook Pro (after)'));
  assert.equal(b.name, 'MacBook Pro (after)');
  assert.deepEqual([again.pairing(p.code).state, again.pairing(p.code).used], ['paired', 2]);
  const db = fs.readFileSync(path.join(tmp, 'restart.db'));
  assert.ok(!db.includes(p.code) && !db.includes(p.code.replace('-', '')) && !db.includes(b.token), 'no plain code or token on disk');
});

test('a Mac pairs as "<model> (<local host name>)"; elsewhere as its short hostname', async () => {
  const hw = 'Hardware:\n\n    Hardware Overview:\n\n      Model Name: MacBook Pro\n      Model Identifier: Mac15,7\n      Chip: Apple M3 Pro\n';
  assert.equal(macName(hw, 'Sanat-MBP-2'), 'MacBook Pro (Sanat-MBP-2)');
  assert.equal(macName('', 'Sanat-MBA'), 'Mac (Sanat-MBA)');
  if (process.platform !== 'darwin') assert.equal(await defaultName(), os.hostname().split('.')[0]);
});

// ---- the HTTP API (server.mjs, no orchestrator loop)
let child, base, dataDir, cookie;
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const call = async (p, method = 'GET', body, auth = true) => {
  const r = await fetch(base + p, { method, headers: { ...(auth ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

test('Add machine API: POST {uses} makes a multi-use code, GET follows it, DELETE revokes it', { timeout: 60000 }, async (t) => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-macos-api-'));
  t.after(() => { child?.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1', AGENT_ORCH_MEMINFO: path.join(ROOT, 'test/fixtures/meminfo-ample') } });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = login.headers.get('set-cookie').split(';')[0];

  assert.equal((await call(PAIR_PATH, 'POST', { uses: 4 }, false)).status, 401);
  assert.equal((await call(PAIR_PATH, 'POST', { uses: 99 })).status, 400);
  const { status, body: p } = await call(PAIR_PATH, 'POST', { uses: 4 });
  assert.equal(status, 200);
  assert.deepEqual([p.uses, p.used], [4, 0]);
  const claim = (name) => call(CLAIM_PATH, 'POST', mac(p.code, name), false);
  assert.equal((await claim('MacBook Pro (one)')).status, 200);
  assert.equal((await claim('MacBook Pro (two)')).status, 200);
  const v = (await call(`${PAIR_PATH}/${p.code}`)).body;
  assert.deepEqual([v.state, v.used, v.nodes.map((n) => n.name)], ['waiting', 2, ['MacBook Pro (one)', 'MacBook Pro (two)']]);
  assert.equal((await call(`${PAIR_PATH}/${p.code}`, 'DELETE', undefined, false)).status, 401);
  assert.equal((await call(`${PAIR_PATH}/${p.code}`, 'DELETE')).body.state, 'revoked');
  assert.equal((await claim('MacBook Pro (three)')).status, 401);
  assert.equal((await call(`${PAIR_PATH}/ZZZZ-ZZZZ`, 'DELETE')).status, 404);
  const names = (await call('/api/cluster/nodes')).body.nodes.map((n) => n.name);
  assert.ok(names.includes('MacBook Pro (one)') && names.includes('MacBook Pro (two)') && !names.includes('MacBook Pro (three)'));
});
