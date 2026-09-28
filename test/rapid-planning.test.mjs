// Rapid mode uses ready cluster work, cached account windows and a persistent reflection spacing guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rapidQueueTarget, rapidAgentsLimited, reflectPrompt, plannerTurnPrompt } from '../orchestrator.mjs';

const project = { name: 'Example', path: '/example', priority: 50, mode: 'build' };
const prompt = (rapid, rows = []) => reflectPrompt(project, rows, '', false,
  [{ limit_type: 'five_hour', utilization: 0.4 }], 'room available', [], { done: 0, failed: 0 }, '', rapid);

test('14 slots, 3 running and 2 ready asks for 11 independent tasks, with recent titles', () => {
  const rapid = rapidQueueTarget(14, 3, 2);
  assert.equal(rapid.requested, 11);
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, title: `Recent task ${i + 1}`,
    status: ['queued', 'running', 'done'][i % 3], kind: 'work', files: '["area/file.mjs"]' }));
  const body = prompt(rapid, rows);
  assert.match(body, /14 slots, 3 running, 2 ready: queue about 11 more/);
  assert.match(body, /Queue the requested 11 tasks/);
  for (const row of rows) assert.ok(body.includes(row.title));
  for (const name of ['AUDIT.md', 'UI-REVIEW.md', 'ROADMAP.md', 'BRIEF.md', 'untested modules', 'file-disjoint', 'integrator', '`files`']) assert.ok(body.includes(name), name);
  assert.match(body, /One deliverable per task/);
  assert.match(body, /ONE check/);
  assert.doesNotMatch(body, /next 1–5|up to 5 steps|machine runs one task/);
  assert.match(prompt(null), /next 1–5/);
});

test('planner defaults to parallel feature parts only in rapid mode with free slots', () => {
  const render = (rapid) => plannerTurnPrompt(project, [], 'Add a feature', '', rapid);
  assert.match(render(rapidQueueTarget(14, 3, 2)), /decompose it into small parallel parts by default/);
  assert.match(render(rapidQueueTarget(14, 3, 2)), /Declare disjoint `files`/);
  assert.doesNotMatch(render(null), /Rapid development mode/);
  assert.doesNotMatch(render(rapidQueueTarget(14, 14, 2)), /Rapid development mode/);
});

test('near-limit guard requires every account, a 5h reading, and an unexpired window', () => {
  const windows = { claude: [{ window: 'five_hour', pct: 90, resetsAt: 200 }], codex: [{ window: '5h', pct: 95, resetsAt: 200 }] };
  const limited = () => rapidAgentsLimited(['claude', 'codex'], (a) => windows[a], 100);
  assert.equal(limited(), true);
  windows.codex[0].pct = 89;
  assert.equal(limited(), false);
  windows.codex[0].pct = 95; windows.codex[0].resetsAt = 99;
  assert.equal(limited(), false);
  windows.codex = [{ window: 'weekly', pct: 100 }];
  assert.equal(limited(), false);
  windows.codex = [];
  assert.equal(limited(), false);
  assert.equal(rapidAgentsLimited([], () => [], 100), false);
});

