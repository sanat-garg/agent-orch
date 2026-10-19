// Leaving Orchestrator Mode closes the project's intake (projects.intake=0): queued and running tasks carry on, but no
// reflection, Rapid top-up or planner turn adds work until the chat returns. Pause stays the way to stop work.
// createOrchestrator runs in a child process with a fake Claude `query` (as in pause-handoff.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// `body` runs with: o (the orchestrator), db, pid (project 'proj' at `repo`, chat 'c1'), add(title, prompt, after?),
// get(id), reflections(), until(fn), sleep(ms), release(prompt). The fake agent: a prompt with HOLD works until
// released (or aborted); any other work finishes at once; a reflection proposes one QUICK task.
async function scenario(body, { dataDir, mode = 'orchestrator', setup = '' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-intake-'))), repo = path.join(root, 'proj');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  const own = !dataDir;
  dataDir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'cw-intake-data-'));
  try {
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { setModelCatalog } from ${url('agents.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, repo] = process.argv.slice(1);
      setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: 1 });
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (f, n = 150) => { for (let i = 0; i < n && !f(); i++) await sleep(100); return !!f(); };
      const released = new Set(), release = (p) => released.add(p);
      const REPLY = 'One next step.\\n\\n\\\`\\\`\\\`agent-orch-tasks\\n' + JSON.stringify({ tasks: [{ title: 'Proposed', prompt: 'QUICK' }] }) + '\\n\\\`\\\`\\\`';
      const query = ({ prompt, options }) => (async function* () {
        const reflect = !/HOLD|QUICK/.test(prompt);
        if (/HOLD/.test(prompt)) await until(() => [...released].some((r) => prompt.includes(r)) || options.abortController.signal.aborted, 300);
        if (options.abortController.signal.aborted) return;
        fs.writeFileSync(path.join(options.cwd, 'out-' + Math.random().toString(36).slice(2) + '.txt'), 'x\\n');
        yield { type: 'result', subtype: 'success', result: reflect ? REPLY : 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 };
      })();
      ${setup}
      const o = createOrchestrator({ config: { pollMs: 100, parallelTasks: 4, meminfo: ${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)} }, query, dataDir,
        claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true, broadcast() {}, emitChat() {},
        convoExists: (c) => c === 'c1', convoMode: (c) => (c === 'c1' ? ${JSON.stringify(mode)} : c === 'c-orch' ? 'orchestrator' : null) });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      let pid = db.prepare('SELECT id FROM projects WHERE path=?').get(repo)?.id;
      pid ??= Number(db.prepare("INSERT INTO projects(path,name,convo_id,status,perpetual,next_reflect_at,created_at) VALUES(?,'proj','c1','active',1,?,0)")
        .run(repo, Date.now() / 1000 + 3600).lastInsertRowid);
      const add = (title, prompt, after = null) => Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,priority,depends_on,created_at) VALUES(?,?,?,50,?,1)')
        .run(pid, title, prompt, after).lastInsertRowid);
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      const project = () => db.prepare('SELECT status, intake FROM projects WHERE id=?').get(pid);
      const reflections = () => db.prepare("SELECT id, status FROM tasks WHERE kind='reflect' ORDER BY id").all();
      const convo = { id: 'c1', cwd: repo, model: '' };
      const out = await (async () => { ${body} })();
      console.log(JSON.stringify(out));
      process.exit(0);`;
    fs.mkdirSync(path.join(dataDir, 'orchestrator'), { recursive: true });
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo], { timeout: 60000 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (own) fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('leaving the mode: a running task keeps running, a queued one is claimed, and no reflection is created', async () => {
  const r = await scenario(`
    o.setParallelSettings({ rapidDevelopment: false }); // reflection follows an empty queue and next_reflect_at
    const a = add('Long one', 'HOLD-A'), b = add('Next one', 'QUICK-B', a);
    await until(() => o.isRunning(a));
    o.setConvoMode(convo, 'default');
    const after = project(), stillRunning = o.isRunning(a), view = o.projectFor(convo).intake;
    db.prepare('UPDATE projects SET next_reflect_at=0').run(); // a reflection would be due now
    release('HOLD-A');
    await until(() => get(b).status === 'done');
    await sleep(800); // a few ticks with an empty queue and reflection due
    return { after, stillRunning, view, a: get(a).status, b: get(b).status, scheduled: o.scheduleReflections(), reflections: reflections() };`);
  assert.deepEqual(r.after, { status: 'active', intake: 0 });
  assert.equal(r.stillRunning, true);
  assert.equal(r.view, false);
  assert.equal(r.a, 'done');
  assert.equal(r.b, 'done');
  assert.equal(r.scheduled, false);
  assert.deepEqual(r.reflections, []);
});

test('intake closed: a waiting reflection is cancelled; returning to the mode reopens intake and reflection runs', async () => {
  const r = await scenario(`
    db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(add('Landed', 'QUICK')); // reflection needs landed work
    const waiting = add('Reflect: what else should be done?', '(reflection)');
    db.prepare("UPDATE tasks SET kind='reflect' WHERE id=?").run(waiting);
    o.setParallelSettings({ rapidDevelopment: false }); // reflection follows an empty queue and next_reflect_at
    db.prepare("UPDATE projects SET status='paused'").run(); // held so the scheduler can't claim it first
    o.setConvoMode(convo, 'default');
    const cancelled = get(waiting).status;
    db.prepare("UPDATE projects SET status='active'").run();
    await sleep(500);
    const whileClosed = reflections().length;
    o.setConvoMode(convo, 'orchestrator');
    const reopened = project();
    await until(() => reflections().some((t) => t.status === 'done'));
    return { cancelled, whileClosed, reopened, reflections: reflections().map((t) => t.status) };`);
  assert.equal(r.cancelled, 'cancelled');
  assert.equal(r.whileClosed, 1); // only the cancelled one
  assert.deepEqual(r.reopened, { status: 'active', intake: 1 });
  assert.deepEqual(r.reflections.slice(0, 2), ['cancelled', 'done']);
});

test('Pause still pauses: the running task stops and nothing is claimed until Resume', async () => {
  const r = await scenario(`
    const a = add('Long one', 'HOLD-A');
    await until(() => o.isRunning(a));
    o.setConvoMode(convo, 'default');
    o.projectAction(pid, { status: 'paused' });
    await until(() => !o.isRunning(a));
    await sleep(500);
    const paused = { project: project(), running: o.isRunning(a), status: get(a).status };
    release('HOLD-A');
    o.projectAction(pid, { status: 'active' });
    await until(() => get(a).status === 'done');
    return { paused, done: get(a).status, project: project() };`);
  assert.deepEqual(r.paused.project, { status: 'paused', intake: 0 });
  assert.equal(r.paused.running, false);
  assert.notEqual(r.paused.status, 'running');
  assert.equal(r.done, 'done');
  assert.deepEqual(r.project, { status: 'active', intake: 0 });
});

test('migration: a project paused by leaving the mode resumes with intake closed; others are left alone', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-intake-mig-'));
  try {
    // An existing DB from before #2247: no intake column, three paused projects.
    fs.mkdirSync(path.join(dataDir, 'orchestrator'), { recursive: true });
    const r = await scenario(`
      return { project: project(), events: db.prepare('SELECT message FROM events').all().map((e) => e.message),
        others: db.prepare("SELECT name, status, intake FROM projects WHERE name!='proj' ORDER BY name").all() };`, {
      dataDir, mode: 'default', setup: `
      { const { DatabaseSync } = await import('node:sqlite');
        const d = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
        d.exec(\`CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL, convo_id TEXT,
          status TEXT NOT NULL DEFAULT 'active', priority INTEGER NOT NULL DEFAULT 50, mode TEXT NOT NULL DEFAULT 'build',
          model TEXT, perpetual INTEGER NOT NULL DEFAULT 1, autonomous INTEGER NOT NULL DEFAULT 0,
          chat_session_id TEXT, next_reflect_at REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL)\`);
        const ins = d.prepare("INSERT INTO projects(path,name,convo_id,status,next_reflect_at,created_at) VALUES(?,?,?,'paused',?,0)");
        ins.run(repo, 'proj', 'c1', Date.now() / 1000 + 3600);
        ins.run(repo + '-orch', 'still-orch', 'c-orch', 0);
        ins.run(repo + '-gone', 'no-chat', 'c-gone', 0);
        d.close(); }`,
    });
    assert.deepEqual(r.project, { status: 'active', intake: 0 });
    assert.ok(r.events.some((e) => /^proj: resumed/.test(e)), r.events.join('\n'));
    assert.deepEqual(r.others, [{ name: 'no-chat', status: 'paused', intake: 1 }, { name: 'still-orch', status: 'paused', intake: 1 }]);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
