// Keep improving (projects.perpetual) per project: off means no reflection from any path, on schedules one again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Same harness as rapid-planning.test.mjs: `live` runs the scheduler against a git project with a fake agent whose
// reflection replies with REPLY once `released` has its prompt.
async function scenario(body, { live = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-improving-'));
  try {
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import { execFileSync } from 'node:child_process';
      import { setModelCatalog } from ${JSON.stringify(new URL('../agents.mjs', import.meta.url).href)};
      import { waitFor as until } from ${JSON.stringify(new URL('./helpers/wait.mjs', import.meta.url).href)};
      const dataDir = process.argv[1], root = dataDir + '/project'; fs.mkdirSync(root);
      if (${live}) {
        const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
        git('init','-q','-b','main'); git('config','user.name','Test'); git('config','user.email','test@example.com');
        fs.writeFileSync(root+'/README.md','Test project'); git('add','.'); git('commit','-qm','Fixture');
      }
      setModelCatalog('claude',{models:[{id:'opus',default:true}],error:null,at:Date.now()});
      const REPLY = 'Two next steps.\\n\\n\\\`\\\`\\\`agent-orch-tasks\\n' + JSON.stringify({tasks:[{title:'Proposed one',prompt:'x'},{title:'Proposed two',prompt:'y'}]}) + '\\n\\\`\\\`\\\`';
      const seen=[], released=new Set();
      const query=({prompt,options})=>(async function*(){
        seen.push(prompt);
        await until(()=>released.has(prompt) || options.abortController.signal.aborted, 10000);
        yield {type:'result',subtype:'success',result:REPLY,session_id:'test',num_turns:1};
      })();
      const o = createOrchestrator({ disabled: ${!live}, dataDir, claudeEnv: {}, query, config: {pollMs:50, parallelTasks:2,agentSlots:4,meminfo:${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)}},
        getLimits: () => [], usageLog: { current: () => [], tokens(){}, windows(){}, limitCleared(){} }, onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => false, projectArchived: () => !!globalThis.archived });
      o.attachCluster({ listNodes: () => [{ id: 'worker', local: false, status: 'online', connected: true, enabled: true,
        maxSlots: 14, inventory: { cores: 14, agents: [] }, resources: { memAvailable: 40 * 2 ** 30, at: Date.now() } }], onMessage() {}, version: () => 1 });
      const db = new DatabaseSync(dataDir + '/orchestrator/agent-orch.db');
      const t = Date.now()/1000;
      const pid = Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,next_reflect_at,created_at) VALUES(?,'Example','active',0,0,0)").run(root).lastInsertRowid);
      function task(title, status='queued', kind='work') {
        return Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,status,kind,created_at) VALUES(?,?,?,?,?,?)')
          .run(pid,title,title,status,kind,t-1000).lastInsertRowid);
      }
      task('Landed baseline','done');
      const reflections = () => db.prepare("SELECT * FROM tasks WHERE kind='reflect' ORDER BY id").all();
      const events = () => db.prepare('SELECT message FROM events ORDER BY id').all().map((e) => e.message);
      const result = await (async()=>{${body}})();
      console.log(JSON.stringify(result)); process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dir], { timeout: 20000 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('off: no reflection from an empty queue, the rapid top-up or a no-task-block retry; a manual retry is refused', async () => {
  const r = await scenario(`
    const rapidOn=o.stateView().parallel.rapidDevelopment;
    task('Ready work'); // rapid mode wants a top-up: free slots, one ready task
    const rapid=o.scheduleReflections();
    o.setParallelSettings({rapidDevelopment:false});
    db.prepare("UPDATE tasks SET status='done'").run(); // the queue is empty and next_reflect_at is due
    const empty=o.scheduleReflections();
    // a reflection that ended without a task block: done, retry due now
    const slip=task('Reflect: what else should be done?','failed','reflect');
    db.prepare('UPDATE projects SET next_reflect_at=?').run(t-1);
    const retryDue=o.scheduleReflections();
    const manual=o.taskAction(slip,'retry');
    return {rapidOn, rapid, empty, retryDue, manual, created: reflections().filter((x)=>x.id!==slip).length, slipStatus: reflections()[0].status};`);
  assert.equal(r.rapidOn, true);
  assert.deepEqual([r.rapid, r.empty, r.retryDue], [false, false, false]);
  assert.equal(r.created, 0);
  assert.match(r.manual.error, /Keep improving is off/);
  assert.equal(r.slipStatus, 'failed');
});

test('on schedules a reflection; switching off cancels queued ones at once; on again sets next_reflect_at=0', async () => {
  const r = await scenario(`
    o.setParallelSettings({rapidDevelopment:false});
    db.prepare('UPDATE projects SET next_reflect_at=?').run(t+3600);
    const on=o.projectAction(pid,{perpetual:true});
    const nextAfterOn=db.prepare('SELECT next_reflect_at FROM projects').get().next_reflect_at;
    const scheduled=o.scheduleReflections();
    const queued=reflections().map((x)=>x.status);
    o.projectAction(pid,{perpetual:false});
    const after=reflections().map((x)=>x.status);
    const view=o.projectFor({cwd:root}).perpetual;
    const again=o.scheduleReflections();
    return {on, nextAfterOn, scheduled, queued, after, view, again, events: events(), id: reflections()[0].id};`);
  assert.deepEqual(r.on, { ok: true });
  assert.equal(r.nextAfterOn, 0);
  assert.equal(r.scheduled, true);
  assert.deepEqual(r.queued, ['queued']);
  assert.deepEqual(r.after, ['cancelled']);
  assert.equal(r.view, false);
  assert.equal(r.again, false);
  assert.ok(r.events.includes(`Keep improving off: cancelled reflection #${r.id}`), r.events.join('\n'));
});

test('live: a queued reflection of a project that is off never runs; a running one finishes but its tasks are discarded', async () => {
  const r = await scenario(`
    // A reflection left queued while off (say, requeued after the toggle) is cancelled by the scheduler, never claimed.
    const stray=task('Reflect: what else should be done?','queued','reflect');
    await until(()=>reflections()[0].status==='cancelled');
    const strayRan=seen.length;
    // On: the scheduler reflects; switch off while it runs, then let it reply with two tasks.
    db.prepare("UPDATE tasks SET status='cancelled' WHERE status='queued'").run();
    o.projectAction(pid,{perpetual:true});
    await until(()=>seen.length===1, 10000);
    const running=reflections().find((x)=>x.status==='running');
    o.projectAction(pid,{perpetual:false});
    released.add(seen[0]);
    await until(()=>db.prepare('SELECT status FROM tasks WHERE id=?').get(running.id).status==='done', 10000);
    const done=db.prepare('SELECT result FROM tasks WHERE id=?').get(running.id).result;
    const work=db.prepare("SELECT title FROM tasks WHERE kind='work' AND title LIKE 'Proposed%'").all().length;
    await new Promise((res)=>setTimeout(res,300));
    return {stray, strayRan, running: !!running, done, work, later: reflections().filter((x)=>x.id>running.id).length, events: events()};
  `, { live: true });
  assert.equal(r.strayRan, 0);
  assert.ok(r.events.includes(`Keep improving off: cancelled reflection #${r.stray}`));
  assert.equal(r.running, true);
  assert.match(r.done, /Two next steps/);
  assert.match(r.done, /Keep improving was switched off while this reflection ran: its 2 proposed task\(s\) were discarded, not queued/);
  assert.equal(r.work, 0);
  assert.equal(r.later, 0);
});

test('an archived project gets no reflection, even with Keep improving on; unarchived it does', async () => {
  const r = await scenario(`
    o.setParallelSettings({rapidDevelopment:false});
    db.prepare('UPDATE projects SET perpetual=1').run();
    globalThis.archived = true;
    const archived = o.scheduleReflections(), whileArchived = reflections().length;
    globalThis.archived = false;
    return {archived, whileArchived, after: o.scheduleReflections(), created: reflections().length};`);
  assert.deepEqual([r.archived, r.whileArchived], [false, 0]);
  assert.deepEqual([r.after, r.created], [true, 1]);
});
