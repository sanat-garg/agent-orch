// Task #112: saved chat messages can be edited or retracted until a plan task reads them (then 409).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// createOrchestrator starts timers, so drive it in a child process with a fake SDK query() that exits.
test('saved messages: edit/undo while pending, 409 once a plan task consumed them, undo-all cancels the plan task', { timeout: 60000 }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pend-')), proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pend-p-'));
  try {
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import path from 'node:path';
      const [dataDir, proj] = process.argv.slice(1);
      const prompts = [], events = [];
      let release, active = 0;
      const query = ({ prompt, options }) => (async function* () {
        prompts.push(prompt); active++;
        try {
          if (/EDITED/.test(prompt)) await new Promise((r) => { release = r; options.abortController.signal.addEventListener('abort', r); });
          yield { type: 'result', subtype: 'success', result: 'Noted.', session_id: 'sess-1', num_turns: 1 };
        } finally { active--; }
      })();
      const o = createOrchestrator({ query, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat: (id, m) => events.push(m), convoExists: () => true });
      const convo = { id: 'c1', cwd: proj };
      const until = async (f) => { for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); };
      o.drain(); // draining: chat messages are saved, and the scheduler starts nothing
      await o.planTurn(convo, 'ONE');
      await o.planTurn(convo, 'TWO');
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const plans = () => db.prepare("SELECT id, status FROM tasks WHERE kind='plan'").all().map((r) => r.status);
      const ids = events.filter((e) => e.msgId).map((e) => e.msgId);
      const r = {};
      r.edit = o.changeMessage(ids[0], 'ONE EDITED');
      r.undo = o.changeMessage(ids[1], null);
      r.plansAfterUndo = plans();
      r.retracted = events.find((e) => e.t === 'msg_retract')?.msgId === ids[1];
      o.undrain();
      const tid = db.prepare("SELECT id FROM tasks WHERE kind='plan'").get().id;
      o.taskAction(tid, 'next');
      await until(() => active > 0);
      r.readEvent = events.find((e) => e.t === 'msg_state')?.state;
      r.editRunning = o.changeMessage(ids[0], 'late');
      r.undoRunning = o.changeMessage(ids[0], null);
      release();
      await until(() => db.prepare("SELECT status FROM messages WHERE id=?").get(ids[0]).status === 'done' && active === 0);
      r.editDone = o.changeMessage(ids[0], 'late');
      r.missing = o.changeMessage(999999, 'x');
      // Retracting every pending message cancels the waiting plan task.
      o.drain();
      await o.planTurn(convo, 'THREE');
      const id3 = events.filter((e) => e.msgId).pop().msgId;
      r.plansBefore = plans();
      r.undo3 = o.changeMessage(id3, null);
      r.plansAfter = plans();
      r.prompts = prompts;
      console.log(JSON.stringify(r));
      process.exit(0);`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script, dataDir, proj], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.deepEqual(r.edit, { ok: true });
    assert.deepEqual(r.undo, { ok: true });
    assert.ok(r.retracted);
    assert.deepEqual(r.plansAfterUndo, ['queued']); // ONE is still pending
    assert.equal(r.readEvent, 'read');
    assert.equal(r.editRunning.status, 409);
    assert.equal(r.undoRunning.status, 409);
    assert.equal(r.editDone.status, 409);
    assert.equal(r.missing.status, 404);
    assert.equal(r.prompts.length, 1);
    assert.match(r.prompts[0], /ONE EDITED/);
    assert.doesNotMatch(r.prompts[0], /TWO/);
    assert.deepEqual(r.undo3, { ok: true });
    assert.deepEqual(r.plansBefore, ['done', 'queued']);
    assert.deepEqual(r.plansAfter, ['done', 'cancelled']);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
