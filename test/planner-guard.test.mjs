// AUDIT #5: a plan task and a chat planner turn never resume the same planner session at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// createOrchestrator starts timers, so drive it in a child process with a fake SDK query() that exits.
test('a chat message during a plan task is saved and answered by the next plan task', { timeout: 60000 }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-guard-')), proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-guard-p-'));
  try {
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import path from 'node:path';
      const [dataDir, proj] = process.argv.slice(1);
      const prompts = [], notices = [];
      let active = 0, maxActive = 0;
      const query = ({ prompt, options }) => (async function* () {
        prompts.push(prompt); maxActive = Math.max(maxActive, ++active);
        try {
          await new Promise((r) => { const t = setTimeout(r, 1500); options.abortController.signal.addEventListener('abort', () => { clearTimeout(t); r(); }); });
          yield { type: 'result', subtype: 'success', result: 'Noted.', session_id: 'sess-1', num_turns: 1 };
        } finally { active--; }
      })();
      const o = createOrchestrator({ query, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat: (id, m) => { if (m.t === 'notice') notices.push(m.text); }, convoExists: () => true });
      const convo = { id: 'c1', cwd: proj };
      await o.planTurn(convo, 'FIRST');
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const pid = db.prepare('SELECT id FROM projects').get().id;
      db.prepare("INSERT INTO messages(project_id,content,created_at) VALUES(?, 'SAVED', 0)").run(pid);
      db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,created_at) VALUES(?, 'plan', 'Answer', 'x', 0)").run(pid);
      const tid = db.prepare("SELECT id FROM tasks WHERE kind='plan'").get().id;
      o.taskAction(tid, 'next');
      const until = async (f) => { for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 100)); };
      await until(() => active > 0);
      await o.planTurn(convo, 'SECOND'); // the plan task holds the session: saved, not run
      const plansDuring = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind='plan' AND status IN ('queued','running')").get().n;
      await until(() => db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status='pending'").get().n === 0
        && !db.prepare("SELECT 1 FROM tasks WHERE status IN ('queued','running')").get() && active === 0);
      const plans = db.prepare("SELECT status FROM tasks WHERE kind='plan'").all().map((r) => r.status);
      console.log(JSON.stringify({ prompts, notices, maxActive, plansDuring, plans }));
      process.exit(0);`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script, dataDir, proj], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.equal(r.maxActive, 1);
    assert.equal(r.prompts.length, 3);
    assert.match(r.prompts[0], /FIRST/);
    assert.match(r.prompts[1], /SAVED/);
    assert.doesNotMatch(r.prompts[1], /SECOND/);
    assert.match(r.prompts[2], /SECOND/);
    assert.ok(r.notices.some((n) => /busy/.test(n)));
    assert.equal(r.plansDuring, 1); // no duplicate; the running task queues a follow-up when it ends
    assert.deepEqual(r.plans, ['done', 'done']);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
