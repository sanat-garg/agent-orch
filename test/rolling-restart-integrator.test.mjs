// Rolling restart vs integrators (#459): a running integrator's agent session does not hold a restart. prepareRestart
// pauses it (session and worktree, with its half-done merge, kept) within seconds, and after a simulated restart (a second
// process on the same data dir) it resumes its session, re-runs its check and lands. Only the merge into main itself
// (restartBlocker) holds a rolling restart: one started while the merge is in flight waits for it and then proceeds.
// Each phase is its own child process with a fake Claude `query`; a slow pre-commit hook keeps the merge in flight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function phase(dataDir, repo, body) {
  const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
    import { createRollingRestart } from ${url('rolling.mjs')};
    import { setModelCatalog } from ${url('agents.mjs')};
    import { DatabaseSync } from 'node:sqlite';
    import fs from 'node:fs';
    import path from 'node:path';
    const [dataDir, repo] = process.argv.slice(1);
    setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: 1 });
    const calls = [];
    const query = ({ prompt, options }) => (async function* () {
      calls.push({ cwd: options.cwd, resume: options.resume || null });
      if (options.resume) {
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — merged', session_id: options.resume, num_turns: 1 };
        return;
      }
      fs.writeFileSync(path.join(options.cwd, 'wip.txt'), 'resolved\\n');
      yield { type: 'system', subtype: 'init', session_id: 's-I' };
      yield { type: 'assistant', session_id: 's-I', message: { content: [{ type: 'text', text: 'Resolving the conflicts' }] } };
      await new Promise((r) => options.abortController.signal.addEventListener('abort', r, { once: true })); // a long session
    })();
    const o = createOrchestrator({ config: { pollMs: 100, meminfo: ${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)} }, query, dataDir,
      claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false });
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    const events = () => db.prepare('SELECT message FROM events ORDER BY id').all().map((e) => e.message);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (f, n = 600) => { for (let i = 0; i < n && !f(); i++) await sleep(50); return !!f(); };
    const I = db.prepare("SELECT id FROM tasks WHERE title='integrate'").get().id, W = db.prepare("SELECT id FROM tasks WHERE title='owner'").get().id;
    const out = await (async () => { ${body} })();
    console.log(JSON.stringify(out));
    process.exit(0);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo], { encoding: 'utf8', timeout: 120000 });
  return JSON.parse(stdout.trim().split('\n').pop());
}

