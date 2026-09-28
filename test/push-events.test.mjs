// Web Push events (orchestrator.mjs notifyOwner): a failed run, a review checkpoint that starts waiting, and a gate
// approval request each call the `notify` hook once, with the badge = pending approvals + checkpoints awaiting review.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);

// Same harness as checkpoint.test.mjs: a child process with a fake query() (`behave` runs inside it) and a recording notify.
async function scenario(behave, body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-push-')), root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-push-p-'));
  try {
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { ask } from ${url('gate.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const query = ({ prompt, options }) => (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's' };
        ${behave}
      })();
      const notes = [];
      const o = createOrchestrator({ query, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
        config: { pollMs: 100, worktrees: false, maxAttempts: 1 }, notify: (n) => { notes.push(n); },
        broadcast() {}, emitChat() {}, convoExists: () => true });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      let n = 0, pos = 0;
      const project = (status = 'active') => {
        const p = path.join(root, 'p' + ++n); fs.mkdirSync(p);
        return Number(db.prepare("INSERT INTO projects(path,name,convo_id,priority,status,perpetual,created_at) VALUES(?,?,'c1',50,?,0,0)").run(p, 'p' + n, status).lastInsertRowid);
      };
      const task = (pid, title, { dependsOn = null } = {}) =>
        Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,priority,urgency,depends_on,source,position,created_at) VALUES(?,?,?,50,'normal',?,'planner',?,?)")
          .run(pid, title, title, dependsOn, ++pos, pos).lastInsertRowid);
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
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

const DONE = "await sleep(100); yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 };";

describe('push events', { concurrency: true, timeout: 120000 }, () => {
  test('a run that fails notifies once, tagged with its task', async () => {
    const r = await scenario("throw new Error('boom');", `
      const id = task(project(), 'Break things');
      await until(() => get(id).status === 'failed');
      await sleep(300);
      return { id, status: get(id).status, notes };`);
    assert.equal(r.status, 'failed');
    const mine = r.notes.filter((x) => x.tag === `task-${r.id}`);
    assert.equal(mine.length, 1, JSON.stringify(r.notes));
    assert.equal(mine[0].title, 'Task failed');
    assert.equal(mine[0].url, `/#task-${r.id}`);
    assert.match(mine[0].body, new RegExp(`^#${r.id} Break things`));
    assert.equal(mine[0].badge, 0);
  });

  test('a checkpoint whose prerequisite finishes notifies "Review needed"', async () => {
    const r = await scenario(DONE, `
      const p = project('paused');
      const a = task(p, 'a'), b = task(p, 'b', { dependsOn: a });
      const cp = o.insertCheckpoint(a).task.id;
      o.projectAction(p, { status: 'active' });
      await until(() => get(cp).status === 'awaiting_review');
      await sleep(300);
      return { a, cp, notes };`);
    const review = r.notes.filter((x) => x.title === 'Review needed');
    assert.equal(review.length, 1, JSON.stringify(r.notes));
    assert.equal(review[0].tag, `task-${r.cp}`);
    assert.equal(review[0].url, `/#task-${r.cp}`);
    assert.match(review[0].body, new RegExp(`^#${r.a} a is done`));
    assert.equal(review[0].badge, 1, 'the checkpoint itself counts');
  });

  test('a gate approval request notifies "Approval needed" with a badge of 1', async () => {
    const r = await scenario(`
      const gd = path.join(dataDir, 'gate');
      await (async () => { for (let i = 0; i < 200 && !(fs.existsSync(gd) && fs.readdirSync(gd).length); i++) await sleep(50); })();
      const dir = path.join(gd, fs.readdirSync(gd)[0]);
      await ask(dir, 'approvals', { server: 'mail', tool: 'send_email', action: 'mail: send_email (to: bob@example.com)', key: 'k1', reason: 'outbound' },
        { signal: options.abortController.signal });
      ${DONE}`, `
      const id = task(project(), 'Send the invoice');
      await until(() => o.pendingApprovals().length === 1);
      await sleep(200);
      const seen = notes.slice();
      o.decideApproval(o.pendingApprovals()[0].id, { decision: 'approve' });
      await until(() => get(id).status === 'done');
      return { id, seen, status: get(id).status };`);
    const ap = r.seen.filter((x) => x.title === 'Approval needed');
    assert.equal(ap.length, 1, JSON.stringify(r.seen));
    assert.deepEqual(ap[0], { title: 'Approval needed', body: `#${r.id} Send the invoice: mail: send_email (to: bob@example.com)`,
      tag: `approval-${r.id}`, url: `/#task-${r.id}`, badge: 1 });
    assert.equal(r.status, 'done');
  });
});