async function scenario(body, { live = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-'));
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
      const seen=[], released=new Set();
      const query=({prompt,options})=>(async function*(){
        seen.push(prompt);
        await until(()=>released.has(prompt) || options.abortController.signal.aborted);
        yield {type:'result',subtype:'success',result:'AGENT-ORCH-STATUS: done — verified',session_id:'test',num_turns:1};
      })();
      let windows = {}, limits = [];
      const o = createOrchestrator({ disabled: ${!live}, dataDir, claudeEnv: {}, query, config: {pollMs:50, parallelTasks:2,agentSlots:4,controllerWork:false,meminfo:${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)}},
        getLimits: () => limits, usageLog: { current: (a) => windows[a] || [], tokens(){}, windows(){}, limitCleared(){} }, onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => false });
      o.attachCluster({ listNodes: () => [{ id: 'worker', local: false, status: 'online', connected: true, enabled: true,
        maxSlots: 14, inventory: { cores: 14, agents: [] }, resources: { memAvailable: 40 * 2 ** 30, at: Date.now() } }], onMessage() {}, version: () => 1 });
      const db = new DatabaseSync(dataDir + '/orchestrator/agent-orch.db');
      const t = Date.now()/1000;
      const pid = Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,next_reflect_at,created_at) VALUES(?,'Example','active',1,?,0)").run(root,t+3600).lastInsertRowid);
      function task(title, status='queued', kind='work', after=null) {
        return Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,status,kind,depends_on,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(pid,title,title,status,kind,after,t-1000).lastInsertRowid);
      }
      task('Landed baseline','done');
      const reflections = () => db.prepare("SELECT * FROM tasks WHERE kind='reflect'").all();
      const result = await (async()=>{${body}})();
      console.log(JSON.stringify(result)); process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dir], { timeout: 15000 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('top-up fires below free cluster slots despite cooldown and excludes prerequisite/review holds', async () => {
  const r = await scenario(`
    for(let i=0;i<3;i++) task('Running '+i,'running');
    task('Ready one'); task('Ready two');
    const review=task('Owner review','awaiting_review','review'); task('Waiting on review','queued','work',review);
    const parent=task('Paused prerequisite','paused'); task('Waiting on parent','queued','work',parent);
    task('Review queued','queued','review'); task('Work in review','awaiting_review');
    const delayed=task('Backoff'); db.prepare('UPDATE tasks SET not_before=? WHERE id=?').run(t+1000,delayed);
    const state=o.stateView(); const added=o.scheduleReflections(), duplicate=o.scheduleReflections();
    return { rapid: state.rapid, enabled: state.parallel.rapidDevelopment, added, duplicate, count: reflections().length };`);
  assert.equal(r.enabled, true);
  assert.deepEqual([r.rapid.workers.slots, r.rapid.workers.running, r.rapid.ready, r.rapid.requested], [14, 3, 2, 11]);
  assert.equal(r.rapid.slots - r.rapid.running, r.rapid.free, 'the totals (head reserved slots included) add up');
  assert.equal(r.added, true);
  assert.equal(r.duplicate, false);
  assert.equal(r.count, 1);
  assert.match(prompt(r.rapid), /Queue the requested 11 tasks/);
});

test('top-up stops at free slots plus buffer; completed reflections keep the three minute floor', async () => {
  const r = await scenario(`
    for(let i=0;i<3;i++) task('Running '+i,'running');
    for(let i=0;i<13;i++) task('Ready '+i);
    const full=o.scheduleReflections();
    db.prepare("UPDATE tasks SET status='done' WHERE title='Ready 12'").run();
    const buffer=o.scheduleReflections();
    db.prepare("UPDATE tasks SET status='done' WHERE kind='reflect'").run();
    const recent=o.scheduleReflections();
    db.prepare("UPDATE tasks SET created_at=? WHERE kind='reflect'").run(t-181);
    const elapsed=o.scheduleReflections();
    db.prepare("UPDATE tasks SET created_at=? WHERE kind='reflect'").run(t-1000);
    const inflight=o.scheduleReflections();
    return {full,buffer,recent,elapsed,inflight};`);
  assert.deepEqual(r, { full: false, buffer: true, recent: false, elapsed: true, inflight: false });
});

test('all reflection accounts near 90% prevent top-up and explain the pause in status', async () => {
  const r = await scenario(`
    db.prepare('UPDATE projects SET reflect_fallbacks=? WHERE id=?').run(JSON.stringify([{agent:'codex',model:'test'}]),pid);
    limits=[{limit_type:'five_hour',utilization:0.92,resets_at:t+3600}];
    windows.codex=[{window:'5h',pct:94,resetsAt:t+3600}];
    const blocked=o.scheduleReflections(), status=o.stateView().rapid;
    limits[0].utilization=0.1; const listedOnly=o.scheduleReflections();
    windows.codex[0].pct=89;
    const resumes=o.scheduleReflections();
    return {blocked,status,listedOnly,resumes};`);
  assert.equal(r.blocked, false);
  assert.match(r.status.reason, /top-up paused.*90%.*5 h/);
  assert.equal(r.status.blockedProjects.length, 1);
  assert.equal(r.listedOnly, false, 'guard uses the owner fallback list, not unrelated account headroom');
  assert.equal(r.resumes, true);
});

test('switch off restores empty-queue reflection and the idle cooldown; setting validates and persists', async () => {
  const r = await scenario(`
    const invalid=o.setParallelSettings({rapidDevelopment:'false'});
    const saved=o.setParallelSettings({rapidDevelopment:false});
    task('Queued work'); const busy=o.scheduleReflections();
    db.prepare("UPDATE tasks SET status='done'").run(); const cooldown=o.scheduleReflections();
    db.prepare('UPDATE projects SET next_reflect_at=0').run(); const idle=o.scheduleReflections();
    return {invalid:!!invalid.error, enabled:saved.state.parallel.rapidDevelopment, rapid:saved.state.rapid,
      stored:JSON.parse(db.prepare("SELECT value FROM kv WHERE key='parallel_settings'").get().value).rapidDevelopment, busy,cooldown,idle};`);
  assert.deepEqual(r, { invalid:true, enabled:false, rapid:null, stored:false, busy:false, cooldown:false, idle:true });
});


test('live tick tops up beside isolated work and supplies the last 50 titles to the agent', async () => {
  const r = await scenario(`
    db.prepare('UPDATE projects SET perpetual=0 WHERE id=?').run(pid);
    for(let i=0;i<55;i++) task('History '+i,'done');
    const active=task('Active isolated work');
    await until(()=>seen.length===1);
    const firstPrompt=seen[0];
    task('Ready alpha'); task('Ready beta');
    db.prepare('UPDATE projects SET perpetual=1 WHERE id=?').run(pid);
    await until(()=>seen.some(p=>p.includes('Recent task history')));
    const reflection=seen.find(p=>p.includes('Recent task history'));
    const whileWorking=db.prepare('SELECT status FROM tasks WHERE id=?').get(active).status;
    released.add(firstPrompt);
    await until(()=>seen.length>=3);
    return {reflection,whileWorking,reflectionStatus:reflections()[0].status,started:seen.length};
  `, {live:true});
  assert.equal(r.whileWorking,'running','reflection must start before existing work finishes');
  assert.match(r.reflection,/14 slots, 1 running, 2 ready: queue about 13 more/);
  assert.match(r.reflection,/History 54/);
  assert.match(r.reflection,/Ready alpha/);
  assert.match(r.reflection,/Ready beta/);
  assert.doesNotMatch(r.reflection,/\bHistory 0\b/);
  assert.equal(r.reflectionStatus,'running','a free slot still accepts work while reflection runs');
  assert.equal(r.started,3);
});
