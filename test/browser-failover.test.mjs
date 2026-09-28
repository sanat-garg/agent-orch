// Browser failover (#500): a live view whose machine sends no frame or can't launch the browser moves to the next capable
// machine; a browser task whose browser couldn't connect is requeued pinned to another one; a failed machine is skipped
// for 10 min (browser.mjs failedNodes, nextBrowserNode; browser-view.mjs; orchestrator browserFailover).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MSG } from '../cluster-protocol.mjs';
import { createBrowserViews } from '../browser-view.mjs';
import { failedNodes, nextBrowserNode, browserUnavailable, MCP_START_FAILED, FAILED_MS } from '../browser.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Workers that can show a browser; `answer(node, fields)` is each screen op's reply ({result} or {error}).
function fakeCluster(answer) {
  const worker = (id, name, osName, load) => ({ id, name, os: osName, connected: true, features: ['screen'],
    inventory: { cores: 8, browser: { capable: true } }, resources: { load: [load] } });
  const nodes = [worker('lin', 'vps-2', 'linux', 0), worker('mac1', 'mac-1', 'darwin', 1), worker('mac2', 'mac-2', 'darwin', 2)];
  const ops = [];
  return { nodes, ops, hub: { listNodes: () => nodes, send() {}, async request(node, t, fields) { ops.push({ node, ...fields }); return answer(node, fields); } } };
}
function viewer() {
  const sent = [];
  return { ws: {}, sent, of: (t) => sent.filter((m) => m.t === t) };
}

test('a view with no frame within frameMs switches to the next machine (a Mac before a Linux worker)', async () => {
  const { hub, ops } = fakeCluster(() => ({ result: {} }));
  const v = viewer();
  const views = createBrowserViews({ cluster: () => hub, send: (ws, m) => ws === v.ws && v.sent.push(m), frameMs: 150 });
  try {
    views.handle(v.ws, { t: 'bv_open', node: 'mac1', identity: 'xero' });
    const sw = await waitFor(() => v.of('bv_switch')[0], { timeout: 3000, message: 'bv_switch' });
    assert.deepEqual({ node: sw.node, to: sw.to, name: sw.name }, { node: 'mac1', to: 'mac2', name: 'mac-2' });
    assert.equal(sw.text, 'Switched to mac-2: mac-1 sent no picture for 150 ms. Signed-in sites may differ on mac-2');
    await waitFor(() => ops.some((o) => o.node === 'mac2' && o.op === 'open'), { timeout: 3000, message: 'opened on mac2' });
    assert.ok(ops.some((o) => o.node === 'mac1' && o.op === 'stop'), 'the old browser view is stopped');
    // Frames from the new machine reach the viewer; the view stays there (a frame arrived, so no further switch).
    views.onCluster('mac2', { t: MSG.SCREEN_FRAME, identity: 'xero', n: 1, data: 'AAA', w: 10, h: 10 });
    const f = await waitFor(() => v.of('bv_frame')[0], { timeout: 3000 });
    assert.equal(f.node, 'mac2');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(v.of('bv_switch').length, 1);
    assert.ok(v.of('bv_state').some((s) => s.node === 'mac2' && !s.closed));
    assert.equal(views.failed.why('mac1'), 'sent no picture for 150 ms');
  } finally { await views.close(); }
});

test('a launch error switches at once, Macs before Linux; a failed machine picked by hand is still tried', async () => {
  const { hub, ops } = fakeCluster((node, f) => (f.op === 'open' && node !== 'lin' ? { error: 'Chromium failed to launch' } : { result: {} }));
  const v = viewer();
  const views = createBrowserViews({ cluster: () => hub, send: (ws, m) => ws === v.ws && v.sent.push(m), frameMs: 60_000 });
  try {
    const t0 = Date.now();
    views.handle(v.ws, { t: 'bv_open', node: 'mac1', identity: 'default' });
    // mac1 fails → mac2 (a Mac first) fails → the Linux worker.
    await waitFor(() => v.of('bv_switch').length === 2, { timeout: 3000, message: 'two switches' });
    assert.ok(Date.now() - t0 < 3000, 'no frame wait');
    const [a, b] = v.of('bv_switch');
    assert.equal(a.to, 'mac2');
    assert.equal(a.text, "Switched to mac-2: mac-1 couldn't open the browser (Chromium failed to launch). Signed-in sites may differ on mac-2");
    assert.equal(b.to, 'lin');
    await waitFor(() => v.of('bv_state').some((s) => s.node === 'lin' && !s.closed), { timeout: 3000 });
    // The owner can still pick a failed machine by hand: it is tried there, then moves on.
    views.handle(v.ws, { t: 'bv_open', node: 'mac1', identity: 'other' });
    await waitFor(() => v.of('bv_switch').some((m) => m.identity === 'other' && m.to === 'lin'), { timeout: 3000, message: 'other moves to lin' });
    assert.ok(ops.some((o) => o.node === 'mac1' && o.op === 'open' && o.identity === 'other'), 'the picked machine is tried');
  } finally { await views.close(); }
});

