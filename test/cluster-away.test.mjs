// Why a worker went away (cluster.mjs, #360), with fake workers on an in-test HTTP/WS hub: a drop without a bye is
// 'lost' on every OS (a Mac too), it becomes 'asleep' only when the worker says so on reconnect (hello.reconnect.reason
// 'sleep', or its wake report), 'dns'/'network' are recorded with the worker's error and counted over 24 h, the waiting
// label follows (awayNote), and the Machines view shows the reason and the counts (app.js dropLines).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createCluster, awayNote } from '../cluster.mjs';
import { PROTOCOL_VERSION, WS_PATH, FEATURE_LIST, createSender } from '../cluster-protocol.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp, hub, server, base;

// The Machines view's drop lines, straight from app.js.
const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const dropLines = new Function(`${appJs.match(/^const DROP_WHY = .*?^function dropLines\(.*?^}$/ms)[0]}\nreturn dropLines;`)();

// A paired worker's socket; hello carries `reconnect` when given (an older worker sends none).
async function connect(w, reconnect) {
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${w.token}` } });
  const frames = [], sender = createSender('w');
  const send = (t, f = {}) => { if (ws.readyState === WebSocket.OPEN) ws.send(sender(t, f)); };
  ws.on('message', (d) => frames.push(JSON.parse(d)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  send('hello', { node: w.node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [], features: FEATURE_LIST, ...(reconnect ? { reconnect } : {}) });
  await waitFor(() => frames.find((f) => f.t === 'welcome'), { timeout: 5000 });
  return Object.assign(w, { ws, send });
}
async function fakeWorker(name, kind) {
  const { code } = hub.createPairing();
  return connect(hub.claim({ code, name, os: kind, arch: 'arm64' }));
}
async function drop(w) {
  w.ws.terminate();
  await waitFor(() => !hub.isConnected(w.node) && hub.node(w.node).away, { timeout: 5000 });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-away-'));
  hub = createCluster({ dbFile: path.join(tmp, 'hub.db'), heartbeatMs: 200 });
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

test('a drop without a bye is lost on every OS, and an older worker that says nothing leaves it lost', async () => {
  for (const kind of ['darwin', 'linux']) {
    const w = await fakeWorker(`box-${kind}`, kind);
    await drop(w);
    const n = hub.node(w.node);
    assert.deepEqual([n.status, n.away, n.awayLabel, awayNote(n)], ['offline', 'lost', 'connection lost', 'connection lost'], kind);
    assert.deepEqual([n.drops.total, n.drops.by, n.drops.last.reason, n.drops.last.back], [1, { lost: 1 }, 'lost', null]);
    await connect(w); // no hello.reconnect
    const m = hub.node(w.node);
    assert.equal(awayNote(m), null, 'connected: nothing to wait for');
    assert.deepEqual([m.away, m.drops.by, m.drops.last.reason], [null, { lost: 1 }, 'lost']);
    assert.ok(m.drops.last.back >= m.drops.last.at);
    assert.deepEqual(dropLines(m).map((l) => l[1]), ['Connection drops today: 1 (unexplained 1)'], 'no reason to show');
    w.send('bye', { reason: 'shutdown' });
    await waitFor(() => hub.node(w.node).away === 'bye', { timeout: 5000 });
    assert.equal(awayNote(hub.node(w.node)), null, 'a clean shutdown is neither lost nor asleep');
    assert.equal(hub.node(w.node).drops.total, 1, 'a bye is not a drop');
  }
});

test('asleep only when the worker reports it: hello.reconnect.reason sleep, or a wake report after the fact', async () => {
  const w = await fakeWorker('mac', 'darwin');
  await drop(w);
  const at = hub.node(w.node).drops.last.at;
  await connect(w, { reason: 'sleep', since: at - 1000 });
  let n = hub.node(w.node);
  assert.deepEqual([n.drops.total, n.drops.by, n.drops.last.reason], [1, { asleep: 1 }, 'asleep']);
  assert.match(dropLines(n)[0][1], /^Reconnected after \d+ s: the Mac was asleep$/);
  // An older worker: no reason in hello, but its wake report covers the drop.
  await drop(w);
  await connect(w);
  assert.equal(hub.node(w.node).drops.last.reason, 'lost');
  w.send('wake', { sleptAt: Date.now() - 60_000, sleptMs: 60_000 });
  n = await waitFor(() => { const x = hub.node(w.node); return x.drops.last.reason === 'asleep' && x; }, { timeout: 5000 });
  assert.deepEqual(n.drops.by, { asleep: 2 });
  assert.deepEqual(dropLines(n).at(-1)[1], 'Connection drops today: 2 (sleep 2)');
  // A legacy 'asleep' row still reads as asleep while away.
  assert.equal(awayNote({ connected: false, away: 'asleep' }), 'Mac asleep');
});

test('dns and network reasons are recorded with the error, counted over 24 h and shown', async () => {
  const w = await fakeWorker('laptop', 'darwin');
  for (let i = 0; i < 3; i++) {
    await drop(w);
    assert.equal(awayNote(hub.node(w.node)), 'connection lost', 'lost while away, whatever the reason turns out to be');
    await connect(w, { reason: 'dns', since: Date.now() - 180_000, lastError: 'getaddrinfo ENOTFOUND head.example.com' });
  }
  await drop(w);
  await connect(w, { reason: 'network', lastError: 'connect ENETUNREACH' });
  // A reason for a drop this head never saw (it restarted meanwhile): recorded from `since`.
  await connect(w, { reason: 'sleep', since: Date.now() - 180_000 });
  // Garbage from a confused worker is ignored.
  await drop(w);
  await connect(w, { reason: 'bogus', since: 'x', lastError: 42 });
  const n = hub.node(w.node);
  assert.deepEqual([n.drops.total, n.drops.by], [6, { dns: 3, network: 1, asleep: 1, lost: 1 }]);
  assert.deepEqual(n.drops.last.reason, 'lost');
  const d = hub.node(w.node).drops;
  // The Machines view: the latest explained reconnect, and the counts.
  const shown = dropLines({ ...n, drops: { ...d, last: { at: Date.now() - 180_000, back: Date.now(), reason: 'dns', error: 'getaddrinfo ENOTFOUND head.example.com' } } });
  assert.deepEqual(shown.map((l) => l[1]), ['Reconnected after 3 min: DNS lookup of the head failed', 'Connection drops today: 6 (DNS 3, network 1, sleep 1, unexplained 1)']);
  assert.equal(shown[0][2], 'getaddrinfo ENOTFOUND head.example.com');
  assert.equal(shown[1][0], 'warn');
  assert.match(dropLines({ os: 'linux', drops: { total: 1, by: { network: 1 }, last: { at: 0, back: 120_000, reason: 'network', error: null } } })[0][1], /^Reconnected after 2 min: the network was down$/);
  // Removing the node forgets its drops.
  hub.revoke(w.node);
  const again = await fakeWorker('laptop-2', 'darwin');
  assert.deepEqual(hub.node(again.node).drops, { total: 0, by: {}, last: null });
  assert.deepEqual(dropLines(hub.node(again.node)), []);
});
