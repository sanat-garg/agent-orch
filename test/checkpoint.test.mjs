// Review checkpoints (kind 'review'): they never run an agent, wait for the owner once their prerequisite is done,
// and hold back what depends on them until approved; request-changes queues a fix first and re-arms the checkpoint.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractTasks } from '../orchestrator.mjs';

const ORCH = JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href);

// Same harness as reorder.test.mjs: a child process with a fake query(); rows go straight into its DB.
async function scenario(body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-review-')), root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-review-p-'));
  try {
    const script = `import { createOrchestrator } from ${ORCH};
      import { DatabaseSync } from 'node:sqlite';
      import { execFileSync } from 'node:child_process';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      const prompts = [];
      const query = ({ prompt, options }) => (async function* () {
        prompts.push(prompt);
        await new Promise((r) => { const t = setTimeout(r, 100); options.abortController.signal.addEventListener('abort', () => { clearTimeout(t); r(); }); });
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 };
      })();
      const chat = [];
      const o = createOrchestrator({ query, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true, config: { pollMs: 100, worktrees: false },
        broadcast() {}, emitChat(c, m) { chat.push(m); }, convoExists: () => true });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      let n = 0;
      const project = (status = 'active') => {
        const p = path.join(root, 'p' + ++n); fs.mkdirSync(p);
        return Number(db.prepare("INSERT INTO projects(path,name,convo_id,priority,status,perpetual,created_at) VALUES(?,?,'c1',50,?,0,0)").run(p, 'p' + n, status).lastInsertRowid);
      };
      let pos = 0;
      const task = (pid, title, { dependsOn = null } = {}) =>
        Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,priority,urgency,depends_on,source,position,created_at) VALUES(?,?,?,50,'normal',?,'planner',?,?)")
          .run(pid, title, title, dependsOn, ++pos, pos).lastInsertRowid);
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      const deps = (id) => db.prepare('SELECT depends_on FROM all_deps WHERE task_id=? ORDER BY depends_on').all(id).map((r) => r.depends_on);
      const view = (id) => o.taskDetail(id).task;
      const order = (pid) => db.prepare("SELECT title FROM tasks WHERE project_id=? AND status='queued' ORDER BY position").all(pid).map((r) => r.title);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (f) => { for (let i = 0; i < 1200 && !f(); i++) await sleep(50); return f(); };
      const out = await (async () => { ${body} })();
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root], { encoding: 'utf8', timeout: 90000 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('review checkpoints', { concurrency: true, timeout: 120000 }, () => {
  test('dependents wait while it awaits review; approve releases them', async () => {
    const r = await scenario(`
      const p = project('paused');
      const a = task(p, 'a'), b = task(p, 'b', { dependsOn: a }), c = task(p, 'c', { dependsOn: b });
      const ins = o.insertCheckpoint(a), cp = ins.task.id;
      const again = o.insertCheckpoint(a);
      const early = o.approveCheckpoint(cp);
      const relinked = { b: deps(b), cp: deps(cp) };
      o.projectAction(p, { status: 'active' });
      const armed = await until(() => get(cp).status === 'awaiting_review');
      await sleep(800); // several ticks: nothing after the checkpoint may start
      const held = { b: get(b).status, c: get(c).status, runs: db.prepare('SELECT COUNT(*) AS n FROM runs WHERE task_id=?').get(cp).n };
      const v = view(cp);
      const approved = o.approveCheckpoint(cp);
      await until(() => get(c).status === 'done');
      return { a, b, cp, ins: ins.ok, kind: v.kind, again: again.status, early: early.status, relinked, armed, held, review: v.review,
        approved: approved.ok, after: { cp: get(cp).status, b: get(b).status, c: get(c).status }, summary: view(cp).summary,
        notice: chat.some((m) => m.t === 'notice' && /Review break/.test(m.text)), cards: chat.find((m) => m.t === 'tasks' && m.source === 'review')?.ids };`);
    assert.equal(r.ins, true);
    assert.equal(r.kind, 'review');
    assert.equal(r.again, 409);
    assert.equal(r.early, 409);
    assert.deepEqual(r.relinked, { b: [r.cp], cp: [r.a] });
    assert.equal(r.armed, true);
    assert.deepEqual(r.held, { b: 'queued', c: 'queued', runs: 0 });
    assert.equal(r.review.task, r.a);
    assert.equal(r.approved, true);
    assert.deepEqual(r.after, { cp: 'done', b: 'done', c: 'done' });
    assert.equal(r.summary, 'Approved');
    assert.equal(r.notice, true);
    assert.deepEqual(r.cards, [r.cp]);
  });

  test('request changes queues a fix task with the note and diff, then re-arms the checkpoint', async () => {
    const r = await scenario(`
      const p = project();
      const dir = path.join(root, 'p1'), g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
      g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'widget.js'), 'export const colour = "red";\\n'); g('add', '.'); g('commit', '-qm', 'widget');
      const sha = g('rev-parse', 'HEAD');
      const a = task(p, 'a'), b = task(p, 'b', { dependsOn: a });
      db.prepare('UPDATE tasks SET status=?, commit_sha=?, result=?, finished_at=1 WHERE id=?').run('done', sha, 'AGENT-ORCH-STATUS: done — widget added', a);
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run('running', a); // the review break goes after a running task
      const cp = o.insertCheckpoint(a).task.id;
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run('done', a);
      await until(() => view(cp).review?.files?.length);
      const first = view(cp).review;
      const empty = await o.requestChanges(cp, '  ');
      const res = await o.requestChanges(cp, 'Make it blue');
      const fix = get(res.fix);
      const rearmedAt = { cp: get(cp).status, cpDeps: deps(cp), b: get(b).status };
      await until(() => get(res.fix).status === 'done' && get(cp).status === 'awaiting_review');
      await sleep(500);
      const second = { cp: get(cp).status, b: get(b).status, reviewed: view(cp).review?.task };
      o.approveCheckpoint(cp);
      await until(() => get(b).status === 'done');
      return { a, b, cp, sha, first, empty: empty.status, fixPrompt: fix.prompt, fixDeps: deps(res.fix), fixKind: fix.kind, rearmedAt, second, fixId: res.fix,
        ranFix: prompts.some((x) => /Make it blue/.test(x)), final: get(b).status };`);
    assert.equal(r.first.task, r.a);
    assert.equal(r.first.summary, 'widget added');
    assert.deepEqual(r.first.files, [{ status: 'A', path: 'widget.js' }]);
    assert.equal(r.empty, 400);
    assert.equal(r.fixKind, 'work');
    assert.match(r.fixPrompt, /Make it blue/);
    assert.match(r.fixPrompt, /widget\.js/);
    assert.match(r.fixPrompt, /colour = "red"/);
    assert.deepEqual(r.fixDeps, [r.a]);
    assert.deepEqual(r.rearmedAt, { cp: 'queued', cpDeps: [r.a, r.fixId].sort((x, y) => x - y), b: 'queued' });
    assert.equal(r.ranFix, true);
    assert.deepEqual(r.second, { cp: 'awaiting_review', b: 'queued', reviewed: r.fixId });
    assert.equal(r.final, 'done');
  });

  test('a checkpoint moves with its prerequisite and dependents; removing it re-links them', async () => {
    const r = await scenario(`
      const p = project('paused');
      const z = task(p, 'z'), a = task(p, 'a'), b = task(p, 'b', { dependsOn: a });
      const cp = o.insertCheckpoint(a).task.id;
      db.prepare('UPDATE tasks SET title=? WHERE id=?').run('cp', cp);
      const before = order(p);
      const moved = o.moveTask(a, { before: z });
      const after = order(p);
      o.taskAction(cp, 'cancel');
      return { before, moved: moved.ok, after, bDeps: deps(b), bStatus: get(b).status, a };`);
    assert.deepEqual(r.before, ['z', 'a', 'cp', 'b']);
    assert.equal(r.moved, true);
    assert.deepEqual(r.after, ['a', 'cp', 'b', 'z']);
    assert.deepEqual(r.bDeps, [r.a]);
    assert.equal(r.bStatus, 'queued');
  });

  test('the tasks block accepts review breaks', () => {
    const [, payload] = extractTasks('```agent-orch-tasks\n{"tasks": [{"title": "New schema", "prompt": "p"}, {"kind": "review", "title": "Check the schema", "after": 0}, {"title": "Use it", "prompt": "q", "after": 1}]}\n```');
    assert.deepEqual(payload.tasks.map((t) => [t.kind || 'work', t.title, t.after]), [['work', 'New schema', null], ['review', 'Check the schema', 0], ['work', 'Use it', 1]]);
  });
});
