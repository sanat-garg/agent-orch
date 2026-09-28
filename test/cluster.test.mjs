// Controller cluster hub (cluster.mjs): pairing + claim, bearer-token auth on the worker socket and the extension
// bundle, heartbeat timeout, revocation, and the local 'controller' node in GET /api/cluster/nodes.
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
import { PROTOCOL_VERSION, WS_PATH, PAIR_PATH, CLAIM_PATH, EXT_PATH, createSender, extBundleError } from '../cluster-protocol.mjs';
import { createCluster } from '../cluster.mjs';
import { createAgentShare, wireAgentShare, shareTargets } from '../agent-share.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'cluster-test-password';
const HEARTBEAT_MS = 200; // offline after 3 silent intervals
let child, base, dataDir, cookie, out = '';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const api = (p, { method = 'GET', body, auth = true } = {}) => fetch(base + p, {
  method, headers: { 'content-type': 'application/json', ...(auth ? { cookie } : {}) }, body: body && JSON.stringify(body),
});
const nodes = async () => (await (await api('/api/cluster/nodes')).json()).nodes;
const nodeOf = async (id) => (await nodes()).find((n) => n.id === id);

async function pair(name = 'worker-1', kind = 'linux') {
  const { code } = await (await api(PAIR_PATH, { method: 'POST' })).json();
  const r = await api(CLAIM_PATH, { method: 'POST', auth: false, body: { code, name, os: kind, arch: 'arm64' } });
  assert.equal(r.status, 200);
  return r.json();
}
// Opens the worker socket; resolves {ws, frames} or rejects with the HTTP status of a refused upgrade.
function connect(headers, url = base) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('http', 'ws') + WS_PATH, { headers });
    const frames = [];
    ws.on('message', (d) => frames.push(JSON.parse(d)));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', reject);
  });
}
async function helloed({ node, token }, features, url = base, jobs = []) {
  const c = await connect({ authorization: `Bearer ${token}` }, url);
  const send = createSender('w');
  c.send = (t, f) => c.ws.send(send(t, f));
  c.send('hello', { node, protocol: PROTOCOL_VERSION, version: 'test', jobs, ...(features ? { features } : {}) });
  await waitFor(() => c.frames.find((f) => f.t === 'welcome'), { timeout: 5000 });
  return c;
}
const closed = (ws) => new Promise((resolve) => ws.readyState === WebSocket.CLOSED ? resolve({ code: null }) : ws.on('close', (code) => resolve({ code })));

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cluster-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1', CW_CLUSTER_HEARTBEAT_MS: String(HEARTBEAT_MS),
      AGENT_ORCH_MEMINFO: path.join(ROOT, 'test/fixtures/meminfo-ample') }, // the controller's own slots follow its memory
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
});

after(() => {
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/cluster/nodes lists the local controller node (login required)', async () => {
  assert.equal((await api('/api/cluster/nodes', { auth: false })).status, 401);
  const c = await nodeOf('controller');
  assert.ok(c, 'controller node listed');
  assert.equal(c.local, true);
  assert.equal(c.status, 'online');
  assert.equal(c.os, process.platform);
  assert.ok(c.inventory.cores >= 1 && c.inventory.mem > 0);
  assert.ok(c.resources.memAvailable > 0);
  assert.equal((await api('/api/cluster/nodes/controller', { method: 'DELETE' })).status, 400);
});

test('pairing: login-protected code, single-use claim, token returned once and stored hashed', async () => {
  assert.equal((await api(PAIR_PATH, { method: 'POST', auth: false })).status, 401);
  const { code, expiresAt } = await (await api(PAIR_PATH, { method: 'POST' })).json();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(expiresAt - Date.now() > 9 * 60_000 && expiresAt - Date.now() <= 10 * 60_000);
  const body = { code: code.toLowerCase().replace('-', ''), name: 'mac', os: 'darwin', arch: 'arm64' };
  assert.equal((await api(CLAIM_PATH, { method: 'POST', auth: false, body: { ...body, os: 'windows' } })).status, 400);
  const r = await api(CLAIM_PATH, { method: 'POST', auth: false, body });
  assert.equal(r.status, 200);
  const { node, token } = await r.json();
  assert.match(token, /^aon_/);
  assert.equal((await api(CLAIM_PATH, { method: 'POST', auth: false, body })).status, 401, 'codes are single use');
  const n = await nodeOf(node);
  assert.equal(n.name, 'mac');
  assert.equal(n.status, 'offline');
  const raw = JSON.stringify(await nodes());
  assert.ok(!raw.includes(token) && !raw.includes('token_hash'), 'the token never comes back');
  const db = fs.readFileSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  assert.ok(!db.includes(token), 'only the hash is stored');
});

