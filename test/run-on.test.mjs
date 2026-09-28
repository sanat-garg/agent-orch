// "Run on" (tasks.run_on, orchestrator setTaskRunOn + place): the owner pins a queued work task to one machine and it
// runs only there, waiting for it while other machines are free; the controller pin overrides controllerWork.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('a pinned task runs only on its machine and waits for it; the pin is validated and only set on queued work', { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-on-'));
  const dataDir = path.join(tmp, 'data'), repos = path.join(tmp, 'repos');
  fs.mkdirSync(repos);
  // Each task in its own project (a GitHub repo, so it may run remotely).
  const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    import { execFileSync } from 'node:child_process';
    import path from 'node:path';
    const [dataDir, repos] = process.argv.slice(1), GB = 2 ** 30;
    const worker = (id, free, maxSlots) => ({ id, name: id + '-name', os: 'linux', local: false, status: 'online', connected: true, enabled: true, draining: false,
      maxSlots, inventory: { cores: 8, agents: [{ id: 'claude', installed: true, signedIn: true }] }, resources: { memAvailable: free * GB, at: Date.now() } });
    const nodes = [{ id: 'controller', name: 'oracle-vm', local: true, status: 'online', connected: true, enabled: true }, worker('roomy', 32, 4), worker('small', 8, 2)];
    const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, disabled: true, claudeEnv: {}, getLimits: () => [],
      onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false });
    o.attachCluster({ listNodes: () => nodes, onMessage() {}, version: () => 1 });
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    let pos = 0;
    const task = (title) => {
      const repo = path.join(repos, title);
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/test-owner/' + title + '.git'], { cwd: repo });
      const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,position,created_at) VALUES(?,?,50,'active',0,?,0)").run(repo, title, ++pos).lastInsertRowid);
      return Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,created_at) VALUES(?,'work',?,'p',?)").run(pid, title, Date.now() / 1000).lastInsertRowid);
    };
    const claim = () => { const c = o.claimNext(null); return c && [c.task.title, c.node]; };
    const out = {};
    const a = task('A'), b = task('B'), c = task('C'), d = task('D');
    out.bad = [o.setTaskRunOn(a, 'nope').status, o.setTaskRunOn(9999, null).status];
    out.pinA = o.setTaskRunOn(a, 'small').task.run_on_name;
    o.setTaskRunOn(b, 'small');
    o.setTaskRunOn(c, 'controller');
    out.seq = [claim()];
    nodes[2].status = 'offline'; // 'small' goes away (2 slots: A, claimed there, leaves room for B)
    out.seq.push(claim(), claim(), claim());
    out.running = o.setTaskRunOn(a, null).status; // A is running now: no more pinning
    nodes[2].status = 'online';
    out.afterA = claim();
    console.log(JSON.stringify(out));
    process.exit(0);`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repos], { cwd: ROOT, encoding: 'utf8', timeout: 45000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.deepEqual(r.bad, [400, 404]);
    assert.equal(r.pinA, 'small-name');
    // A goes to 'small' though 'roomy' is emptier; B (also pinned to 'small', now gone) waits; C runs on the
    // controller though workers are free and controllerWork is off; D (unpinned) takes the other worker.
    assert.deepEqual(r.seq, [['A', 'small'], ['C', 'controller'], ['D', 'roomy'], null]);
    assert.equal(r.running, 409);
    assert.deepEqual(r.afterA, ['B', 'small'], 'once its machine is back, B runs there');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
