// Update all (#458) with fake workers: cluster.mjs updateAll against a hub on a local HTTP/WS server whose version check
// reads a scratch repo (origin/main = its third commit). Only workers behind are targeted (an offline one waits and updates
// when it says hello again), node.update {mode: 'now', clis, sha} goes to ONE worker at a time (the next only after the
// last one came back on the new sha or failed), a failing worker is reported and the rest go on, the CLI flag reaches the
// workers, and the head (when behind) goes last. Then the orchestrator: a worker back from its update with its job paused
// gets job.attach and job.resume for it (the task stays running there).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, WS_PATH, createSender } from '../cluster-protocol.mjs';
import { createCluster } from '../cluster.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp, repo, shas, hub, server, base, done = 0;
const events = []; // 'A:update', 'A:done', 'C:failed', … in the order they happened
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-update-all-'));
  repo = path.join(tmp, 'agent-orch');
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  shas = [];
  for (const v of [1, 2, 3]) {
    fs.writeFileSync(path.join(repo, 'v.txt'), `${v}\n`);
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `v${v}`);
    shas.push(git('rev-parse', 'HEAD'));
  }
  git('update-ref', 'refs/remotes/origin/main', shas[2]);
  hub = createCluster({ dbFile: path.join(tmp, 'hub.db'), repoDir: repo, mainTtlMs: 0, autoUpdate: false, heartbeatMs: 300, updateWaitMs: 5000,
    health: { diskMinBytes: 0 }, onRolloutDone: () => { done++; events.push('head:restart'); } });
  server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `ws://127.0.0.1:${server.address().port}${WS_PATH}`;
});
after(() => {
  hub?.close();
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// A fake worker: pairs, says hello on `sha`, and answers node.update as `behave` says: 'ok' reports its steps, drops
// the socket (its restart) and says hello again on the target sha; 'fail' reports a node.error. It records every frame.
function pair(name) {
  const { code } = hub.createPairing();
  return hub.claim({ code, name, os: 'linux', arch: 'arm64' });
}
async function fakeWorker(name, sha, behave = 'ok') {
  const w = { name, frames: [], ...pair(name) };
  w.connect = (at) => new Promise((resolve, reject) => {
    const ws = new WebSocket(base, { headers: { authorization: `Bearer ${w.token}` } }), send = createSender('w');
    w.ws = ws;
    w.send = (t, f) => ws.send(send(t, f));
    ws.on('open', () => w.send('hello', { node: w.node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [], sha: at, features: ['logs', 'update', 'update-now'] }));
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      w.frames.push(m);
      if (m.t === 'welcome') resolve(w);
      if (m.t !== 'node.update') return;
      events.push(`${name}:update`);
      setTimeout(async () => {
        if (behave === 'fail') { events.push(`${name}:failed`); return w.send('node.error', { kind: 'update', message: 'npm ci failed: npm error ERESOLVE', re: m.seq }); }
        for (const stage of ['pausing', 'pulling', 'installing', 'restarting']) w.send('update.progress', { stage });
        await waitFor(() => hub.node(w.node).rollout?.stage === 'restarting', { message: `${name} reported restarting` });
        events.push(`${name}:done`);
        ws.close(1000, 'update');
        await waitFor(() => !hub.node(w.node).connected, { message: `${name} disconnected` });
        await w.connect(m.sha);
      }, 150);
    });
    ws.on('error', reject);
  });
  return w.connect(sha);
}

test('Update all: only machines behind, one at a time, a failure isolated, the CLI flag passed, offline ones on reconnect, the head last', { timeout: 60_000 }, async () => {
  const [old, mid, main] = shas;
  const a = await fakeWorker('A', old), b = await fakeWorker('B', main), c = await fakeWorker('C', old, 'fail'), d = await fakeWorker('D', mid);
  // E reported an old sha, then went offline.
  const e = await fakeWorker('E', old);
  e.send('resources', { memAvailable: 1, load: [0, 0, 0], running: [], sha: old });
  await waitFor(() => hub.node(e.node).resources?.sha === old, { message: 'E reported its sha' });
  e.ws.close();
  await waitFor(() => !hub.node(e.node).connected, { message: 'E offline' });
  await waitFor(() => [a, c, d, e].every((w) => hub.node(w.node).behind > 0) && hub.node(b.node).behind === 0, { message: 'version counts' });

  assert.deepEqual(hub.updateAll({ nodes: [b.node] }), { status: 409, error: 'All up to date' }, 'an up-to-date machine is not updated');
  const r = hub.updateAll({ clis: true, head: true });
  assert.ok(r.rollout, JSON.stringify(r));
  const ids = r.rollout.nodes.map((n) => n.id);
  assert.deepEqual(ids, [a.node, c.node, d.node, e.node, 'controller'], 'the outdated ones, the head last; never B');
  assert.equal(r.rollout.nodes.find((n) => n.id === e.node).state, 'offline');
  assert.equal(r.rollout.current, a.node);

  await waitFor(() => hub.rollout().doneAt, { timeout: 30_000, message: `rollout finished: ${JSON.stringify(hub.rollout())}` });
  // One at a time: each node.update only after the one before came back updated or failed; the head restarts last.
  assert.deepEqual(events, ['A:update', 'A:done', 'C:update', 'C:failed', 'D:update', 'D:done', 'head:restart']);
  assert.equal(done, 1);
  const st = Object.fromEntries(hub.rollout().nodes.map((n) => [n.id, n]));
  assert.equal(st[a.node].state, 'done');
  assert.equal(st[d.node].state, 'done');
  assert.equal(st[c.node].state, 'failed');
  assert.match(st[c.node].error, /npm ci failed/);
  assert.equal(st[e.node].state, 'offline');
  assert.equal(st.controller.state, 'restarting');
  assert.equal(hub.node(a.node).sha, main);
  assert.equal(hub.node(a.node).behind, 0);
  // The frame each got: mode now, the CLI flag, the head's origin/main.
  for (const w of [a, c, d]) {
    const u = w.frames.filter((f) => f.t === 'node.update');
    assert.equal(u.length, 1, w.name);
    assert.deepEqual([u[0].mode, u[0].clis, u[0].sha], ['now', true, main], w.name);
  }
  assert.equal(b.frames.filter((f) => f.t === 'node.update').length, 0, 'B was up to date');
  // A failed one is retried on its own ('Retry'), without the CLI flag this time.
  const retry = hub.updateAll({ nodes: [c.node] });
  assert.equal(retry.rollout.nodes.find((n) => n.id === c.node).state, 'updating');
  await waitFor(() => c.frames.filter((f) => f.t === 'node.update').length === 2, { message: 'C retried' });
  assert.equal(c.frames.filter((f) => f.t === 'node.update')[1].clis, false);
  await waitFor(() => hub.rollout().doneAt, { message: 'retry finished' });
  // E comes back: it updates on its own.
  await e.connect(old);
  await waitFor(() => e.frames.some((f) => f.t === 'node.update'), { timeout: 10_000, message: 'E updated on reconnect' });
  await waitFor(() => hub.rollout().nodes.find((n) => n.id === e.node).state === 'done', { message: 'E done' });
  for (const w of [a, b, c, d, e]) w.ws.close();
});

