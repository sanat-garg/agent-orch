// #384: the head's slots come from its real hardware (three a core, at least 4; 2 cores → 6), 2 of them kept for
// controller-only work (integrators, reflection), and re-detected so a resize applies without a restart. Ordinary work
// goes to the workers first; the head takes it only when every worker is at its target or none is online.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { headTarget } from '../parallel.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
const node = (script, ...args) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 45000 })
  .then(({ stdout }) => JSON.parse(stdout.trim().split('\n').pop()));

test('the target comes from the cores: three a core, at least 4, two of them reserved', () => {
  assert.deepEqual(headTarget(2), { target: 6, reserved: 2, work: 4 });
  assert.deepEqual(headTarget(1), { target: 4, reserved: 2, work: 2 });
  assert.deepEqual(headTarget(4), { target: 12, reserved: 2, work: 10 });
  assert.equal(headTarget(12).work, 16, 'work slots stop at 16, like the owner setting');
  assert.deepEqual(headTarget(2, 0), { target: 6, reserved: 0, work: 6 });
});

test('workers first, the head only when they are full; integrators start on the head while its work slots are full', { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'head-cap-'));
  const dataDir = path.join(tmp, 'data'), repos = path.join(tmp, 'repos');
  fs.mkdirSync(repos);
  const common = `import { createOrchestrator } from ${url('orchestrator.mjs')};
    import { DatabaseSync } from 'node:sqlite';
    import { execFileSync } from 'node:child_process';
    import fs from 'node:fs';
    import path from 'node:path';
    const [dataDir, repos] = process.argv.slice(1), GB = 2 ** 30;
    const opts = { query: () => (async function* () {})(), dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
      broadcast() {}, emitChat() {}, convoExists: () => false,
      config: { pollMs: 1e9, agentSlots: Infinity, hardware: () => ({ cores: 2, mem: 11 * GB }) } };
    const db = () => new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    // Each task in its own project, a GitHub repo, so ordinary work may run on a worker.
    const project = (d, name) => {
      const repo = path.join(repos, name);
      if (!fs.existsSync(repo)) {
        execFileSync('git', ['init', '-q', '-b', 'main', repo]);
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/test-owner/' + name + '.git'], { cwd: repo });
      }
      return Number(d.prepare("INSERT INTO projects(path,name,priority,status,perpetual,position,created_at) VALUES(?,?,50,'active',0,(SELECT COALESCE(MAX(position),0)+1 FROM projects),0)").run(repo, name).lastInsertRowid);
    };`;
  // Boot 1 (disabled): two tasks were running on 'mac' (its target is 2) when the controller stopped.
  const seed = `${common}
    createOrchestrator({ ...opts, disabled: true });
    const d = db(), t = Date.now() / 1000;
    for (let i = 0; i < 2; i++) {
      const id = Number(d.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,node_id,started_at,created_at) VALUES(?,'work',?,'p','running','mac',?,?)").run(project(d, 'mac' + i), 'mac ' + i, t, t).lastInsertRowid);
      const log = path.join(dataDir, 'run-' + i + '.jsonl');
      fs.writeFileSync(log, '');
      d.prepare("INSERT INTO runs(task_id,purpose,started_at,log_path) VALUES(?,'work',?,?)").run(id, t, log);
    }
    console.log('{}');
    process.exit(0);`;
  // Boot 2 (the scheduler, its tick parked): the hub re-adopts the two, then claims go one at a time.
  const check = `${common}
    const worker = (id, maxSlots) => ({ id, name: id, os: 'darwin', local: false, status: 'online', connected: true, enabled: true, draining: false, maxSlots,
      inventory: { cores: 8, agents: [{ id: 'claude', installed: true, signedIn: true }] }, resources: { memAvailable: 16 * GB, at: Date.now() } });
    const controller = { id: 'controller', name: 'oracle-vm', local: true, status: 'online', connected: true, enabled: true };
    let nodes = [controller, worker('mac', 2), worker('air', 1)], version = 1, synced = [];
    const setNodes = (list) => { nodes = list; version++; };
    const o = createOrchestrator(opts);
    o.attachCluster({ listNodes: () => nodes, node: (id) => nodes.find((n) => n.id === id) || null, isConnected: () => false, send: () => false,
      onMessage() {}, version: () => version, setLocalCapacity: (c) => synced.push(c) });
    o.setParallelSettings({ controllerWork: true });
    const d = db(), t = Date.now() / 1000;
    const task = (title, extra = {}) => Number(d.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,integrates,created_at) VALUES(?,'work',?,'p',?,?,?)")
      .run(project(d, title), title, extra.status || 'queued', extra.integrates ?? null, t).lastInsertRowid);
    const pair = (c) => c && [c.task.title, c.node];
    const claim = (title) => { task(title); return pair(o.claimNext(null)); };
    const out = { adopted: [1, 2].map((id) => o.isRunning(id)), head: o.stateView().head, synced: synced.at(-1) };
    const away = nodes.map((n) => (n.local ? n : { ...n, status: 'offline', connected: false }));
    const online = nodes;
    setNodes(away);
    out.noneOnline = claim('W1');                 // no worker online: the head takes it
    setNodes(online);
    out.toWorker = claim('W2');                   // 'air' has a free slot (and 'mac' is full): not the head
    setNodes(online.filter((n) => n.id !== 'air')); // 'air' is at its target now too
    out.workersFull = claim('W3');
    o.setParallelSettings({ controllerWork: false });
    out.workOff = claim('W4');                    // controllerWork off: the head leaves it to the (full) workers
    o.setParallelSettings({ controllerWork: true });
    out.fill = [pair(o.claimNext(null)), claim('W5')];
    out.headFull = claim('W6');                   // the head's 4 work slots are taken
    const owner = task('Owner', { status: 'needs_integration' });
    task('Integrate #' + owner, { integrates: owner });
    out.integrator = pair(o.claimNext(null));
    out.after = o.stateView().head;
    out.machine = o.machines(nodes).find((n) => n.local);
    console.log(JSON.stringify(out));
    process.exit(0);`;
  try {
    await node(seed, dataDir, repos);
    const r = await node(check, dataDir, repos);
    assert.deepEqual(r.adopted, [true, true]);
    assert.deepEqual([r.head.cores, r.head.target, r.head.reserved, r.head.work], [2, 6, 2, 4], '2 cores → 6: 2 reserved, 4 for work');
    assert.deepEqual(r.synced, { cores: 2, mem: 11 * 2 ** 30, maxSlots: 6 }, "the controller's nodes row is told its hardware and slots");
    assert.deepEqual(r.noneOnline, ['W1', 'controller'], 'no worker online: the head runs it');
    assert.deepEqual(r.toWorker, ['W2', 'air'], 'a worker with capacity gets it, not the head (which has free work slots)');
    assert.deepEqual(r.workersFull, ['W3', 'controller'], 'every worker at its target: the head takes it');
    assert.equal(r.workOff, null, 'controllerWork off: the head never takes work a worker could run');
    assert.deepEqual(r.fill, [['W4', 'controller'], ['W5', 'controller']]);
    assert.equal(r.headFull, null, "the head's 4 work slots are full (W1, W3, W4, W5)");
    assert.match(r.integrator[0], /^Integrate #/);
    assert.equal(r.integrator[1], 'controller', 'the integrator starts on the head in a reserved slot');
    assert.deepEqual([r.after.integrating, r.after.workUsed, r.after.work, r.after.reserved], [1, 4, 4, 2]);
    assert.deepEqual([r.machine.slots, r.machine.head.integrating, r.machine.head.workUsed], [6, 1, 4]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('integrators go first among ready tasks and never wait behind work', { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'head-cap-order-'));
  try {
    const r = await node(`import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import path from 'node:path';
      const [dataDir] = process.argv.slice(1);
      const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, disabled: true, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => false, config: { agentSlots: 1, parallelTasks: 1, hardware: () => ({ cores: 1, mem: 2 ** 32 }) } });
      const d = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const project = (name) => Number(d.prepare("INSERT INTO projects(path,name,priority,status,perpetual,position,created_at) VALUES(?,?,50,'active',0,(SELECT COALESCE(MAX(position),0)+1 FROM projects),0)").run('/nowhere/' + name, name).lastInsertRowid);
      const task = (title, extra = {}) => Number(d.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,integrates,source,created_at) VALUES(?,'work',?,'p',?,?,?,?)")
        .run(project(title), title, extra.status || 'queued', extra.integrates ?? null, extra.source || 'planner', extra.at ?? 1).lastInsertRowid);
      const claim = () => { const c = o.claimNext(null); return c && c.task.title; };
      task('Owner request', { source: 'user', at: 0 }); // older, and the owner's own
      const owner = task('Owner', { status: 'needs_integration' });
      task('Integrate', { integrates: owner, at: 5 });
      const first = claim();
      const work = claim();   // the one work slot (parallelTasks 1)
      const owner2 = task('Owner 2', { status: 'needs_integration' });
      task('Integrate 2', { integrates: owner2, at: 6 });
      task('More work', { at: 2 });
      const second = claim(); // work slot and the agent's one slot are full: the reserved slot takes it anyway
      const none = claim();
      console.log(JSON.stringify({ first, work, second, none }));
      process.exit(0);`, tmp);
    assert.deepEqual(r, { first: 'Integrate', work: 'Owner request', second: 'Integrate 2', none: null });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a resize is re-detected on the timer: the target and the stored controller node follow', { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'head-cap-resize-'));
  try {
    const r = await node(`import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { createCluster } from ${url('cluster.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import path from 'node:path';
      const [dataDir] = process.argv.slice(1), GB = 2 ** 30;
      let hw = { cores: 1, mem: 5.9 * GB };
      const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => false,
        broadcast() {}, emitChat() {}, convoExists: () => false, config: { pollMs: 1e9, hardwareMs: 100, hardware: () => hw } });
      const c = createCluster({ dbFile: path.join(dataDir, 'orchestrator', 'agent-orch.db') });
      o.attachCluster(c);
      const view = () => { const h = o.stateView().head, n = c.listNodes().find((x) => x.local); return { target: h.target, work: h.work, cores: n.inventory.cores, maxSlots: n.maxSlots }; };
      const before = view();
      hw = { cores: 2, mem: 11 * GB };
      await new Promise((r) => setTimeout(r, 600));
      const after = view();
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const event = db.prepare("SELECT message FROM events WHERE message LIKE 'this server now has%'").get()?.message || null;
      console.log(JSON.stringify({ before, after, event, setting: o.stateView().parallel.parallelTasks }));
      process.exit(0);`, tmp);
    assert.deepEqual(r.before, { target: 4, work: 2, cores: 1, maxSlots: 4 }, 'the stale 1-core head: 4 in all');
    assert.deepEqual(r.after, { target: 6, work: 4, cores: 2, maxSlots: 6 }, 'resized to 2 cores: 6 in all, 4 for work, and the node row says so');
    assert.equal(r.setting, 4);
    assert.match(r.event, /^this server now has 2 cores and 11\.0 GB \(was 1, 5\.9 GB\): 4 work slots plus 2 for integration$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