test('the worker socket refuses missing, unknown and cookie credentials', async () => {
  await assert.rejects(connect({}), { status: 401 });
  await assert.rejects(connect({ authorization: 'Bearer aon_nope' }), { status: 401 });
  await assert.rejects(connect({ cookie }), { status: 401 });
});

test('the extension bundle: its hash follows welcome; GET EXT_PATH needs an enabled node token, never the cookie', async () => {
  const w = await pair('ext-worker');
  // A worker without feature 'ext' (older code) hears nothing about it.
  const old = await helloed(await pair('old-worker'));
  const c = await helloed(w, ['ext']);
  const sync = await waitFor(() => c.frames.find((f) => f.t === 'ext.sync'), { timeout: 5000 });
  assert.ok(c.frames.indexOf(sync) > c.frames.findIndex((f) => f.t === 'welcome'));
  const get = (headers) => fetch(base + EXT_PATH, { headers });
  assert.equal((await get({})).status, 401);
  assert.equal((await get({ cookie })).status, 401);
  assert.equal((await get({ authorization: 'Bearer aon_nope' })).status, 401);
  const r = await get({ authorization: `Bearer ${w.token}` });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-encoding'), 'gzip');
  const b = await r.json();
  assert.equal(extBundleError(b), null);
  assert.equal(b.hash, sync.hash);
  assert.deepEqual(b.mcp, []);
  assert.equal((await api(`/api/cluster/nodes/${w.node}`, { method: 'PATCH', body: { enabled: false } })).status, 200);
  assert.equal((await get({ authorization: `Bearer ${w.token}` })).status, 403, 'a disabled node gets no bundle');
  assert.ok(!old.frames.some((f) => f.t === 'ext.sync'));
  c.ws.close();
  old.ws.close();
});

test('hello/inventory mark a node online; invalid frames get errors; silence marks it offline', async () => {
  const w = await pair('vps-2');
  const c = await helloed(w);
  const welcome = c.frames.find((f) => f.t === 'welcome');
  assert.equal(welcome.node, w.node);
  assert.equal(welcome.heartbeatMs, HEARTBEAT_MS);
  c.send('inventory', { node: w.node, name: 'vps-2', os: 'linux', arch: 'arm64', cores: 4, mem: 24e9, agents: [{ id: 'claude', installed: true, signedIn: true }], versions: {} });
  c.send('resources', { memAvailable: 12e9, load: [0.1, 0.2, 0.3], running: [] });
  c.ws.send('{"t":"job.offer","seq":9,"ts":1,"job":1,"agent":"claude"}'); // controller-only type from a worker
  await waitFor(async () => (await nodeOf(w.node))?.resources?.memAvailable === 12e9, { timeout: 5000 });
  const n = await nodeOf(w.node);
  assert.equal(n.status, 'online');
  assert.equal(n.connected, true);
  assert.equal(n.inventory.cores, 4);
  await waitFor(() => c.frames.find((f) => f.t === 'error' && /may not be sent by the worker/.test(f.message)), { timeout: 5000 });
  // Keep heartbeating for a while: still online. Then go silent (no frames; pongs don't count).
  for (let i = 0; i < 6; i++) { c.send('heartbeat'); await new Promise((r) => setTimeout(r, HEARTBEAT_MS / 2)); }
  assert.equal((await nodeOf(w.node)).status, 'online');
  const t0 = Date.now();
  await closed(c.ws);
  assert.ok(Date.now() - t0 >= HEARTBEAT_MS * 2, 'not dropped before the heartbeat window');
  assert.equal((await nodeOf(w.node)).status, 'offline');
});

