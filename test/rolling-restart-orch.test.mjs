// Rolling restart, orchestrator half (#426): prepareRestart pauses the head's own running task (session and worktree
// kept) and leaves a worker's job alone (no job.cancel, still running there); after a simulated restart (a second
// process on the same data dir) the paused task resumes its session by itself and the worker job is re-adopted (#220).
// Each phase is its own child process with a fake Claude `query` and a fake cluster hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A phase: the orchestrator boots on dataDir with the fake hub attached at once (before any tick could requeue the
// worker's task), the worker says hello listing its job, then `body` runs; its value is printed as the last line.
async function phase(dataDir, repo, body) {
  const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
    import { setModelCatalog } from ${url('agents.mjs')};
    import { MSG } from ${url('cluster-protocol.mjs')};
    import { DatabaseSync } from 'node:sqlite';
    import fs from 'node:fs';
    import path from 'node:path';
    const [dataDir, repo] = process.argv.slice(1);
    setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: 1 });
    const calls = [];
    const query = ({ prompt, options }) => (async function* () {
      calls.push({ cwd: options.cwd, resume: options.resume || null });
      if (options.resume) {
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: options.resume, num_turns: 1 };
        return;
      }
      fs.writeFileSync(path.join(options.cwd, 'wip.txt'), 'half done\\n');
      yield { type: 'system', subtype: 'init', session_id: 's-L' };
      yield { type: 'assistant', session_id: 's-L', message: { content: [{ type: 'text', text: 'Halfway there' }] } };
      await new Promise((r) => options.abortController.signal.addEventListener('abort', r, { once: true }));
    })();
    const sent = [];
    let onMsg = null;
    const worker = { id: 'w1', name: 'Mac', local: false, status: 'online', connected: true, enabled: true, graceMs: 600000, inventory: { agents: [] } };
    const hub = { onMessage: (f) => { onMsg = f; }, setBusy() {}, setUpNext() {}, setLocalCapacity() {}, autoDrain() {}, version: () => 1,
      listNodes: () => [worker], node: (id) => (id === 'w1' ? worker : null), isConnected: (id) => id === 'w1',
      send: (node, m) => { sent.push({ node, ...m }); return true; } };
    const o = createOrchestrator({ config: { pollMs: 100, meminfo: ${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)} }, query, dataDir,
      claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false });
    o.attachCluster(hub);
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    const events = () => db.prepare('SELECT message FROM events ORDER BY id').all().map((e) => e.message);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (f) => { for (let i = 0; i < 300 && !f(); i++) await sleep(100); return !!f(); };
    const R = db.prepare("SELECT id FROM tasks WHERE title='remote'").get().id, L = db.prepare("SELECT id FROM tasks WHERE title='local'").get().id;
    onMsg('w1', { t: MSG.HELLO, jobs: [{ job: R }] });
    const out = await (async () => { ${body} })();
    console.log(JSON.stringify(out));
    process.exit(0);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo], { encoding: 'utf8', timeout: 90000 });
  return JSON.parse(stdout.trim().split('\n').pop());
}

