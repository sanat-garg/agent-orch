// Rapid top-up demand is worker-slot based (#436): head-only work (integrators, work kept on the head) and chained
// tasks don't count as worker-ready, so a big worker with an integrator backlog still gets its slots filled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reflectPrompt } from '../orchestrator.mjs';

const project = { name: 'Example', path: '/example', priority: 50, mode: 'build', rigor: 5 }; // rigor 5: the top-up is uncapped
const prompt = (rapid) => reflectPrompt(project, [], '', false, [], '', [], { done: 0, failed: 0 }, '', rapid);

async function scenario(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-cap-'));
  try {
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import { setModelCatalog } from ${JSON.stringify(new URL('../agents.mjs', import.meta.url).href)};
      const dataDir = process.argv[1], root = dataDir + '/project'; fs.mkdirSync(root);
      setModelCatalog('claude',{models:[{id:'opus',default:true}],error:null,at:Date.now()});
      const o = createOrchestrator({ disabled: true, dataDir, claudeEnv: {}, query: () => (async function*(){})(),
        config: {pollMs:50, parallelTasks:2, agentSlots:4, controllerWork:false, meminfo:${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)}},
        getLimits: () => [], usageLog: { current: () => [], tokens(){}, windows(){}, limitCleared(){} }, onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => false });
      o.attachCluster({ listNodes: () => [{ id: 'pro', local: false, status: 'online', connected: true, enabled: true,
        maxSlots: 11, inventory: { cores: 14, agents: [] }, resources: { memAvailable: 40 * 2 ** 30, at: Date.now() } }], onMessage() {}, version: () => 1 });
      const db = new DatabaseSync(dataDir + '/orchestrator/agent-orch.db');
      const t = Date.now()/1000;
      const pid = Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,next_reflect_at,rigor,created_at) VALUES(?,'Example','active',1,?,5,0)").run(root,t+3600).lastInsertRowid);
      function task(title, status='queued', { integrates=null, after=null, node=null } = {}) {
        return Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,status,kind,depends_on,integrates,node_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(pid,title,title,status,'work',after,integrates,node,t-1000).lastInsertRowid);
      }
      const landed = task('Landed baseline','done');
      const integrators = (n) => { for (let i=0;i<n;i++) task('Integrate '+i,'queued',{integrates:task('Conflicted '+i,'needs_integration')}); };
      const reflections = () => db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind='reflect'").get().n;
      const result = await (async()=>{${body}})();
      console.log(JSON.stringify(result)); process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dir], { timeout: 15000 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('11 free worker slots, 4 worker-ready and 8 integrators ask for 9 worker-runnable tasks', async () => {
  const r = await scenario(`
    for(let i=0;i<4;i++) task('Ready '+i);
    integrators(8);
    const state=o.stateView().rapid, added=o.scheduleReflections();
    return { state, added, count: reflections() };`);
  assert.deepEqual([r.state.workers.slots, r.state.workers.free, r.state.ready, r.state.requested], [11, 11, 4, 9]);
  assert.equal(r.state.head.ready, 8);
  assert.equal(r.state.toppingUp, true);
  assert.equal(r.added, true);
  assert.equal(r.count, 1);
  const body = prompt(r.state);
  assert.match(body, /workers have 11 slots, 0 running, 4 ready: queue about 9 more worker-runnable tasks/);
  assert.match(body, /Head-only backlog: 8 ready/);
  assert.match(body, /No chains/);
  assert.doesNotMatch(prompt({ ...r.state, head: { ...r.state.head, ready: 0 } }), /Head-only backlog/);
});

test('enough worker-ready work: no top-up', async () => {
  const r = await scenario(`
    for(let i=0;i<13;i++) task('Ready '+i);
    integrators(3);
    const state=o.stateView().rapid, added=o.scheduleReflections();
    return { state, added, count: reflections() };`);
  assert.deepEqual([r.state.workers.free, r.state.ready, r.state.requested], [11, 13, 0]);
  assert.equal(r.state.toppingUp, false);
  assert.equal(r.added, false);
  assert.equal(r.count, 0);
});

test('head-only, chained and running integrator work never counts toward worker demand', async () => {
  const r = await scenario(`
    integrators(8);
    task('Kept on the head'); db.prepare("UPDATE tasks SET run_on='controller' WHERE title='Kept on the head'").run();
    const first=task('Chain head'); task('Chained',"queued",{after:first});
    task('Running integrator','running',{integrates:task('Conflicted x','needs_integration'),node:'controller'});
    for(let i=0;i<3;i++) task('Running '+i,'running',{node:'pro'});
    return o.stateView().rapid;`);
  // Only 'Chain head' is worker-ready; 3 ordinary runs hold worker slots, the running integrator holds a head slot.
  assert.deepEqual([r.workers.slots, r.workers.running, r.workers.free, r.ready, r.requested], [11, 3, 8, 1, 9]);
  assert.equal(r.running, 4, 'the running figure counts the integrator too');
  assert.equal(r.head.ready, 9);
  assert.equal(r.head.running, 1);
});

test('Keep improving off: numbers are shown but nothing tops up', async () => {
  const r = await scenario(`
    db.prepare('UPDATE projects SET perpetual=0').run();
    task('Ready');
    return { state: o.stateView().rapid, added: o.scheduleReflections(), count: reflections() };`);
  assert.equal(r.state.requested, 12);
  assert.equal(r.state.toppingUp, false);
  assert.equal(r.added, false);
  assert.equal(r.count, 0);
});
