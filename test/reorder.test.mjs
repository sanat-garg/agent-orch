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

  // convoSnapshot loads the dependency graph once (withDeps) instead of querying per task: same answers as one task alone.
  test("a chat's snapshot gives each task the same deps, prereqs and dependents as its own view", async () => {
    const r = await scenario(`
      const p = project();
      const a = task(p, 'a'), b = task(p, 'b', { dependsOn: a }), c = task(p, 'c'), d = task(p, 'd', { dependsOn: c }), e = task(p, 'e');
      const f = task(p, 'f'), g = task(p, 'g', { dependsOn: f });
      const link = (t, up) => db.prepare('INSERT INTO task_deps(task_id, depends_on) VALUES(?,?)').run(t, up);
      link(d, a); link(d, b); link(e, d); link(e, a); link(f, g); // d and e have several; f ⇄ g is a cycle
      db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(a);
      db.prepare('UPDATE tasks SET position=NULL WHERE id=?').run(e);
      db.prepare('UPDATE tasks SET position=99 WHERE id=?').run(b); // queue order isn't id order
      const pick = (t) => ({ id: t.id, deps: t.deps, prereqs: t.prereqs, dependents: t.dependents });
      return { snap: o.convoSnapshot({ cwd: path.join(root, 'p1') }).tasks.map(pick).sort((x, y) => x.id - y.id),
        one: [a, b, c, d, e, f, g].map((id) => pick(o.taskDetail(id).task)), a, b, c, d, e };`);
    assert.deepEqual(r.snap, r.one);
    const at = (id) => r.one.find((t) => t.id === id);
    assert.deepEqual(at(r.d).deps, [r.c, r.a, r.b], 'the legacy depends_on first, then by id');
    assert.deepEqual(at(r.e).prereqs, [r.d, r.c, r.b], 'unfinished only, up the graph');
    assert.deepEqual(at(r.a).dependents, [r.d, r.b, r.e], 'queued ones in queue order, an unplaced one last');
  });
});
