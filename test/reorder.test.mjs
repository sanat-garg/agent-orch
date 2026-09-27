// Manual queue order: tasks.position, moveTask (subtree moves as a block, prerequisites stay ahead), scheduler order.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ORCH = JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href);

// Same harness as scheduling.test.mjs: a child process with a fake query(); rows go straight into its DB.
async function scenario(body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-order-')), root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-order-p-'));
  try {
    const script = `import { createOrchestrator } from ${ORCH};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      const query = ({ options }) => (async function* () {
        await new Promise((r) => { const t = setTimeout(r, 200); options.abortController.signal.addEventListener('abort', () => { clearTimeout(t); r(); }); });
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 };
      })();
      const sent = [];
      const o = createOrchestrator({ query, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
        broadcast(m) { sent.push(m); }, emitChat() {}, convoExists: () => false });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      let n = 0;
      const project = (status = 'paused') => {
        const p = path.join(root, 'p' + ++n); fs.mkdirSync(p);
        return Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,?,50,?,0,0)").run(p, 'p' + n, status).lastInsertRowid);
      };
      let pos = 0;
      const task = (pid, title, { urgency = 'normal', dependsOn = null } = {}) =>
        Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,priority,urgency,depends_on,source,position,created_at) VALUES(?,?,?,?,?,?,'planner',?,?)")
          .run(pid, title, title, { urgent: 85, normal: 50, background: 20 }[urgency], urgency, dependsOn, ++pos, pos).lastInsertRowid);
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      const order = (pid) => db.prepare("SELECT title FROM tasks WHERE project_id=? AND status='queued' ORDER BY position").all(pid).map((r) => r.title);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (f) => { for (let i = 0; i < 400 && !f(); i++) await sleep(100); };
      const settled = () => !db.prepare("SELECT 1 FROM tasks WHERE status IN ('queued','running')").get();
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

describe('queue reorder', { concurrency: true, timeout: 120000 }, () => {
  test('moving a task moves its dependent subtree as a block, keeping their order', async () => {
    const r = await scenario(`
      const p = project();
      const a = task(p, 'a'), b = task(p, 'b'), x = task(p, 'x'), c = task(p, 'c', { dependsOn: b }), d = task(p, 'd', { dependsOn: c }), e = task(p, 'e', { dependsOn: b });
      const before = order(p);
      const res = o.moveTask(b, { before: a });
      const snap = o.convoSnapshot({ cwd: path.join(root, 'p1') }).tasks.find((t) => t.id === c);
      return { before, after: order(p), res, msg: sent.find((m) => m.t === 'oorder'), snap, b, c, d, e };`);
    assert.deepEqual(r.before, ['a', 'b', 'x', 'c', 'd', 'e']);
    assert.equal(r.res.ok, true);
    assert.deepEqual(r.after, ['b', 'c', 'd', 'e', 'a', 'x']);
    assert.deepEqual(r.msg.order.map((t) => t.id), r.res.order.map((t) => t.id));
    assert.deepEqual(r.snap.prereqs, [r.b]);
    assert.deepEqual(r.snap.dependents, [r.d]);
    assert.equal(typeof r.snap.position, 'number');
  });

  test('a move above a prerequisite is rejected and changes nothing', async () => {
    const r = await scenario(`
      const p = project();
      const a = task(p, 'a'), b = task(p, 'b'), c = task(p, 'c', { dependsOn: b }), d = task(p, 'd', { dependsOn: c }), z = task(p, 'z');
      const above = o.moveTask(c, { before: a });   // c ahead of its prerequisite b
      const deep = o.moveTask(d, { after: a });     // d ahead of c (its root's chain)
      const into = o.moveTask(b, { after: c });     // into its own subtree
      db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(z);
      const done = o.moveTask(z, { before: a });
      const ok = o.moveTask(c, { after: b });       // right after its prerequisite is fine
      return { above, deep, into, done, ok: ok.ok, order: order(p), moved: sent.filter((m) => m.t === 'oorder').length };`);
    assert.equal(r.above.status, 409);
    assert.match(r.above.error, /prerequisite #\d+/);
    assert.equal(r.deep.status, 409);
    assert.equal(r.into.status, 409);
    assert.equal(r.done.status, 409);
    assert.equal(r.ok, true);
    assert.deepEqual(r.order, ['a', 'b', 'c', 'd']);
    assert.equal(r.moved, 1);
  });

  test('the scheduler follows the manual order over urgency', async () => {
    const r = await scenario(`
      const p = project('paused');
      const urgent = task(p, 'urgent', { urgency: 'urgent' }), normal = task(p, 'normal'), bg = task(p, 'bg', { urgency: 'background' });
      o.moveTask(bg, { before: urgent });
      o.projectAction(p, { status: 'active' });
      await until(settled);
      const ids = { urgent, normal, bg };
      return { statuses: Object.values(ids).map((id) => get(id).status),
        order: Object.keys(ids).sort((a, b) => get(ids[a]).started_at - get(ids[b]).started_at) };`);
    assert.deepEqual(r.statuses, ['done', 'done', 'done']);
    assert.deepEqual(r.order, ['bg', 'urgent', 'normal']);
  });
});

// Sidebar project order: reorderProjects sets projects.position and derives priority from the place in the list.
describe('project order', { concurrency: true, timeout: 120000 }, () => {
  test('reordering sets positions and spreads priority 90 → 10; projects left out follow; new projects join the bottom', async () => {
    const r = await scenario(`
      const a = project(), b = project(), c = project(), hidden = project();
      const rows = () => db.prepare('SELECT id, position, priority FROM projects ORDER BY position').all().map((p) => ({ ...p }));
      const bad = [o.reorderProjects([]), o.reorderProjects('x'), o.reorderProjects([a, a]), o.reorderProjects([a, 1.5]), o.reorderProjects([a, 999])];
      const res = o.reorderProjects([c, a, b]);
      const after = rows();
      const msg = sent.filter((m) => m.t === 'oprojects').pop();
      const dir = path.join(root, 'fresh'); fs.mkdirSync(dir);
      o.setConvoMode({ id: 'c-new', cwd: dir, model: '' }, 'orchestrator');
      const fresh = db.prepare('SELECT id FROM projects WHERE path=?').get(dir).id;
      return { ids: { a, b, c, hidden, fresh }, bad: bad.map((x) => x.status), res, after, msg, withNew: rows() };`);
    const { a, b, c, hidden, fresh } = r.ids;
    assert.deepEqual(r.bad, [400, 400, 400, 400, 404]);
    assert.equal(r.res.ok, true);
    assert.deepEqual(r.after, [{ id: c, position: 1, priority: 90 }, { id: a, position: 2, priority: 63 }, { id: b, position: 3, priority: 37 }, { id: hidden, position: 4, priority: 10 }]);
    assert.deepEqual(r.msg.order.map((p) => [p.id, p.position, p.priority]), r.after.map((p) => [p.id, p.position, p.priority]));
    assert.ok(r.msg.order.every((p) => typeof p.path === 'string'));
    assert.deepEqual(r.withNew.map((p) => p.id), [c, a, b, hidden, fresh]);
    assert.deepEqual(r.withNew.map((p) => p.priority), [90, 70, 50, 30, 10]);
  });

  test('the scheduler prefers the top project\'s ready task', async () => {
    const r = await scenario(`
      // Without an order, bottom's task would go first: its project outranks and its task is older.
      const bottom = project(), top = project();
      db.prepare('UPDATE projects SET priority=80 WHERE id=?').run(bottom);
      const old = task(bottom, 'bottom task'), fresh = task(top, 'top task');
      const res = o.reorderProjects([top, bottom]);
      o.projectAction(bottom, { status: 'active' });
      o.projectAction(top, { status: 'active' });
      await until(settled);
      return { ok: res.ok, first: get(fresh).started_at < get(old).started_at, statuses: [get(old).status, get(fresh).status] };`);
    assert.equal(r.ok, true);
    assert.deepEqual(r.statuses, ['done', 'done']);
    assert.equal(r.first, true, 'the top project\'s task started first');
  });
});
