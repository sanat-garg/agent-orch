// A chat's persona (extensions.mjs, via the server's convoPersona) joins the system text of its project's planner and
// task runs, read at each session start; no persona leaves them as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// createOrchestrator starts timers, so drive it in a child process with a fake SDK query() that records each run's options.
test("the planner and the project's tasks run with the chat's persona", { timeout: 60000 }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-persona-')), proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-persona-p-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-persona-q-'));
  try {
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      import { waitFor as until } from ${JSON.stringify(new URL('./helpers/wait.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import path from 'node:path';
      const [dataDir, proj, other] = process.argv.slice(1);
      const runs = [];
      const persona = '## Persona: Tester\\nBe brief.';
      const query = ({ prompt, options }) => (async function* () {
        runs.push({ prompt: String(prompt).slice(0, 40), append: options.systemPrompt?.append || '' });
        yield { type: 'result', subtype: 'success', result: 'Done.', session_id: 'sess-' + runs.length, num_turns: 1 };
      })();
      const o = createOrchestrator({ config: { pollMs: 100 }, query, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => true, convoPersona: (cid) => (cid === 'c1' ? persona : null) });
      // Every run is a fresh session (a resumed one gets no system text at all): a chat without a persona, then one with.
      await o.planTurn({ id: 'c2', cwd: other }, 'PLAIN');
      await o.planTurn({ id: 'c1', cwd: proj }, 'PLAN');
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const pid = db.prepare('SELECT id FROM projects WHERE path=?').get(proj).id;
      db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,created_at) VALUES(?, 'work', 'Work', 'WORK', 0)").run(pid);
      await until(() => runs.length >= 3 && !db.prepare("SELECT 1 FROM tasks WHERE status IN ('queued','running')").get());
      console.log(JSON.stringify(runs));
      process.exit(0);`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script, dataDir, proj, other], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const runs = JSON.parse(out.trim().split('\n').pop());
    // In order: the two planner turns (awaited), then the work task; a reflection may follow once the queue empties.
    assert.ok(runs.length >= 3, `${runs.length} runs`);
    const [plain, plan, work] = runs;
    assert.match(plan.append, /\n\n## Persona: Tester\nBe brief\.$/, 'planner');
    assert.match(work.append, /\n\n## Persona: Tester\nBe brief\.$/, 'work task');
    assert.ok(work.append.indexOf('## Persona') > 0 && work.append !== plan.append, "after the worker's own system text");
    assert.ok(plain.append.length > 0);
    assert.doesNotMatch(plain.append, /Persona/, "a chat without a persona: the planner's own text only");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});