test('a failed machine is skipped for 10 min, then tried again', () => {
  let t = 0;
  const failed = failedNodes({ now: () => t });
  const nodes = [{ id: 'a', online: true, capable: true, mac: true, load: 0 }, { id: 'b', online: true, capable: true, mac: true, load: 1 },
    { id: 'head', local: true, online: true, capable: true }, { id: 'c', online: true, capable: true, chrome: true, load: 5 }];
  assert.equal(nextBrowserNode(nodes).id, 'c', 'Chrome-capable first');
  failed.mark('c', 'no picture');
  const skip = (n) => failed.has(n.id);
  assert.equal(nextBrowserNode(nodes, skip).id, 'a', 'then the least-loaded Mac');
  failed.mark('a', 'launch error'); failed.mark('b', 'launch error');
  assert.equal(nextBrowserNode(nodes, skip).id, 'head', 'the head last');
  t = FAILED_MS - 1;
  assert.ok(failed.has('a'));
  t = FAILED_MS;
  assert.ok(!failed.has('a') && !failed.has('c'));
  assert.equal(nextBrowserNode(nodes, skip).id, 'c');
  assert.ok(browserUnavailable({ outcome: 'error', text: MCP_START_FAILED }));
  assert.ok(browserUnavailable({ outcome: 'error', errorCode: 'mcp_connect_failed' }));
  assert.ok(browserUnavailable({ outcome: 'setup_failed', text: 'The Claude in Chrome extension is not connected' }));
  assert.ok(!browserUnavailable({ outcome: 'error', text: 'rate limit' }));
  assert.ok(!browserUnavailable({ outcome: 'ok', text: MCP_START_FAILED }));
});

