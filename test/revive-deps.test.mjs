// AUDIT #30: C depends on A and B, both fail. Retrying them in either order revives C (and C's dependent D)
// once the last failed prerequisite is retried, even though C's result names only the one that failed first.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);

// Prompts containing FAILME fail while globalThis.FAIL is set; `attempts: 2` makes the first failure final.
async function scenario(body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-revive-')), root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-revive-p-'));
  try {
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { waitFor as until } from ${url('test/helpers/wait.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      globalThis.FAIL = true;
      const query = ({ prompt }) => (async function* () {
        if (FAIL && /FAILME/.test(prompt)) yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: 's', num_turns: 1 };
        else yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 };
      })();
      const o = createOrchestrator({ config: { pollMs: 100 }, query, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => false });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      let n = 0;
      const project = () => {
        const p = path.join(root, 'p' + ++n); fs.mkdirSync(p);
        return Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,?,50,'active',0,0)").run(p, 'p' + n).lastInsertRowid);
      };
      const task = (pid, title, deps = [], attempts = 0) => {
        const id = Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,priority,urgency,depends_on,attempts,created_at) VALUES(?,?,?,50,?,?,?,?)')
          .run(pid, title, title, 'normal', deps[0] ?? null, attempts, ++n).lastInsertRowid);
        for (const d of deps) db.prepare('INSERT INTO task_deps(task_id, depends_on) VALUES(?,?)').run(id, d);
        return id;
      };
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
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

// order 'blocker-first' retries the prerequisite named in C's result first; 'other-first' retries the other one first.
const run = (order) => scenario(`
  const a = task(project(), 'A FAILME', [], 2), b = task(project(), 'B FAILME', [], 2);
  const pc = project(), c = task(pc, 'C', [a, b]), d = task(pc, 'D', [c]);
  await until(() => settled());
  const failed = [a, b, c, d].map(get).map(({ status, result }) => ({ status, result }));
  const blocker = Number(/^blocked: #(\\d+) /.exec(get(c).result)[1]);
  const other = blocker === a ? b : a;
  const [first, second] = ${JSON.stringify(order)} === 'blocker-first' ? [blocker, other] : [other, blocker];
  FAIL = false;
  const retry1 = o.taskAction(first, 'retry');
  const afterFirst = [c, d].map((id) => get(id).status);
  const retry2 = o.taskAction(second, 'retry');
  const afterSecond = [c, d].map((id) => get(id).status);
  await until(settled);
  return { a, b, failed, retry1, retry2, afterFirst, afterSecond, final: [a, b, c, d].map((id) => get(id).status) };`);

describe('reviving a task with several failed prerequisites', { concurrency: true, timeout: 120000 }, () => {
  for (const order of ['blocker-first', 'other-first']) {
    test(`retrying both prerequisites (${order}) revives the dependent and its dependents`, async () => {
      const r = await run(order);
      assert.deepEqual(r.failed.slice(0, 2).map((t) => t.status), ['failed', 'failed']);
      for (const t of r.failed.slice(2)) {
        assert.equal(t.status, 'failed');
        assert.match(t.result, new RegExp(`^blocked: #(${r.a}|${r.b}) `));
      }
      assert.deepEqual([r.retry1, r.retry2], [{ ok: true }, { ok: true }]);
      assert.deepEqual(r.afterFirst, ['failed', 'failed'], 'still blocked while the other prerequisite is failed');
      assert.deepEqual(r.afterSecond, ['queued', 'queued']);
      assert.deepEqual(r.final, ['done', 'done', 'done', 'done']);
    });
  }

  test('a dependent that failed for its own reasons is not revived', async () => {
    const r = await scenario(`
      const a = task(project(), 'A', []), c = task(project(), 'C FAILME', [a], 2);
      await until(() => get(c).status === 'failed');
      db.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(a);
      FAIL = false;
      o.taskAction(a, 'retry');
      const after = get(c).status;
      await until(() => get(a).status === 'done');
      return { after, final: get(c).status };`);
    assert.equal(r.after, 'failed');
    assert.equal(r.final, 'failed');
  });
});