test('a long integrator session is paused for a restart and lands after it; only the merge itself holds a rolling restart', { timeout: 240000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-roll-int-'))), repo = path.join(root, 'proj');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-roll-int-data-'));
  try {
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
    // The owner's branch has its work; main moved on since, so the integrator has a merge of main to finish.
    const W = Number(execFileSync(process.execPath, ['--input-type=module', '-e', `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import path from 'node:path';
      const [dataDir, repo, check] = process.argv.slice(1);
      createOrchestrator({ query() {}, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false, disabled: true });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,'proj',50,'active',0,0)").run(repo).lastInsertRowid);
      const W = Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,priority,status,finished_at,created_at) VALUES(?,'owner','the work',50,'needs_integration',1,1)").run(pid).lastInsertRowid);
      db.prepare("INSERT INTO tasks(project_id,title,prompt,priority,done_when,integrates,created_at) VALUES(?,'integrate','merge it',50,?,?,2)").run(pid, check, W);
      console.log(W);
      process.exit(0);`, dataDir, repo, '`test -f wip.txt`'], { encoding: 'utf8' }).trim().split('\n').pop());
    git(repo, 'branch', `agent-orch/task-${W}`);
    git(repo, 'checkout', '-q', `agent-orch/task-${W}`);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'owner work\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'owner work');
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    git(repo, 'commit', '-qam', 'main moved');

    // The old process: the integrator's session runs (and would run for long); the restart does not wait for it.
    const a = await phase(dataDir, repo, `
      await until(() => get(I).status === 'running' && calls.length === 1);
      await sleep(300);
      const blocker = o.restartBlocker();
      const t0 = Date.now();
      const r = await o.prepareRestart({ planWaitMs: 0, pollMs: 50 });
      const t = get(I), wt = get(W).worktree;
      return { blocker, r, ms: Date.now() - t0, i: { status: t.status, session: t.session_id }, owner: get(W).status,
        wt: !!wt && fs.existsSync(path.join(wt, 'wip.txt')),
        kv: db.prepare("SELECT value FROM kv WHERE key='restart_paused'").get()?.value, I, W };`);
    assert.equal(a.W, W);
    assert.equal(a.blocker, '', 'a running integrator session does not block a restart');
    assert.equal(a.r.ok, true, JSON.stringify(a.r));
    assert.ok(a.ms < 60e3, `prepareRestart took ${a.ms} ms`);
    assert.deepEqual(a.r.paused, [a.I]);
    assert.deepEqual(a.i, { status: 'paused', session: 's-I' }, 'the integrator is paused with its session');
    assert.equal(a.owner, 'needs_integration');
    assert.equal(a.wt, true, 'its worktree and work are kept');
    assert.equal(a.kv, JSON.stringify([a.I]));

    // The merge into main is slow now (a pre-commit hook), so a rolling restart meets it in flight.
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nsleep 2\n');
    fs.chmodSync(hook, 0o755);

    // The new process: the integrator resumes its session, re-runs its check and lands; a rolling restart started
    // during the merge waits for exactly that merge and then goes through.
    const b = await phase(dataDir, repo, `
      let blocked = '';
      await until(() => (blocked = o.restartBlocker()) !== '');
      const logs = [], t0 = Date.now();
      let exited = null;
      const r = createRollingRestart({ stateFile: path.join(dataDir, 'restart.json'), head: async () => 'h2', changed: async () => ['orchestrator.mjs'],
        version: async () => '1.00', preflight: async () => '', busy: () => '', merging: () => o.restartBlocker(),
        prepare: () => o.prepareRestart({ waitMs: 30000, planWaitMs: 0, pollMs: 50 }), resume: async () => {}, chatIdle: () => true,
        exit: (code) => { exited = { code, ms: Date.now() - t0, blocker: o.restartBlocker(), i: get(I).status, owner: get(W).status }; },
        log: (m) => logs.push(m), cfg: { pollMs: 50 } });
      r.restartNow();
      await until(() => exited, 1200);
      return { blocked, exited, logs, resumes: calls.map((c) => c.resume), events: events(),
        main: fs.readFileSync(path.join(repo, 'wip.txt'), 'utf8'), b: fs.readFileSync(path.join(repo, 'b.txt'), 'utf8') };`);
    assert.match(b.blocked, new RegExp(`^integrator #${a.I} is merging$`));
    assert.deepEqual(b.resumes, ['s-I'], 'the integrator continued its session');
    assert.ok(b.events.some((m) => m.startsWith(`▶ #${a.I} resumed after the restart (same session)`)), b.events.join('\n'));
    assert.ok(b.events.some((m) => m.startsWith(`checking #${a.I}: test -f wip.txt`)), 'its check ran again');
    assert.ok(b.logs.some((m) => m === `rolling: waiting (integrator #${a.I} is merging)`), b.logs.join('\n'));
    assert.ok(b.exited, `the restart went through: ${b.logs.join('\n')}`);
    assert.equal(b.exited.code, 0);
    assert.equal(b.exited.blocker, '', 'it exited only after the merge');
    assert.deepEqual([b.exited.i, b.exited.owner], ['done', 'done'], 'the integrator landed first');
    assert.ok(b.exited.ms < 60e3, `waited ${b.exited.ms} ms`);
    assert.equal(b.main, 'resolved\n');
    assert.equal(b.b, 'owner work\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