test('a browser task whose MCP fails to connect moves to another capable machine (twice at most); the failed one is skipped', { timeout: 90_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-failover-'));
  const dataDir = path.join(tmp, 'data'), proj = path.join(tmp, 'browser');
  fs.mkdirSync(proj);
  const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
    import { waitFor } from ${JSON.stringify(new URL('./helpers/wait.mjs', import.meta.url).href)};
    import { MCP_START_FAILED } from ${JSON.stringify(new URL('../browser.mjs', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    import path from 'node:path';
    const [dataDir, proj] = process.argv.slice(1), GB = 2 ** 30;
    const o = createOrchestrator({ config: { pollMs: 100, controllerWork: false, meminfo: ${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)} },
      query: () => (async function* () {})(), dataDir, claudeEnv: { PATH: process.env.PATH }, getLimits: () => [], onSubscription: () => true,
      broadcast() {}, emitChat() {}, convoExists: () => false });
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    const worker = (id, name, osName) => ({ id, name, os: osName, arch: 'arm64', local: false, status: 'online', connected: true, enabled: true,
      draining: false, maxSlots: 4, features: ['git', 'approvals', 'browser-task', 'screen'],
      inventory: { cores: 8, browser: { capable: true }, agents: [{ id: 'claude', installed: true, signedIn: true }] },
      resources: { memAvailable: 64 * GB, at: Date.now(), load: [0.5, 0.5, 0.5] } });
    const nodes = [{ id: 'controller', name: 'oracle-vm', local: true, status: 'online', connected: true, enabled: true },
      worker('mac1', 'mac-1', 'darwin'), worker('mac2', 'mac-2', 'darwin'), worker('lin', 'vps-2', 'linux')];
    const sent = [], fails = new Set();
    let onMsg = () => {}, seq = 0;
    const reply = (node, m) => setTimeout(() => onMsg(node, { seq: ++seq, ts: Date.now(), ...m }), 10);
    o.attachCluster({ listNodes: () => nodes, node: (id) => nodes.find((n) => n.id === id) || null, isConnected: (id) => !!nodes.find((n) => n.id === id)?.connected,
      version: () => 1, onMessage: (fn) => { onMsg = fn; },
      send: (node, msg) => {
        sent.push({ node, ...msg });
        if (msg.t === 'job.offer') reply(node, { t: 'job.accept', job: msg.job });
        if (msg.t === 'job.start') reply(node, fails.has(msg.job) ? { t: 'job.done', job: msg.job, outcome: 'error', text: MCP_START_FAILED }
          : { t: 'job.done', job: msg.job, outcome: 'ok', text: 'Read it.\\nAGENT-ORCH-STATUS: done — read' });
        return true;
      } });
    const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,next_reflect_at,created_at) VALUES(?,'Browser',0,'active',0,?,0)")
      .run(proj, Date.now() / 1000 + 86400 * 365).lastInsertRowid);
    const task = (title, identity) => Number(db.prepare(\`INSERT INTO tasks(project_id,kind,title,prompt,priority,urgency,source,created_at,capabilities,execution,browser_identity)
      VALUES(?,'work',?,?,50,'normal','user',?,'["browser"]','browser',?)\`).run(pid, title, title, Date.now() / 1000, identity).lastInsertRowid);
    const starts = (id) => sent.filter((f) => f.t === 'job.start' && f.job === id).map((f) => f.node);
    const row = (id) => db.prepare('SELECT status, node_id, run_on FROM tasks WHERE id=?').get(id);
    const out = {};
    const a = task('Read the inbox', 'default');
    fails.add(a);
    // Its first machine (a Mac) fails, then the other Mac, then the Linux worker: two switches, then it fails.
    await waitFor(() => row(a).status === 'failed', { timeout: 60000, message: 'a fails after two switches' });
    out.a = { starts: starts(a), row: row(a) };
    out.events = db.prepare("SELECT message FROM events WHERE task_id=? AND message LIKE '%moved to%' ORDER BY id").all(a).map((e) => e.message);
    // Every machine is now marked failed: an unpinned browser task on another profile waits, with the reason.
    const b = task('Check the bank', 'bank');
    await new Promise((r) => setTimeout(r, 1500));
    out.b = { starts: starts(b), row: row(b) };
    out.failed = ['mac1', 'mac2', 'lin'].map((n) => o.browserFailed.has(n));
    // mac2 recovers: the next one goes there, never to the failed mac1.
    o.browserFailed.clear('mac2');
    await waitFor(() => row(b).status === 'done', { timeout: 30000, message: 'b runs on mac2' });
    out.b2 = { starts: starts(b), row: row(b) };
    console.log(JSON.stringify(out));
    process.exit(0);`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, proj], { cwd: ROOT, encoding: 'utf8', timeout: 80_000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    const [first, second, third] = r.a.starts;
    assert.equal(r.a.starts.length, 3, JSON.stringify(r));
    assert.deepEqual([first, second].sort(), ['mac1', 'mac2'], 'the Macs first');
    assert.equal(third, 'lin');
    assert.equal(r.a.row.status, 'failed');
    const name = { mac1: 'mac-1', mac2: 'mac-2', lin: 'vps-2' };
    assert.equal(r.events.length, 2);
    assert.match(r.events[0], new RegExp(`^#\\d+ moved to ${name[second]}: browser unavailable on ${name[first]}\\. Signed-in sites may differ on ${name[second]}$`));
    assert.match(r.events[1], new RegExp(`^#\\d+ moved to vps-2: browser unavailable on ${name[second]}\\. Signed-in sites may differ on vps-2$`));
    assert.deepEqual(r.b.starts, [], 'every machine failed lately: it waits');
    assert.equal(r.b.row.status, 'queued');
    assert.deepEqual(r.failed, [true, true, true]);
    assert.deepEqual(r.b2.starts, ['mac2']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