test('PATCH edits name, draining and max slots', async () => {
  const w = await pair('laptop');
  const c = await helloed(w);
  const r = await api(`/api/cluster/nodes/${w.node}`, { method: 'PATCH', body: { name: 'MacBook', draining: true, maxSlots: 2 } });
  assert.equal(r.status, 200);
  const n = (await r.json()).node;
  assert.deepEqual([n.name, n.draining, n.maxSlots, n.status], ['MacBook', true, 2, 'draining']);
  assert.equal((await api(`/api/cluster/nodes/${w.node}`, { method: 'PATCH', body: { maxSlots: -1 } })).status, 400);
  assert.equal((await api(`/api/cluster/nodes/${w.node}`, { method: 'PATCH', body: { maxSlots: 0 } })).status, 400);
  // Auto (null): min(cores, (MemAvailable − the 800 MB floor) / 1.2 GB per Claude run) = min(4, 2) here.
  assert.equal((await (await api(`/api/cluster/nodes/${w.node}`, { method: 'PATCH', body: { maxSlots: null } })).json()).node.maxSlots, null);
  c.send('inventory', { node: w.node, name: 'laptop', os: 'linux', arch: 'arm64', cores: 4, mem: 16 * 1024 ** 3, agents: [], versions: {} });
  c.send('resources', { memAvailable: 4 * 1024 ** 3, load: [0.5, 0.4, 0.3], running: [] });
  await waitFor(async () => (await nodeOf(w.node)).resources?.memAvailable === 4 * 1024 ** 3, { timeout: 5000 });
  const m = await nodeOf(w.node);
  assert.deepEqual([m.maxSlots, m.slots, m.used, m.tasks], [null, 2, 0, []]);
  assert.equal((await nodeOf('controller')).slots, 2, "the controller's slots are its own (up to 2 with memory to spare), not its nodes row's 1");
  assert.equal((await (await api(`/api/cluster/nodes/${w.node}`, { method: 'PATCH', body: { enabled: false } })).json()).node.status, 'disabled');
  c.ws.close();
});

test('a Mac that goes silent shows as connection lost (asleep only once it says so); its wake report and a per-node grace period are kept', async () => {
  const w = await pair('macbook', 'darwin');
  let c = await helloed(w);
  assert.equal(c.frames.find((f) => f.t === 'welcome').graceMs, 5 * 60_000, 'a Mac waits 5 min by default');
  assert.equal((await api(`/api/cluster/nodes/${w.node}`, { method: 'PATCH', body: { graceSec: 5 } })).status, 400);
  assert.equal((await (await api(`/api/cluster/nodes/${w.node}`, { method: 'PATCH', body: { graceSec: 600 } })).json()).node.graceMs, 600_000);
  await closed(c.ws); // silent: no heartbeats
  let n = await nodeOf(w.node);
  assert.deepEqual([n.status, n.away, n.awayLabel], ['offline', 'lost', 'connection lost']);
  c = await helloed(w);
  assert.equal(c.frames.find((f) => f.t === 'welcome').graceMs, 600_000);
  c.send('wake', { sleptAt: Date.now() - 90_000, sleptMs: 90_000 });
  await waitFor(async () => (await nodeOf(w.node)).sleptMs === 90_000, { timeout: 5000 });
  n = await nodeOf(w.node);
  assert.deepEqual([n.status, n.away, n.awayLabel], ['online', null, null]);
  assert.deepEqual([n.drops.total, n.drops.by], [1, { asleep: 1 }], 'the wake report makes the drop a sleep, after the fact');
  c.send('bye', { reason: 'shutdown' });
  await closed(c.ws);
  assert.deepEqual([(await nodeOf(w.node)).away, (await nodeOf(w.node)).awayLabel], ['bye', 'shut down']);
});

test('revoking a node closes its socket and its token stops working', async () => {
  const w = await pair('to-remove');
  const c = await helloed(w);
  const done = closed(c.ws);
  assert.equal((await api(`/api/cluster/nodes/${w.node}`, { method: 'DELETE' })).status, 200);
  assert.equal((await done).code, 4003);
  assert.equal(await nodeOf(w.node), undefined);
  await assert.rejects(connect({ authorization: `Bearer ${w.token}` }), { status: 401 });
});

