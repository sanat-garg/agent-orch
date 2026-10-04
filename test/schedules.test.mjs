// Schedules (orchestrator `schedules` + cron.mjs): a due schedule queues a task, a run whose last task hasn't finished
// is skipped (never piled up), Run now, edits/validation, and the planner's `schedules` in its tasks block.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractTasks } from '../orchestrator.mjs';

const ORCH = JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href);

// createOrchestrator starts timers, so the scenario runs in a child process with a fake SDK query(). Prints a JSON line.
async function scenario(body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-schedules-')), root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-schedules-p-'));
  try {
    const script = `import { createOrchestrator } from ${ORCH};
      import { waitFor as until } from ${JSON.stringify(new URL('./helpers/wait.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      const prompts = [];
      const query = ({ prompt }) => (async function* () {
        prompts.push(prompt);
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 };
      })();
      const o = createOrchestrator({ config: { pollMs: 100, parallelTasks: 2, agentSlots: 2, worktrees: false, autoCommit: false,
        meminfo: ${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)} }, query, dataDir, claudeEnv: {}, getLimits: () => [],
        onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      let n = 0;
      const project = (status = 'active') => {
        const p = path.join(root, 'p' + ++n); fs.mkdirSync(p);
        return Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,created_at) VALUES(?,?,?,0,0)").run(p, 'p' + n, status).lastInsertRowid);
      };
      const sched = (id) => db.prepare('SELECT * FROM schedules WHERE id=?').get(id);
      const due = (id) => db.prepare('UPDATE schedules SET next_run_at=? WHERE id=?').run(Date.now() / 1000 - 5, id);
      const tasks = (pid) => db.prepare("SELECT * FROM tasks WHERE project_id=? AND source='schedule' ORDER BY id").all(pid);
      const out = await (async () => { ${body} })();
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root], { encoding: 'utf8', timeout: 60000 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('schedules', { concurrency: true, timeout: 90000 }, () => {
  test('validation, next run in the zone, edit and delete', async () => {
    const r = await scenario(`
      const pid = project();
      const bad = [o.saveSchedule(pid, { title: 'x', prompt: 'y', cron: '61 * * * *' }), o.saveSchedule(pid, { title: '', prompt: 'y', cron: '* * * * *' }),
        o.saveSchedule(pid, { title: 'x', prompt: 'y', cron: '0 9 31 2 *' }), o.saveSchedule(pid, { title: 'x', prompt: 'y', cron: '0 9 * * *', tz: 'Mars/Base' }),
        o.saveSchedule(999, { title: 'x', prompt: 'y', cron: '* * * * *' })].map((x) => [x.status, x.error]);
      const s = o.saveSchedule(pid, { title: 'Inbox', prompt: 'Triage email', cron: '0 9 * * *', tz: 'Asia/Kolkata' }).schedule;
      const off = o.editSchedule(s.id, { enabled: false }).schedule;
      const on = o.editSchedule(s.id, { enabled: true, cron: '30 18 * * 1-5' }).schedule;
      const del = o.deleteSchedule(s.id);
      return { bad, s, off, on, del, left: o.listSchedules(pid).length, gone: o.editSchedule(s.id, {}).status };`);
    assert.deepEqual(r.bad.map((b) => b[0]), [400, 400, 400, 400, 404]);
    assert.match(r.bad[0][1], /minute: 61/);
    assert.match(r.bad[2][1], /never comes round/);
    assert.equal(r.s.when, 'Every day at 09:00');
    assert.equal(r.s.tz, 'Asia/Kolkata');
    assert.equal(new Date(r.s.next_run_at * 1000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' }), '09:00:00');
    assert.equal(r.off.enabled, false);
    assert.equal(r.off.next_run_at, null);
    assert.equal(r.on.when, 'Weekdays at 18:30');
    assert.equal(r.on.title, 'Inbox'); // an edit keeps what it doesn't change
    assert.ok(r.on.next_run_at > Date.now() / 1000);
    assert.deepEqual([r.del.ok, r.left, r.gone], [true, 0, 404]);
  });

  test('a due schedule queues a task; the next run is skipped while that task is unfinished', async () => {
    const r = await scenario(`
      const pid = project('paused'); // its tasks stay queued
      const s = o.saveSchedule(pid, { title: 'Nightly backup', prompt: 'Back up the DB', cron: '0 3 * * *', done_when: 'test -f backup.sql' }).schedule;
      const notDue = o.fireSchedules();
      due(s.id);
      o.fireSchedules();
      const first = tasks(pid);
      const after1 = sched(s.id);
      due(s.id);
      o.fireSchedules();
      const runNow = o.runScheduleNow(s.id);
      return { notDue, first, after1, after2: sched(s.id), count: tasks(pid).length, runNow, view: o.listSchedules(pid)[0] };`);
    assert.equal(r.notDue, 0);
    assert.equal(r.first.length, 1);
    const t = r.first[0];
    assert.equal(t.title, 'Nightly backup');
    assert.equal(t.kind, 'work');
    assert.equal(t.status, 'queued');
    assert.equal(t.done_when, 'test -f backup.sql');
    assert.match(t.prompt, /^Back up the DB\n\n\(This is a recurring task from a schedule: Every day at 03:00/);
    assert.equal(r.after1.runs, 1);
    assert.equal(r.after1.last_task_id, t.id);
    assert.ok(r.after1.next_run_at > Date.now() / 1000, 'the next run moves forward');
    assert.equal(r.after2.skipped, 1);
    assert.equal(r.count, 1, 'no pile-up');
    assert.equal(r.runNow.status, 409);
    assert.deepEqual(r.view.last_task, { id: t.id, status: 'queued' });
  });

  test('scheduled tasks run, and the next run queues once the last one finished', async () => {
    const r = await scenario(`
      const pid = project();
      const s = o.saveSchedule(pid, { title: 'Ping', prompt: 'Say hi', cron: '*/5 * * * *' }).schedule;
      due(s.id);
      await until(() => tasks(pid)[0]?.status === 'done', 20000);
      const now = o.runScheduleNow(s.id);
      await until(() => tasks(pid)[1]?.status === 'done', 20000);
      return { statuses: tasks(pid).map((t) => t.status), now, runs: sched(s.id).runs, label: tasks(pid)[1].prompt };`);
    assert.deepEqual(r.statuses, ['done', 'done']);
    assert.equal(r.now.ok, true);
    assert.equal(r.runs, 2);
    assert.match(r.label, /The last run was task #\d+ \(done\)/);
  });
});

test('extractTasks reads schedules from a planner block', () => {
  const [, p] = extractTasks('ok\n```agent-orch-tasks\n' + JSON.stringify({ tasks: [], schedules: [
    { title: 'Weekly deps', prompt: 'Check deps', cron: '0 8 * * 1', agent: 'openai', model: 'gpt-5' },
    { title: 'no cron', prompt: 'x' }, { remove: '#4' }, 'junk'] }) + '\n```');
  assert.deepEqual(p.schedules, [
    { title: 'Weekly deps', prompt: 'Check deps', cron: '0 8 * * 1', done_when: null, agent: 'codex', model: 'gpt-5' },
    { remove: 4 }]);
});