test('a rolling restart pauses head tasks and resumes them after boot; worker jobs keep running and are re-adopted', { timeout: 180000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-roll-'))), repo = path.join(root, 'proj');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-roll-data-'));
  try {
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
    // The DB as a restart finds it: a local work task queued, and a work task running on worker w1 with an open run.
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, repo] = process.argv.slice(1);
      createOrchestrator({ query() {}, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false, disabled: true });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,'proj',50,'active',0,0)").run(repo).lastInsertRowid);
      db.prepare("INSERT INTO tasks(project_id,title,prompt,priority,done_when,created_at) VALUES(?,'local','work here',50,'wip.txt exists',1)").run(pid);
      const R = Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,priority,status,node_id,ran_agent,started_at,created_at) VALUES(?,'remote','work there',50,'running','w1','claude',1,2)").run(pid).lastInsertRowid);
      const log = path.join(dataDir, 'remote-run.jsonl');
      fs.writeFileSync(log, JSON.stringify({ k: 'start', at: 1, agent: 'claude', node: 'w1' }) + '\\n' + JSON.stringify({ k: 'text', text: 'working', i: 0 }) + '\\n');
      db.prepare("INSERT INTO runs(task_id,purpose,started_at,log_path,node_id,agent) VALUES(?,'work',1,?,'w1','claude')").run(R, log);
      process.exit(0);`, dataDir, repo]);

    // The old process: the local task runs, then prepareRestart pauses it and leaves the worker's job alone.
    const a = await phase(dataDir, repo, `
      await until(() => get(L).status === 'running' && calls.length === 1);
      await sleep(300); // the session has started (its id is kept when it stops)
      const busy = { runningR: o.isRunning(R), blocker: o.restartBlocker() };
      const r = await o.prepareRestart({ waitMs: 20000, planWaitMs: 0, pollMs: 50 });
      const l = get(L), rem = get(R);
      return { busy, r, l: { status: l.status, session: l.session_id, worktree: !!l.worktree && fs.existsSync(l.worktree) },
        rem: { status: rem.status, node: rem.node_id }, stillRunningR: o.isRunning(R), runningL: o.isRunning(L),
        sent: sent.map((m) => m.t), kv: db.prepare("SELECT value FROM kv WHERE key='restart_paused'").get()?.value, draining: o.stateView().draining };`);
    assert.deepEqual(a.busy, { runningR: true, blocker: '' }, 'a running worker job does not block a restart');
    assert.equal(a.r.ok, true, JSON.stringify(a.r));
    assert.equal(a.r.paused.length, 1);
    assert.deepEqual(a.l, { status: 'paused', session: 's-L', worktree: true }, 'the head task is paused with its session and worktree');
    assert.equal(a.runningL, false);
    assert.deepEqual(a.rem, { status: 'running', node: 'w1' }, 'the worker job is untouched');
    assert.equal(a.stillRunningR, true);
    assert.ok(!a.sent.includes('job.cancel'), `no job.cancel sent: ${a.sent}`);
    assert.deepEqual(a.sent, ['job.attach']);
    assert.equal(a.kv, JSON.stringify(a.r.paused));
    assert.equal(a.draining, true);

    // The new process: the paused task resumes by itself (same session) and the worker job is re-adopted and attached.
    const b = await phase(dataDir, repo, `
      await until(() => get(L).status === 'done');
      const rem = get(R);
      return { l: get(L).status, resumes: calls.map((c) => c.resume), rem: { status: rem.status, node: rem.node_id }, runningR: o.isRunning(R),
        attach: sent.filter((m) => m.t === 'job.attach').map((m) => ({ job: m.job, from: m.from })), cancels: sent.filter((m) => m.t === 'job.cancel').length,
        events: events(), kv: db.prepare("SELECT value FROM kv WHERE key='restart_paused'").get()?.value, R, L,
        runs: db.prepare('SELECT COUNT(*) AS n FROM runs WHERE task_id=?').get(R).n };`);
    assert.equal(b.l, 'done');
    assert.deepEqual(b.resumes, ['s-L'], 'the paused task continued its session');
    assert.ok(b.events.some((m) => m.startsWith(`▶ #${b.L} resumed after the restart (same session)`)), b.events.join('\n'));
    assert.ok(b.events.some((m) => m.startsWith(`⏸ #${b.L} paused for a restart`)));
    assert.ok(b.events.some((m) => m.startsWith(`#${b.R} re-adopted after a restart`)), 'the worker job was re-adopted');
    assert.deepEqual(b.rem, { status: 'running', node: 'w1' });
    assert.equal(b.runningR, true);
    assert.deepEqual(b.attach, [{ job: b.R, from: 1 }], 'the stream continues after the last logged event');
    assert.equal(b.cancels, 0);
    assert.equal(b.runs, 1, 'the run was re-adopted, not restarted');
    assert.equal(b.kv, '[]');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