test("a worker back from its update with its job paused: the scheduler re-attaches and resumes it there", { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-update-resume-'));
  const dataDir = path.join(dir, 'data'), demo = path.join(dir, 'demo');
  fs.mkdirSync(demo);
  const g = (...args) => execFileSync('git', args, { cwd: demo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(demo, 'README.md'), '# demo\n');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
    import { waitFor } from ${JSON.stringify(new URL('./helpers/wait.mjs', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    import path from 'node:path';
    const [dataDir, repo] = process.argv.slice(1), GB = 2 ** 30;
    const o = createOrchestrator({ config: { pollMs: 100, meminfo: ${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)} },
      query: () => (async function* () {})(), dataDir, claudeEnv: { PATH: process.env.PATH }, getLimits: () => [], onSubscription: () => true,
      broadcast() {}, emitChat() {}, convoExists: () => false });
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    db.prepare("INSERT INTO kv(key,value) VALUES('paused_all','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    const mac = { id: 'mac', name: 'mac-1', os: 'darwin', arch: 'arm64', local: false, status: 'online', connected: true, enabled: true, draining: false, maxSlots: 2,
      features: ['git', 'update', 'update-now'], inventory: { cores: 8, agents: [{ id: 'claude', installed: true, signedIn: true }] },
      resources: { memAvailable: 64 * GB, at: Date.now(), load: [0.5, 0.5, 0.5] }, graceMs: 60000 };
    const nodes = [{ id: 'controller', name: 'head', local: true, status: 'online', connected: true, enabled: true }, mac];
    const sent = [];
    let onMsg = () => {}, seq = 0, v = 1;
    const frame = (t, f) => onMsg('mac', { t, seq: ++seq, ts: Date.now(), ...f });
    o.attachCluster({ listNodes: () => nodes, node: (id) => nodes.find((n) => n.id === id) || null, isConnected: (id) => !!nodes.find((n) => n.id === id)?.connected,
      version: () => v, onMessage: (fn) => { onMsg = fn; },
      send: (node, msg) => { sent.push({ node, ...msg }); if (msg.t === 'job.offer') setTimeout(() => frame('job.accept', { job: msg.job }), 10); return true; } });
    const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,next_reflect_at,created_at) VALUES(?,'demo',50,'active',1,?,0)")
      .run(repo, Date.now() / 1000 + 86400 * 365).lastInsertRowid);
    const id = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,priority,urgency,source,created_at) VALUES(?,'work','A','A',50,'normal','user',?)")
      .run(pid, Date.now() / 1000).lastInsertRowid);
    const out = { assign: o.assignTask(id, 'mac') };
    await waitFor(() => sent.some((f) => f.t === 'job.start' && f.job === id), { timeout: 30000, message: 'started on mac' });
    frame('job.phase', { job: id, phase: 'running', at: Date.now() });
    // Update all: the worker pauses the job, restarts (its socket drops) and says hello on the new sha with the job paused.
    mac.connected = false; mac.status = 'offline'; v++;
    await new Promise((r) => setTimeout(r, 1500));
    mac.connected = true; mac.status = 'online'; v++;
    const before = sent.length;
    frame('hello', { node: 'mac', protocol: 1, version: 'test', sha: 'b'.repeat(40), jobs: [{ job: id, state: 'paused', next: 0 }] });
    await waitFor(() => sent.slice(before).some((f) => f.t === 'job.resume'), { timeout: 10000, message: 'resumed' });
    out.after = sent.slice(before).map((f) => [f.node, f.t, f.job]);
    out.row = db.prepare('SELECT status, node_id FROM tasks WHERE id=?').get(id);
    out.id = id;
    console.log(JSON.stringify(out));
    process.exit(0);`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, demo], { cwd: ROOT, encoding: 'utf8', timeout: 50_000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(r.assign.started, true);
    assert.deepEqual(r.after, [['mac', 'job.attach', r.id], ['mac', 'job.resume', r.id]], 'attached, then resumed');
    assert.deepEqual({ ...r.row }, { status: 'running', node_id: 'mac' }, 'it stays running on its machine');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
