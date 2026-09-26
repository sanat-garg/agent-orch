// Task scheduling: claim order (eff), depends_on, one running task per project, cascade/revive, blocked_until.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ORCH = JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href);

// createOrchestrator starts timers, so each scenario runs in a child process with a fake SDK query() and
// rows inserted synchronously before the first test-configured tick. The body prints a JSON line.
// `fiveHour` set: a 5h reading above 90% makes pacing drop to one slot, so claims happen strictly in order.
async function scenario(body, { fiveHour = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sched-')), root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sched-p-'));
  try {
    const script = `import { createOrchestrator } from ${ORCH};
      import { waitFor as until } from ${JSON.stringify(new URL('./helpers/wait.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      const now = () => Date.now() / 1000;
      globalThis.HOLD = 300; globalThis.FAIL = true;
      const query = ({ prompt, options }) => (async function* () {
        await new Promise((r) => { const t = setTimeout(r, HOLD); options.abortController.signal.addEventListener('abort', () => { clearTimeout(t); r(); }); });
        if (FAIL && /FAILME/.test(prompt)) yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: 's', num_turns: 1 };
        else yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 };
      })();
      const getLimits = () => ${fiveHour} ? [{ limit_type: 'five_hour', status: 'allowed', utilization: 0.95, resets_at: now() + 3600, observed_at: now() }] : [];
      let subscriptionChecks = 0;
      const o = createOrchestrator({ config: { pollMs: 100 }, query, dataDir, claudeEnv: {}, getLimits, onSubscription: () => { subscriptionChecks++; return true; },
        broadcast() {}, emitChat() {}, convoExists: () => false });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      let n = 0;
      const project = (priority = 50, status = 'active') => {
        const p = path.join(root, 'p' + ++n); fs.mkdirSync(p);
        return Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,?,?,?,0,0)").run(p, 'p' + n, priority, status).lastInsertRowid);
      };
      let created = 0;
      const task = (pid, title, { urgency = 'normal', priority = { urgent: 85, normal: 50, background: 20 }[urgency], dependsOn = null, attempts = 0 } = {}) =>
        Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,priority,urgency,depends_on,attempts,created_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(pid, title, title, priority, urgency, dependsOn, attempts, ++created).lastInsertRowid);
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      const nextPoll = async () => { const checks = subscriptionChecks; await until(() => subscriptionChecks > checks); };
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

describe('scheduling', { concurrency: true, timeout: 120000 }, () => {
  test('urgent beats normal beats background; project priority breaks ties at equal urgency', async () => {
    // eff = t.priority + (p.priority - 50) / 2 (+ deadline boost): 85, 50+20=70, 50, 20.
    const r = await scenario(`
      const low = project(50), high = project(90);
      const bg = task(low, 'bg', { urgency: 'background' }), normal = task(low, 'normal'), highNormal = task(high, 'high normal'), urgent = task(low, 'urgent', { urgency: 'urgent' });
      await until(settled);
      const ids = { bg, normal, highNormal, urgent };
      return { statuses: Object.values(ids).map((id) => get(id).status),
        order: Object.keys(ids).sort((a, b) => get(ids[a]).started_at - get(ids[b]).started_at) };`, { fiveHour: true });
    assert.deepEqual(r.statuses, ['done', 'done', 'done', 'done']);
    assert.deepEqual(r.order, ['urgent', 'highNormal', 'normal', 'bg']);
  });

  test('a task waits for an unfinished depends_on task', async () => {
    const r = await scenario(`
      const paused = project(50, 'paused'), active = project(50);
      const dep = task(paused, 'dep'), child = task(active, 'child', { urgency: 'urgent', dependsOn: dep }), other = task(active, 'other');
      await until(() => get(other).status === 'done');
      await until(() => o.stateView().running === 0);
      await nextPoll(); // Another scheduler check after the project went idle.
      const before = { dep: get(dep).status, child: get(child).status, childStarted: get(child).started_at };
      o.projectAction(paused, { status: 'active' });
      await until(settled);
      return { before, dep: get(dep), child: get(child) };`);
    assert.deepEqual(r.before, { dep: 'queued', child: 'queued', childStarted: null });
    assert.equal(r.dep.status, 'done');
    assert.equal(r.child.status, 'done');
    assert.ok(r.child.started_at >= r.dep.finished_at);
  });

  test('two tasks in one project never run at once', async () => {
    const r = await scenario(`
      HOLD = 1500;
      const a = project(50), b = project(50);
      const x = task(a, 'x'), y = task(a, 'y'), z = task(b, 'z');
      await until(settled);
      return [x, y, z].map(get).map(({ status, started_at, finished_at }) => ({ status, started_at, finished_at }));`);
    const [x, y, z] = r;
    assert.deepEqual(r.map((t) => t.status), ['done', 'done', 'done']);
    assert.ok(x.finished_at <= y.started_at || y.finished_at <= x.started_at, 'x and y overlapped');
    const overlaps = (s, t) => s.started_at < t.finished_at && t.started_at < s.finished_at;
    assert.ok(overlaps(z, x) || overlaps(z, y), 'the other project had a free slot and ran alongside');
  });

  test('a failed parent blocks its queued children; retrying it revives them', async () => {
    const r = await scenario(`
      const p = project(50);
      const parent = task(p, 'parent FAILME', { attempts: 2 }), child = task(p, 'child', { dependsOn: parent }), grandchild = task(p, 'grandchild', { dependsOn: child });
      await until(() => get(grandchild).status !== 'queued');
      const failed = [parent, child, grandchild].map(get).map(({ status, result }) => ({ status, result }));
      FAIL = false;
      const retry = o.taskAction(parent, 'retry');
      const revived = [parent, child, grandchild].map((id) => get(id).status);
      await until(settled);
      return { parent, failed, retry, revived, final: [parent, child, grandchild].map((id) => get(id).status) };`);
    assert.equal(r.failed[0].status, 'failed');
    for (const t of r.failed.slice(1)) {
      assert.equal(t.status, 'failed');
      assert.ok(t.result.startsWith(`blocked: #${r.parent} `), t.result);
    }
    assert.deepEqual(r.retry, { ok: true });
    assert.deepEqual(r.revived, ['queued', 'queued', 'queued']);
    assert.deepEqual(r.final, ['done', 'done', 'done']);
  });

  test('nothing is claimed while blocked_until is in the future', async () => {
    const r = await scenario(`
      db.prepare("INSERT INTO kv(key,value) VALUES('blocked_until', ?)").run(String(now() + 3600));
      const t = task(project(50), 't');
      await nextPoll(); await nextPoll(); // First scheduler check and another poll, while blocked.
      const blocked = { status: get(t).status, started_at: get(t).started_at };
      db.prepare("UPDATE kv SET value='0' WHERE key='blocked_until'").run();
      await until(settled);
      return { blocked, after: get(t).status };`);
    assert.deepEqual(r.blocked, { status: 'queued', started_at: null });
    assert.equal(r.after, 'done');
  });
});
