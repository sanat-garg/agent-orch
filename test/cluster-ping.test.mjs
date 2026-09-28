// The owner's Ping (cluster.mjs ping/pingReport, worker.mjs selfCheck; CLUSTER.md Health → Ping): a round trip through a
// fake worker that answers pong {diag}, a real worker.mjs process doing its own self-check (DNS, the head's /api/health,
// git ls-remote of the head's git endpoint), 'no answer' after the timeout, 'update the worker to ping' for an older
// worker, the DNS-failure hint, and a disconnected node's last seen, drop reason, drops and test one-liner. Each result
// is a node event.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createCluster, pingReport, testCommand } from '../cluster.mjs';
import { PROTOCOL_VERSION, WS_PATH, FEATURE_LIST, createSender } from '../cluster-protocol.mjs';
import { selfCheck } from '../worker.mjs';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp, hub, server, base, bare;

// A paired fake worker. features: what its hello lists; onPing(frame, send): how it answers a ping (default: never).
async function fakeWorker(name, { kind = 'darwin', features = FEATURE_LIST, onPing = null } = {}) {
  const { code } = hub.createPairing();
  const w = hub.claim({ code, name, os: kind, arch: 'arm64' });
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${w.token}` } });
  const frames = [], sender = createSender('w');
  const send = (t, f = {}) => ws.send(sender(t, f));
  ws.on('message', (d) => { const m = JSON.parse(d); frames.push(m); if (m.t === 'ping' && onPing) onPing(m, send); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  send('hello', { node: w.node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [], features });
  await waitFor(() => frames.find((f) => f.t === 'welcome'), { timeout: 5000 });
  return { ...w, ws, frames, send };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ping-'));
  bare = path.join(tmp, 'head.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  hub = createCluster({ dbFile: path.join(tmp, 'hub.db'), heartbeatMs: 1000, pingTimeoutMs: 400, headGit: () => bare });
  server = http.createServer((req, r) => {
    if (req.url === '/api/health') { r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{"ok":true}'); }
    r.writeHead(404); r.end();
  });
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  hub?.close();
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const DIAG = {
  host: '129-154-229-134.sslip.io',
  dns: { ok: true, ips: ['129.154.229.134'], ms: 12 },
  head: { ok: true, url: 'https://129-154-229-134.sslip.io/api/health', status: 200, ms: 140 },
  github: { ok: true, status: 200, ms: 90 },
  conn: { since: 1, attempt: 0 },
};

test('a ping round trip through a fake worker: rtt, the diag, the summary, and a node event', async () => {
  const w = await fakeWorker('mac-ok', { onPing: (m, send) => send('pong', { id: m.id, diag: DIAG }) });
  const r = await hub.ping(w.node, { headUrl: 'https://129-154-229-134.sslip.io' });
  assert.equal(r.error, undefined);
  assert.equal(r.connected, true);
  assert.ok(Number.isInteger(r.rtt) && r.rtt >= 0 && r.rtt < 400, `rtt ${r.rtt}`);
  assert.deepEqual(r.diag, DIAG);
  const ping = w.frames.find((f) => f.t === 'ping');
  assert.ok(ping.id && Number.isFinite(ping.sentAt) && ping.git === bare, 'ping carries the head git endpoint');
  assert.deepEqual(r.parts.map((p) => p.text), [`Ping ${r.rtt} ms`, 'DNS ok (129.154.229.134, 12 ms)', 'head HTTPS 200 (140 ms)', 'GitHub ok']);
  assert.ok(r.parts.every((p) => !p.bad));
  assert.deepEqual(r.hints, []);
  const [ev] = hub.nodeEvents(w.node, { kind: 'ping' });
  assert.deepEqual([ev.kind, ev.rtt, ev.diag.dns.ips], ['ping', r.rtt, ['129.154.229.134']]);
  w.ws.terminate();
});

test('a real worker answers with its own self-check: DNS, the head\'s /api/health and git ls-remote of the head', { timeout: 60_000 }, async () => {
  const home = path.join(tmp, 'w-home'), bin = path.join(tmp, 'w-bin'), whome = path.join(home, '.agent-orch-worker');
  fs.mkdirSync(whome, { recursive: true });
  fs.mkdirSync(bin);
  isolatedPath(bin);
  const { code } = hub.createPairing(), w = hub.claim({ code, name: 'real-mac', os: 'darwin', arch: 'arm64' });
  fs.writeFileSync(path.join(whome, 'config.json'), JSON.stringify({ controller: base, node: w.node, name: 'real-mac', token: w.token }), { mode: 0o600 });
  let out = '';
  const worker = spawn(process.execPath, ['worker.mjs', 'run'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { HOME: home, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off', AGENT_ORCH_WORKER_NET_PROBE: 'off', AGENT_ORCH_WORKER_SRC: path.join(tmp, 'w-src'), AGENT_ORCH_WORKER_BROWSER: 'off' } });
  worker.stdout.on('data', (d) => { out += d; });
  worker.stderr.on('data', (d) => { out += d; });
  try {
    await waitFor(() => hub.node(w.node)?.features?.includes('ping'), { timeout: 30_000, message: `the worker connects\n${out}` });
    const r = await hub.ping(w.node, { headUrl: base, timeoutMs: 15_000 }); // the hub's 400 ms is for the fakes
    assert.equal(r.connected, true, `${JSON.stringify(r)}\n${out}`);
    assert.equal(r.diag.host, '127.0.0.1');
    assert.equal(r.diag.dns.ok, true);
    assert.ok(r.diag.dns.ips.includes('127.0.0.1'));
    assert.deepEqual([r.diag.head.ok, r.diag.head.status, r.diag.head.url], [true, 200, `${base}/api/health`]);
    assert.equal(r.diag.git.ok, true, JSON.stringify(r.diag.git));
    assert.deepEqual(r.diag.github, { skipped: true });
    assert.ok(Number.isFinite(r.diag.conn.since) && Number.isInteger(r.diag.conn.attempt));
    assert.deepEqual(r.parts.slice(2).map((p) => p.text.replace(/\d+ ms/, 'N ms')), ['head HTTP 200 (N ms)', 'head git ok (N ms)']);
    assert.deepEqual(r.hints, []);
  } finally {
    worker.kill('SIGTERM');
    await new Promise((res) => { const t = setTimeout(() => { worker.kill('SIGKILL'); res(); }, 10_000); worker.on('exit', () => { clearTimeout(t); res(); }); });
  }
});

test('no pong before the timeout is "no answer" (and logged); an older worker is told to update', async () => {
  const w = await fakeWorker('mac-silent');
  const r = await hub.ping(w.node);
  assert.deepEqual(r, { status: 504, error: 'no answer' });
  assert.equal(hub.nodeEvents(w.node)[0].error, 'no answer');
  // A pong that arrives too late is dropped quietly.
  const ping = w.frames.find((f) => f.t === 'ping');
  w.send('pong', { id: ping.id, diag: DIAG });
  const old = await fakeWorker('mac-old', { features: FEATURE_LIST.filter((f) => f !== 'ping') });
  const o = await hub.ping(old.node);
  assert.equal(o.status, 409);
  assert.match(o.error, /update the worker to ping/);
  assert.equal(old.frames.filter((f) => f.t === 'ping').length, 0, 'an older worker is never sent a ping');
  assert.equal(hub.isConnected(old.node), true);
  assert.deepEqual([(await hub.ping('nope')).status, (await hub.ping('controller')).status], [404, 400]);
  w.ws.terminate();
  old.ws.terminate();
});

test('a DNS failure gives the plain-language hint, in red', async () => {
  const diag = { ...DIAG, dns: { ok: false, code: 'EAI_AGAIN', error: 'getaddrinfo EAI_AGAIN 129-154-229-134.sslip.io', ms: 5000 },
    head: { ok: false, url: DIAG.head.url, code: 'EAI_AGAIN', ms: 5000 }, github: { ok: true, status: 200, ms: 80 } };
  const { parts, hints } = pingReport(diag, 84, 'darwin');
  assert.deepEqual(parts.map((p) => [p.text, p.bad]), [['Ping 84 ms', false], ['DNS failed (EAI_AGAIN, 5000 ms)', true], ['head HTTPS failed (EAI_AGAIN)', true], ['GitHub ok', false]]);
  assert.deepEqual(hints, ["DNS lookup of the head failed on this Mac: its router or ISP can't resolve sslip.io. The worker falls back to the IP once #359 lands; or set the Mac's DNS to 1.1.1.1"]);
  // Through the hub, from a worker whose lookup fails.
  const w = await fakeWorker('mac-dns', { onPing: (m, send) => send('pong', { id: m.id, diag }) });
  const r = await hub.ping(w.node);
  assert.deepEqual(r.hints, hints);
  w.ws.terminate();
  // The worker's real check of a name that doesn't resolve reports the resolver's code.
  const real = await selfCheck({ controller: 'https://head.agent-orch-ping-test.invalid', github: null, budgetMs: 5000 });
  assert.equal(real.dns.ok, false);
  assert.ok(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(real.dns.code), JSON.stringify(real.dns));
  assert.match(pingReport(real, 5, 'linux').hints[0], /^DNS lookup of the head failed on this machine: its router or ISP can't resolve agent-orch-ping-test\.invalid\./);
});

test('a disconnected node: last seen, the drop reason, drops today and a one-liner to test the head from it', async () => {
  const w = await fakeWorker('mac-away', { onPing: (m, send) => send('pong', { id: m.id, diag: DIAG }) });
  w.ws.terminate();
  await waitFor(() => !hub.isConnected(w.node) && hub.node(w.node).away, { timeout: 5000 });
  const r = await hub.ping(w.node, { headUrl: 'https://129-154-229-134.sslip.io' });
  assert.equal(r.connected, false);
  assert.ok(r.lastSeen > Date.now() - 60_000, 'last seen');
  assert.deepEqual([r.away, r.awayLabel, r.reason.reason, r.drops.total, r.drops.by], ['lost', 'connection lost', 'lost', 1, { lost: 1 }]);
  assert.equal(r.command, "curl -sS -o /dev/null -w '%{http_code} %{time_total}s\\n' https://129-154-229-134.sslip.io/api/health; dscacheutil -q host -a name 129-154-229-134.sslip.io");
  assert.equal(hub.nodeEvents(w.node, { kind: 'ping' })[0].connected, false);
  // Linux gets getent; an IP needs no lookup; anything shell-unsafe gets no command.
  assert.equal(testCommand('https://head.example.com', 'linux'), "curl -sS -o /dev/null -w '%{http_code} %{time_total}s\\n' https://head.example.com/api/health; getent hosts head.example.com");
  assert.equal(testCommand('http://10.0.0.5:3000', 'darwin'), "curl -sS -o /dev/null -w '%{http_code} %{time_total}s\\n' http://10.0.0.5:3000/api/health");
  assert.equal(testCommand('https://a$(id).example', 'darwin'), null);
});
