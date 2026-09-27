// Worker health on the controller's hub (cluster.mjs + node-metrics.mjs), driven by fake workers on an in-test
// HTTP/WS server: the telemetry series and its compaction, the log tail round trip over the socket, auto-drain on low
// disk and on lost connections (a Mac's sleep excused), and the version check that sends node.update only once idle.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createCluster } from '../cluster.mjs';
import { createNodeMetrics, compactSamples, METRICS } from '../node-metrics.mjs';
import { PROTOCOL_VERSION, WS_PATH, FEATURE_LIST, createSender } from '../cluster-protocol.mjs';
import { waitFor } from './helpers/wait.mjs';

const HEARTBEAT_MS = 200;
let tmp, hub, server, base, repo, shas = [];
const notices = [];
let busy = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

// A paired worker's socket: hello (with sha/features), then frames both ways; it answers heartbeats like a worker (any
// frame counts). connect() again reuses its token.
async function connect(w) {
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${w.token}` } });
  const frames = [], sender = createSender('w');
  const send = (t, f = {}) => { if (ws.readyState === WebSocket.OPEN) ws.send(sender(t, f)); };
  ws.on('message', (d) => { const f = JSON.parse(d); frames.push(f); if (f.t === 'heartbeat') send('heartbeat'); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  send('hello', { node: w.node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [], ...(w.sha ? { sha: w.sha } : {}), ...(w.features ? { features: w.features } : {}) });
  await waitFor(() => frames.find((f) => f.t === 'welcome'), { timeout: 5000 });
  return Object.assign(w, { ws, frames, send, got: (t) => frames.filter((f) => f.t === t) });
}
async function fakeWorker({ name, kind = 'linux', sha = null, features = FEATURE_LIST } = {}) {
  const { code } = hub.createPairing();
  const { node, token } = hub.claim({ code, name, os: kind, arch: 'arm64' });
  return connect({ node, token, name, sha, features });
}
async function drop(w) {
  w.ws.terminate();
  await waitFor(() => !hub.isConnected(w.node), { timeout: 5000 });
}
const res = (over = {}) => ({ memAvailable: 4e9, load: [0.2, 0.2, 0.1], running: [], swapUsedPct: 0, ...over });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-health-'));
  // The controller's own checkout: origin/main is 3 commits past the first one.
  repo = path.join(tmp, 'agent-orch');
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(repo, 'v.txt'), String(i));
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `v${i}`);
    shas.push(git('rev-parse', 'HEAD'));
  }
  git('update-ref', 'refs/remotes/origin/main', shas[3]);
  hub = createCluster({
    dbFile: path.join(tmp, 'hub.db'), heartbeatMs: HEARTBEAT_MS, metricsDir: path.join(tmp, 'metrics', 'nodes'), repoDir: repo, outdatedAfter: 1, mainTtlMs: 0,
    logsTimeoutMs: 600, onNotice: (n) => notices.push(n),
  });
  hub.setBusy(() => busy);
  server = http.createServer((req, r) => { r.writeHead(404); r.end(); });
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  hub?.close();
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('telemetry: every resources frame lands in the node series, and the node view carries the latest', async () => {
  const w = await fakeWorker({ name: 'tele' });
  const tele = (i) => res({
    memAvailable: 4e9 + i, cpu: [10, 30], memTotal: 8e9, swapTotal: 1e9, swapUsed: 1e7, swapUsedPct: 1,
    disk: { path: '/home/w/.agent-orch-worker', free: 50e9, total: 100e9 }, net: { host: 'github.com', ok: true, ms: 20, at: Date.now() },
    agents: [{ id: 'codex', installed: true, version: '0.157.0', signedIn: true }], uptime: 1000, procUptime: 10, version: '1.0.0', sha: shas[3],
    battery: { pct: 80, charging: true, source: 'ac' }, thermal: { pressure: 'nominal', speedLimit: 100, warning: null },
  });
  w.send('resources', tele(1));
  w.send('resources', tele(2));
  const { samples } = await waitFor(() => { const r = hub.metrics(w.node, '1h'); return r.samples.length === 2 && r; }, { timeout: 5000 });
  assert.deepEqual({ ...samples[1], t: 0 }, { t: 0, cpu: 20, cores: [10, 30], load: 0.2, mem: 4e9 + 2, swap: 1, disk: 50e9, net: 1, netMs: 20, jobs: 0, bat: 80, chg: 1, therm: 100 });
  assert.ok(fs.existsSync(path.join(tmp, 'metrics', 'nodes', `${w.node}.jsonl`)));
  const n = await waitFor(() => { const x = hub.node(w.node); return x.behind === 0 && x; }, { timeout: 5000, message: 'the same sha as origin/main' });
  assert.equal(n.resources.disk.free, 50e9);
  assert.equal(n.resources.agents[0].version, '0.157.0');
  assert.equal(n.sha, shas[3]);
  assert.equal(n.outdated, false);
  assert.equal(hub.metrics('nope', '1h').status, 404);
  assert.equal(hub.metrics(w.node, 'bogus').range, '1h');
  w.ws.close();
});

test('telemetry compaction: the last hour at full resolution, 5-minute buckets to 24 h, nothing older', () => {
  const dir = path.join(tmp, 'compact'), m = createNodeMetrics({ dir });
  const now = Date.UTC(2026, 8, 27, 12, 0, 0);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let t = now - 26 * 3600e3; t <= now; t += 10_000) {
    const i = (t - (now - 26 * 3600e3)) / 10_000;
    lines.push(JSON.stringify({ t, cpu: 50, cores: [40, 60], load: 1, mem: 2e9, swap: 5, disk: 30e9 - (i % 30) * 1e6, net: i % 90 === 7 ? 0 : 1, jobs: i % 30 === 3 ? 2 : 1 }));
  }
  fs.writeFileSync(m.file('n1'), lines.join('\n') + '\n');
  m.compact('n1', now);
  const rows = m.read('n1');
  assert.ok(rows.every((r) => r.t >= now - METRICS.keepMs), 'nothing older than 24 h');
  const recent = rows.filter((r) => r.t >= now - METRICS.fullMs);
  assert.equal(recent.length, 361, 'every sample of the last hour kept');
  assert.ok(recent.every((r) => r.n === undefined));
  const older = rows.filter((r) => r.t < now - METRICS.fullMs);
  assert.equal(older.length, 23 * 12, 'one sample per 5 minutes from 1 h to 24 h');
  assert.ok(older.every((r) => r.t % METRICS.bucketMs === 0 && r.n === 30), 'bucket starts, 30 samples each');
  const b = older[10];
  assert.deepEqual([b.cpu, b.cores, b.load, b.mem, b.swap], [50, [40, 60], 1, 2e9, 5], 'readings average');
  assert.equal(b.disk, 30e9 - 29e6, 'disk: the lowest free space');
  assert.equal(b.jobs, 2, 'jobs: the most at once');
  assert.ok(older.some((r) => r.net === 0), 'net: any failed probe shows');
  assert.ok(fs.statSync(m.file('n1')).size < 200_000);
  // Idempotent, and a later pass folds what aged past the hour into the same buckets.
  assert.deepEqual(compactSamples(rows, now), rows);
  const later = compactSamples(rows, now + 30 * 60e3);
  assert.equal(later.filter((r) => r.t >= now + 30 * 60e3 - METRICS.fullMs).length, 181);
  assert.ok(later.filter((r) => r.n).every((r) => r.t % METRICS.bucketMs === 0));
  assert.equal(m.series('n1', '6h', now).filter((r) => r.n).length, 5 * 12);
  assert.equal(m.series('n1', '15m', now).length, 91);
});

test('log tail: the controller asks over the socket and relays the lines; no answer, old workers and unknown nodes', async () => {
  const w = await fakeWorker({ name: 'logs' });
  const p = hub.logsTail(w.node, 3);
  const [req] = await waitFor(() => w.got('logs.tail').length && w.got('logs.tail'), { timeout: 5000 });
  assert.equal(req.lines, 3);
  assert.match(req.req, /^[0-9a-f]{12}$/);
  w.send('logs', { req: 'someone-else', lines: ['x'] });
  w.send('logs', { req: req.req, lines: ['2026-09-27T10:00:00Z info a', 'b', 'c'] });
  const r = await p;
  assert.deepEqual(r.lines, ['2026-09-27T10:00:00Z info a', 'b', 'c']);
  assert.equal(r.node, w.node);
  assert.equal((await hub.logsTail(w.node, 5)).status, 504, 'no answer in time');
  assert.equal((await hub.logsTail('n_missing')).status, 404);
  assert.equal((await hub.logsTail('controller')).status, 400);
  const old = await fakeWorker({ name: 'old-logs', features: null });
  assert.match((await hub.logsTail(old.node)).error, /too old/);
  old.ws.close();
  w.ws.close();
  await waitFor(() => !hub.isConnected(w.node), { timeout: 5000 });
  assert.match((await hub.logsTail(w.node)).error, /offline/);
});

test('auto-drain: under 2 GB free on its disk drains the worker with a notice; an owner undrain holds for the hour', async () => {
  const w = await fakeWorker({ name: 'disk' });
  w.send('resources', res({ disk: { path: '/x', free: 1.5 * 1024 ** 3, total: 100e9 } }));
  const n = await waitFor(() => { const x = hub.node(w.node); return x.draining && x; }, { timeout: 5000 });
  assert.equal(n.status, 'draining');
  assert.match(n.drainReason, /only 1\.5 GB is free on the disk that holds its repos \(under 2\.0 GB\)/);
  assert.ok(n.drainedAt > 0);
  const note = notices.find((x) => x.node === w.node);
  assert.equal(note.level, 'warn');
  assert.match(note.text, /^disk was drained automatically: only 1\.5 GB/);
  // The owner undrains it: the reason goes, and the same low disk doesn't drain it again right away.
  hub.update(w.node, { draining: false });
  assert.equal(hub.node(w.node).drainReason, null);
  assert.ok(hub.node(w.node).healthAck > 0);
  w.send('resources', res({ disk: { path: '/x', free: 1.5 * 1024 ** 3, total: 100e9 } }));
  await sleep(HEARTBEAT_MS * 2);
  assert.equal(hub.node(w.node).draining, false);
  // An owner's own drain carries no automatic reason.
  hub.update(w.node, { draining: true });
  assert.equal(hub.node(w.node).drainReason, null);
  w.ws.close();
});

test('auto-drain: losing its connection 3 times in 30 min drains a worker; a Mac that reports each sleep is left alone', async () => {
  const w = await fakeWorker({ name: 'flaky' });
  for (let i = 0; i < 3; i++) { await drop(w); await connect(w); }
  w.send('resources', res());
  await sleep(HEARTBEAT_MS * 2); // a wake report would have arrived by now
  assert.equal(hub.node(w.node).draining, false, 'not judged right after the reconnect');
  w.send('resources', res());
  const n = await waitFor(() => { const x = hub.node(w.node); return x.draining && x; }, { timeout: 5000 });
  assert.match(n.drainReason, /lost its connection 3 times in 30 min \(missed heartbeats\)/);

  const mac = await fakeWorker({ name: 'mac', kind: 'darwin' });
  for (let i = 0; i < 3; i++) {
    await drop(mac);
    await connect(mac);
    mac.send('wake', { sleptAt: Date.now() - 2000, sleptMs: 1500 });
  }
  await sleep(HEARTBEAT_MS * 2);
  mac.send('resources', res());
  await sleep(HEARTBEAT_MS * 2);
  assert.equal(hub.node(mac.node).draining, false, 'sleeps are not failing heartbeats');
  // A worker that keeps going silent (its heartbeats stop) is dropped by the sweep each time, and that counts too.
  const quiet = await fakeWorker({ name: 'quiet' });
  for (let i = 0; i < 3; i++) {
    quiet.ws.pause();
    await waitFor(() => !hub.isConnected(quiet.node), { timeout: 5000 });
    quiet.ws.terminate();
    await connect(quiet);
  }
  await sleep(HEARTBEAT_MS * 2);
  quiet.send('resources', res());
  assert.match((await waitFor(() => hub.node(quiet.node).drainReason, { timeout: 5000 })), /lost its connection 3 times/);
  w.ws.close(); mac.ws.close(); quiet.ws.close();
});

test('version check: an outdated worker takes no new work and gets node.update only once idle', async () => {
  const w = await fakeWorker({ name: 'old', sha: shas[0] });
  w.send('resources', res({ running: [42] }));
  let n = await waitFor(() => { const x = hub.node(w.node); return x.update?.state === 'pending' && x; }, { timeout: 5000 });
  assert.deepEqual([n.behind, n.outdated, n.status, n.update.by, n.update.target], [3, true, 'updating', 'auto', shas[3]]);
  await sleep(HEARTBEAT_MS * 3);
  assert.equal(w.got('node.update').length, 0, 'not while its telemetry lists a running job');
  busy = true; // the scheduler still has a job placed or offered there
  w.send('resources', res());
  await sleep(HEARTBEAT_MS * 3);
  assert.equal(w.got('node.update').length, 0, 'not while the scheduler has work there');
  busy = false;
  const [upd] = await waitFor(() => w.got('node.update').length && w.got('node.update'), { timeout: 5000 });
  assert.equal(upd.sha, shas[3]);
  assert.equal(hub.node(w.node).update.state, 'sent');
  await sleep(HEARTBEAT_MS * 3);
  assert.equal(w.got('node.update').length, 1, 'sent once');
  // The worker could not update: failed, reported, and not retried on its own for the same target.
  w.send('node.error', { kind: 'update', message: 'update failed: local changes', re: upd.seq });
  n = await waitFor(() => { const x = hub.node(w.node); return x.update?.state === 'failed' && x; }, { timeout: 5000 });
  assert.match(n.update.error, /local changes/);
  assert.equal(n.status, 'online', 'a failed update leaves it working');
  assert.equal(n.lastError.kind, 'update');
  assert.ok(notices.some((x) => x.node === w.node && /could not update itself/.test(x.text)));
  await sleep(HEARTBEAT_MS * 3);
  assert.equal(w.got('node.update').length, 1);
  // The owner asks again: it goes once idle, and the worker comes back on the new sha.
  assert.equal(hub.requestUpdate(w.node).node.update.by, 'owner');
  await waitFor(() => w.got('node.update').length === 2, { timeout: 5000 });
  assert.equal(hub.requestUpdate(w.node).node.update.state, 'sent', 'a second press while it updates changes nothing');
  // A reconnect on the old sha mid-update (it is still pulling) is not a failure, and nothing is sent again.
  await drop(w);
  await connect(w);
  w.send('resources', res());
  await sleep(HEARTBEAT_MS * 3);
  assert.equal(hub.node(w.node).update.state, 'sent');
  assert.equal(w.got('node.update').length, 0);
  w.send('bye', { reason: 'update' });
  await waitFor(() => !hub.isConnected(w.node), { timeout: 5000 });
  w.sha = shas[3];
  await connect(w);
  n = await waitFor(() => { const x = hub.node(w.node); return !x.update && x; }, { timeout: 5000 });
  assert.deepEqual([n.behind, n.outdated, n.status], [0, false, 'online']);
  assert.ok(notices.some((x) => x.node === w.node && x.level === 'info' && /updated itself to/.test(x.text)));
  assert.equal(hub.requestUpdate(w.node).status, 409, 'up to date');
  // A worker without the update feature is never sent one.
  const legacy = await fakeWorker({ name: 'legacy', sha: shas[0], features: null });
  legacy.send('resources', res());
  await sleep(HEARTBEAT_MS * 3);
  assert.equal(legacy.got('node.update').length, 0);
  assert.equal(hub.node(legacy.node).outdated, true);
  assert.match(hub.requestUpdate(legacy.node).error, /too old to update itself/);
  w.ws.close(); legacy.ws.close();
});
