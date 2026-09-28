// The scheduler's view of the cluster (orchestrator nodesNow / capacityView), with a stub hub: an Auto worker (maxSlots
// null) counts its cores, at least 4 (nodeCap, placement.mjs slotTarget), whatever its free RAM, and a node change (cluster.version()) is seen by the
// next read, not after the one-second cache (else a worker that just reconnected looks offline to placement).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('capacity counts an Auto worker by its nodeCap and follows a node change at once', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-capacity-'));
  try {
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      const GB = 2 ** 30, worker = { id: 'n_1', name: 'vps-2', local: false, status: 'online', connected: true, enabled: true, draining: false,
        maxSlots: null, inventory: { cores: 4, agents: [] }, resources: { memAvailable: 4 * GB, at: Date.now() } };
      let version = 1;
      const o = createOrchestrator({ query: () => (async function* () {})(), dataDir: process.argv[1], disabled: true, claudeEnv: {}, getLimits: () => [],
        onSubscription: () => false, broadcast() {}, emitChat() {}, convoExists: () => false });
      o.attachCluster({ listNodes: () => [{ id: 'controller', local: true, status: 'online', connected: true, enabled: true }, { ...worker }],
        onMessage() {}, version: () => version });
      const auto = o.stateView().capacity.workers;
      worker.draining = true; version++;
      console.log(JSON.stringify({ auto, drained: o.stateView().capacity.workers }));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir], { encoding: 'utf8', timeout: 30000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    // Auto: its 4 cores; the 4 GB free plays no part.
    assert.equal(r.auto, 4);
    assert.equal(r.drained, 0, 'the drain is seen by the next read');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// BRIEF goal 9: an owner-set cap (maxSlots) is the limit. A Mac capped at 10 with 4 GB free counts 10 slots and takes a
// 6th task while 5 run there; one with only 200 MB free takes work too (memory never gates placement).
test('an owner-capped node takes tasks up to its cap, whatever its free memory', { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-capped-'));
  const dataDir = path.join(tmp, 'data'), repo = path.join(tmp, 'repo');
  const common = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
    import { effectivePolicy } from ${JSON.stringify(new URL('../power.mjs', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    import path from 'node:path';
    const [dataDir, repo] = process.argv.slice(1), GB = 2 ** 30, MB = 2 ** 20;
    const node = (id, free) => ({ id, name: id, os: 'darwin', local: false, status: 'online', connected: true, enabled: true, draining: false, maxSlots: 10,
      inventory: { cores: 8, agents: [{ id: 'claude', installed: true, signedIn: true }] }, resources: { memAvailable: free, at: Date.now() }, policy: effectivePolicy('darwin') });
    const opts = { query: () => (async function* () {})(), dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
      broadcast() {}, emitChat() {}, convoExists: () => false };
    const db = () => new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));`;
  // Boot 1 (disabled, never schedules): five work tasks were running on the Mac when the controller stopped, one is queued.
  const seed = `${common}
    import { execFileSync } from 'node:child_process';
    import fs from 'node:fs';
    createOrchestrator({ ...opts, disabled: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/test-owner/capped.git'], { cwd: repo });
    const d = db(), t = Date.now() / 1000;
    const pid = Number(d.prepare("INSERT INTO projects(path,name,priority,status,perpetual,position,created_at) VALUES(?,'capped',50,'active',0,1,0)").run(repo).lastInsertRowid);
    for (let i = 0; i < 5; i++) {
      const id = Number(d.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,node_id,started_at,created_at) VALUES(?,'work',?,'p','running','mac',?,?)").run(pid, 'run ' + i, t, t).lastInsertRowid);
      const log = path.join(dataDir, 'run-' + i + '.jsonl');
      fs.writeFileSync(log, '');
      d.prepare("INSERT INTO runs(task_id,purpose,started_at,log_path) VALUES(?,'work',?,?)").run(id, t, log);
    }
    d.prepare("INSERT INTO tasks(project_id,kind,title,prompt,created_at) VALUES(?,'work','sixth','p',?)").run(pid, t);
    process.exit(0);`;
  // Boot 2 (the scheduler, its tick parked; the controller leaves work to the workers): the hub re-adopts the five, then the sixth is claimed.
  const check = `${common}
    const nodes = [{ id: 'controller', local: true, status: 'online', connected: true, enabled: true }, node('mac', 4 * GB), node('mac-low', 200 * MB)];
    let version = 1;
    const o = createOrchestrator({ ...opts, config: { pollMs: 1e9, controllerWork: false } });
    o.attachCluster({ listNodes: () => nodes, node: (id) => nodes.find((n) => n.id === id) || null, isConnected: () => false, send: () => false,
      onMessage() {}, version: () => version });
    const out = { workers: o.stateView().capacity.workers, running: o.machines(nodes).find((n) => n.id === 'mac').used, adopted: [1, 2, 3, 4, 5].map((id) => o.isRunning(id)) };
    const macLow = nodes.splice(2, 1)[0]; version++; // the spread would pick the emptier mac-low: first only the Mac with 5 running
    const c = o.claimNext(null);
    out.sixth = c && [c.task.title, c.node];
    // The same queue with only the capped node at 200 MB free: it takes it all the same.
    db().prepare("UPDATE tasks SET status='queued', node_id=NULL WHERE title='sixth'").run();
    nodes.splice(1, 1, macLow); version++;
    const low = o.claimNext(null);
    out.low = low && [low.task.title, low.node];
    console.log(JSON.stringify(out));
    process.exit(0);`;
  try {
    const run = (script) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo], { encoding: 'utf8', timeout: 30000 });
    await run(seed);
    const r = JSON.parse((await run(check)).stdout.trim().split('\n').pop());
    assert.deepEqual(r.adopted, [true, true, true, true, true]);
    assert.equal(r.running, 5);
    // The owner's 10 on each capped node, mac-low's 200 MB free included.
    assert.equal(r.workers, 20);
    assert.deepEqual(r.sixth, ['sixth', 'mac']);
    assert.deepEqual(r.low, ['sixth', 'mac-low'], 'low free memory never blocks a node');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
