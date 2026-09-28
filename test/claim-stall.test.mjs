// #453: the post-restart claim stall. With a rolling restart pending and two integrators running on the head, ready work
// still goes to the workers (only new head claims wait, and the pacing cap never counts integrators); a claim that throws
// is logged and retried on the next tick; the reason nothing starts is surfaced (stateView().stall → the queue header).
// Each scenario is a child process: the real scheduler (pollMs 100) on a temp git repo, a fake `query` whose integrators
// run until aborted, and a fake cluster hub with one worker that clones through the head (feature 'git').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function scenario(body, { limits = [], config = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claim-stall-'))), repo = path.join(root, 'proj'), dataDir = path.join(root, 'data');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
    import { setModelCatalog } from ${url('agents.mjs')};
    import { waitFor } from ${url('test/helpers/wait.mjs')};
    import { MSG } from ${url('cluster-protocol.mjs')};
    import { DatabaseSync } from 'node:sqlite';
    import path from 'node:path';
    const [dataDir, repo] = process.argv.slice(1), GB = 2 ** 30;
    setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: Date.now() });
    // Integrators (and anything else on the head) run until aborted.
    const query = ({ options }) => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-' + Math.random() };
      await new Promise((r) => options.abortController.signal.addEventListener('abort', r, { once: true }));
    })();
    // features: read by placement (canClone) and by runRemote; globalThis.BOOM lists the reads (1-based) that throw.
    globalThis.BOOM = new Set(); let reads = 0;
    const worker = { id: 'w1', name: 'Mac', os: 'darwin', local: false, status: 'online', connected: true, enabled: true, draining: false, maxSlots: 4,
      get features() { if (BOOM.has(++reads)) throw new Error('boom ' + reads); return ['git']; },
      inventory: { cores: 8, agents: [{ id: 'claude', installed: true, signedIn: true }] }, resources: { memAvailable: 16 * GB, at: Date.now() } };
    const controller = { id: 'controller', name: 'oracle-vm', local: true, status: 'online', connected: true, enabled: true };
    const sent = [];
    const hub = { onMessage() {}, setBusy() {}, setUpNext() {}, setLocalCapacity() {}, autoDrain() {}, version: () => 1,
      listNodes: () => [controller, worker], node: (id) => [controller, worker].find((n) => n.id === id) || null, isConnected: (id) => id === 'w1',
      send: (node, m) => { sent.push({ node, ...m }); return true; } };
    const o = createOrchestrator({ query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => ${JSON.stringify(limits)},
      onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false,
      config: ${JSON.stringify({ pollMs: 100, offerMs: 600000, meminfo: new URL('./fixtures/meminfo-ample', import.meta.url).pathname, ...config })} });
    o.attachCluster(hub);
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    const t0 = Date.now() / 1000;
    const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,'proj',50,'active',0,0)").run(repo).lastInsertRowid);
    const task = (title, extra = {}) => Number(db.prepare('INSERT INTO tasks(project_id,kind,title,prompt,status,integrates,run_on,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(pid, 'work', title, title, extra.status || 'queued', extra.integrates ?? null, extra.run_on ?? null, t0).lastInsertRowid);
    const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    const offered = () => sent.filter((m) => m.t === MSG.JOB_OFFER).map((m) => m.job);
    const events = (id) => db.prepare('SELECT message FROM events WHERE task_id=? ORDER BY id').all(id).map((e) => e.message);
    const integrators = () => [1, 2].map((i) => task('Integrate #' + i, { integrates: task('Owner ' + i, { status: 'needs_integration' }) }));
    const out = await (async () => { ${body} })();
    console.log(JSON.stringify(out));
    process.exit(0);`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo], { encoding: 'utf8', timeout: 90000 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a pending restart with two head integrators running still places ready work on the workers', { timeout: 120000 }, async () => {
  const r = await scenario(`
    const [i1, i2] = integrators();
    await waitFor(() => o.isRunning(i1) && o.isRunning(i2), { message: 'both integrators run on the head' });
    const work = [1, 2, 3].map((i) => task('Work ' + i));
    await waitFor(() => work.every((id) => offered().includes(id)), { message: 'every ready work task is offered to the worker' });
    const rapid = o.stateView().rapid;
    const restart = o.prepareRestart({ waitMs: 60000, planWaitMs: 0, pollMs: 50 }); // pauses the integrators (#459)
    await waitFor(() => o.stateView().restartHold, { message: 'the restart is pending' });
    const more = task('Work 4'), head = task('Kept on the head', { run_on: 'controller' });
    await waitFor(() => offered().includes(more), { message: 'work for the worker is still offered while the restart is pending' });
    await waitFor(() => o.stateView().stall, { message: 'a stall reason for the head-only task' });
    const s = o.stateView(), done = await restart;
    return { integrators: [i1, i2].map((id) => get(id).status), work: [...work, more].map((id) => [get(id).status, get(id).node_id]),
      head: get(head).status, hold: s.restartHold, stall: s.stall, rapid, restart: done.ok };`, { config: { controllerWork: false } });
  assert.deepEqual(r.integrators, ['paused', 'paused'], 'the restart pauses the head integrators');
  assert.deepEqual(r.work, [['running', 'w1'], ['running', 'w1'], ['running', 'w1'], ['running', 'w1']], 'the pending restart does not hold claims for workers');
  assert.equal(r.head, 'queued', 'a new claim on the head waits for the restart');
  assert.equal(r.restart, true);
  assert.equal(r.hold, 'restart pending');
  assert.deepEqual([r.stall.reason, r.stall.tasks], [r.hold, 1], 'the stall reason names the pending restart');
  // Rapid figures count everything running (the integrators too), and add up.
  assert.equal(r.rapid.running, 5);
  assert.deepEqual(r.rapid.workers, { slots: 4, running: 3, free: 1 });
  assert.equal(r.rapid.slots - r.rapid.running, r.rapid.free);
});

// Weekly usage past the background stop: pacing caps ordinary work at 2 across the cluster (d.scarce).
const scarce = [{ limit_type: 'seven_day', status: 'allowed', utilization: 0.8, resets_at: Date.now() / 1000 + 6 * 86400, observed_at: Date.now() / 1000 }];

test('integrators never count against the pacing cap on work for the workers', { timeout: 120000 }, async () => {
  const r = await scenario(`
    const [i1, i2] = integrators();
    await waitFor(() => o.isRunning(i1) && o.isRunning(i2), { message: 'both integrators run on the head' });
    const work = [1, 2, 3].map((i) => task('Work ' + i));
    await waitFor(() => offered().length === 2, { message: 'two work tasks are offered' });
    await waitFor(() => o.stateView().stall, { message: 'a stall reason for the third' });
    return { work: work.map((id) => get(id).status), stall: o.stateView().stall };`, { limits: scarce });
  assert.deepEqual(r.work, ['running', 'running', 'queued'], 'the cap of 2 holds two work tasks besides the two integrators');
  assert.deepEqual([r.stall.reason, r.stall.tasks], ['at the pacing cap of 2 running tasks', 1]);
});

test('a claim that throws is logged and the next tick claims it', { timeout: 120000 }, async () => {
  const r = await scenario(`
    BOOM.add(1); // placement (canClone) throws once
    const id = task('Work');
    await waitFor(() => offered().includes(id), { message: 'the task is offered after the failed claim' });
    return { status: get(id).status, node: get(id).node_id, events: events(id), attempts: get(id).attempts };`);
  assert.deepEqual([r.status, r.node, r.attempts], ['running', 'w1', 0]);
  assert.ok(r.events.some((m) => /^#\d+ couldn't be claimed: boom 1; retrying on the next tick$/.test(m)), r.events.join('\n'));
});

test('a start that fails after the claim is logged and retried without spending an attempt', { timeout: 120000 }, async () => {
  const r = await scenario(`
    BOOM.add(2); // placement succeeds, then runRemote's read throws (after the claim and the pre-claim commit)
    const id = task('Work');
    await waitFor(() => offered().includes(id), { message: 'the task is offered on the retry' });
    return { status: get(id).status, node: get(id).node_id, events: events(id), attempts: get(id).attempts };`, { config: { startRetrySec: 0 } });
  assert.deepEqual([r.status, r.node, r.attempts], ['running', 'w1', 0]);
  assert.ok(r.events.some((m) => /^#\d+ couldn't start: boom 2; retrying in 0 s$/.test(m)), r.events.join('\n'));
  assert.equal(r.events.filter((m) => /^started #/.test(m)).length, 2, 'started, failed, started again');
});

test('the queue header says why nothing starts', () => {
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = /\nfunction queueStallText\([\s\S]*?\n}\n/.exec(src)?.[0];
  assert.ok(fn, 'queueStallText is in app.js');
  const ctx = {};
  vm.runInNewContext(`${fn}; this.f = queueStallText;`, ctx);
  assert.equal(ctx.f({ reason: 'restart pending (integrator #439 is merging)', tasks: 8 }, 8), 'Waiting: restart pending (integrator #439 is merging)');
  assert.equal(ctx.f(null, 3), '');
  assert.equal(ctx.f({ reason: 'x' }, 0), '', 'nothing queued: no stall line');
  assert.match(src, /queueStallText\(O\.state\?\.stall, queued\.length\)/, 'renderQueue shows it');
});