test('disabling a node closes its socket, refuses its token with 403 and stops sharing sign-ins with it', async () => {
  const w = await pair('to-disable');
  const c = await helloed(w);
  const done = closed(c.ws);
  assert.equal((await (await api(`/api/cluster/nodes/${w.node}`, { method: 'PATCH', body: { enabled: false } })).json()).node.status, 'disabled');
  assert.equal((await done).code, 4003);
  await assert.rejects(connect({ authorization: `Bearer ${w.token}` }), { status: 403 });
  assert.equal((await api(`/api/cluster/nodes/${w.node}`, { method: 'PATCH', body: { enabled: true } })).status, 200);
  (await helloed(w)).ws.close();

  // An in-process hub with the real agent-share wiring: a disabled node is no share target and gets no credential.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cluster-share-'));
  const hub = createCluster({ dbFile: path.join(tmp, 'hub.db'), heartbeatMs: HEARTBEAT_MS });
  const share = createAgentShare({ dataDir: path.join(tmp, 'data'), home: path.join(tmp, 'home'), send: (id, f) => hub.send(id, f), targets: shareTargets(hub) });
  wireAgentShare(hub, share);
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    share.setClaudeToken(`sk-ant-oat01-${'x'.repeat(40)}`);
    const n = hub.claim({ code: hub.createPairing().code, name: 'mac', os: 'darwin', arch: 'arm64' });
    const creds = (x) => x.frames.filter((f) => f.t === 'agent.credential' && f.agent === 'claude' && f.value);
    const x = await helloed(n, ['creds'], url, [{ job: 7, state: 'running', next: 0 }]);
    await waitFor(() => creds(x).length, { timeout: 5000 });
    assert.deepEqual(shareTargets(hub)(), [n.node]);
    const gone = closed(x.ws);
    assert.equal(hub.update(n.node, { enabled: false }).node.status, 'disabled');
    assert.equal((await gone).code, 4003);
    assert.deepEqual(x.frames.filter((f) => f.t === 'job.cancel').map((f) => [f.job, f.reason]), [[7, 'disabled']], 'its jobs are cancelled before the close');
    assert.deepEqual(shareTargets(hub)(), []);
    await assert.rejects(connect({ authorization: `Bearer ${n.token}` }, url), { status: 403 });
    const before = creds(x).length;
    share.setClaudeToken(`sk-ant-oat01-${'y'.repeat(40)}`);
    assert.equal(creds(x).length, before, 'a rotation is not sent to it');
  } finally {
    share.close(); hub.close(); server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('health API: telemetry series per node, a log tail fetched over the socket, and Update once idle', async () => {
  const w = await pair('reporter');
  const c = await connect({ authorization: `Bearer ${w.token}` });
  const send = createSender('w');
  c.send = (t, f) => c.ws.send(send(t, f));
  c.ws.on('message', (d) => { const f = JSON.parse(d); if (f.t === 'logs.tail') c.send('logs', { req: f.req, lines: ['line 1', 'line 2', 'line 3'].slice(-f.lines) }); });
  c.send('hello', { node: w.node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [], features: ['logs', 'update'] });
  await waitFor(() => c.frames.find((f) => f.t === 'welcome'), { timeout: 5000 });
  c.send('resources', { memAvailable: 12e9, load: [0.5, 0.4, 0.3], running: [], cpu: [20, 40], disk: { path: '/w', free: 40e9, total: 80e9 } });
  const m = await waitFor(async () => { const r = await (await api(`/api/cluster/nodes/${w.node}/metrics?range=1h`)).json(); return r.samples?.length && r; }, { timeout: 5000 });
  assert.deepEqual([m.node, m.range, m.samples[0].cpu, m.samples[0].cores, m.samples[0].disk], [w.node, '1h', 30, [20, 40], 40e9]);
  assert.ok(fs.existsSync(path.join(dataDir, 'metrics', 'nodes', `${w.node}.jsonl`)));
  assert.equal((await api('/api/cluster/nodes/n_nope/metrics')).status, 404);
  // The controller keeps its own series at the same pace.
  await nodes();
  await new Promise((r) => setTimeout(r, HEARTBEAT_MS + 50));
  await nodes();
  const own = await (await api('/api/cluster/nodes/controller/metrics?range=15m')).json();
  assert.ok(own.samples.length >= 1 && own.samples.at(-1).mem > 0, JSON.stringify(own));
  // The log tail: asked over the socket, answered by the worker.
  assert.deepEqual((await (await api(`/api/cluster/nodes/${w.node}/logs?tail=2`)).json()).lines, ['line 2', 'line 3']);
  assert.equal((await api(`/api/cluster/nodes/${w.node}/logs`, { auth: false })).status, 401);
  assert.equal((await api('/api/cluster/nodes/controller/logs')).status, 400);
  // Update: sent right away because its telemetry lists no running job (no orchestrator here has any placed there).
  const u = await api(`/api/cluster/nodes/${w.node}/update`, { method: 'POST' });
  assert.equal(u.status, 200);
  assert.equal((await u.json()).node.update.state, 'sent');
  await waitFor(() => c.frames.find((f) => f.t === 'node.update'), { timeout: 5000 });
  assert.equal((await api('/api/cluster/nodes/controller/update', { method: 'POST' })).status, 404);
  c.ws.close();
});
