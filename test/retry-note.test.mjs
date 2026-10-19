// Retry with an owner note: the note is appended to the task's prompt so the next run sees it; long notes are refused.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ORCH = JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href);

// Same setup as scheduling.test.mjs: a child process with a fake query() that records every prompt it gets.
async function scenario(body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-retry-')), root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-retry-p-'));
  try {
    const script = `import { createOrchestrator } from ${ORCH};
      import { waitFor as until } from ${JSON.stringify(new URL('./helpers/wait.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      globalThis.FAIL = true;
      const prompts = [];
      const query = ({ prompt }) => (async function* () {
        prompts.push(prompt);
        await new Promise((r) => setTimeout(r, 50));
        if (FAIL) yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: 's', num_turns: 1 };
        else yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 };
      })();
      const o = createOrchestrator({ config: { pollMs: 100, parallelTasks: 2, agentSlots: 2, meminfo: ${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)} }, query, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => false });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const p = path.join(root, 'p'); fs.mkdirSync(p);
      const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,'p',50,'active',0,0)").run(p).lastInsertRowid);
      const task = (title) => Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,attempts,created_at) VALUES(?,?,?,2,1)').run(pid, title, title + ' prompt').lastInsertRowid);
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      const events = (id) => db.prepare('SELECT message FROM events WHERE task_id=? ORDER BY id').all(id).map((e) => e.message);
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

describe('retry with a note', { concurrency: true, timeout: 120000 }, () => {
  test('a failed task retried with a note runs with the note in its prompt', async () => {
    const r = await scenario(`
      const t = task('fix it');
      await until(() => get(t).status === 'failed');
      const ran = prompts.length;
      FAIL = false;
      const retry = o.taskAction(t, 'retry', '  Use the helper in lib.mjs instead.  ');
      await until(() => get(t).status === 'done');
      return { retry, ran, prompt: get(t).prompt, next: prompts.slice(ran), events: events(t) };`);
    assert.deepEqual(r.retry, { ok: true });
    assert.ok(r.ran >= 1);
    assert.equal(r.prompt, "fix it prompt\n\nOwner's note for this retry: Use the helper in lib.mjs instead.");
    assert.ok(r.next.length >= 1);
    assert.ok(r.next[0].includes("Owner's note for this retry: Use the helper in lib.mjs instead."), r.next[0]);
    assert.ok(r.events.some((m) => m.includes('retried with a note: Use the helper in lib.mjs instead.')), r.events.join('\n'));
  });

  test('a 2001-character note is refused and the task stays failed', async () => {
    const r = await scenario(`
      const t = task('too long');
      await until(() => get(t).status === 'failed');
      const retry = o.taskAction(t, 'retry', 'x'.repeat(2001));
      await new Promise((res) => setTimeout(res, 300));
      return { retry, status: get(t).status, prompt: get(t).prompt };`);
    assert.deepEqual(r.retry, { error: 'Keep the note under 2000 characters' });
    assert.equal(r.status, 'failed');
    assert.equal(r.prompt, 'too long prompt');
  });

  test('an empty note retries unchanged', async () => {
    const r = await scenario(`
      const t = task('plain');
      await until(() => get(t).status === 'failed');
      FAIL = false;
      const retry = o.taskAction(t, 'retry', '   ');
      await until(() => get(t).status === 'done');
      return { retry, prompt: get(t).prompt, events: events(t) };`);
    assert.deepEqual(r.retry, { ok: true });
    assert.equal(r.prompt, 'plain prompt');
    assert.ok(r.events.some((m) => /retried$/.test(m)), r.events.join('\n'));
  });
});
