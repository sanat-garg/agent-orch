// Each agent's usage limit is independent: one agent's block never defers, stops or mislabels another's work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));

// createOrchestrator starts timers, so each scenario runs in a child process with a fake SDK query() (it counts
// Claude runs) and HOME/PATH pointing at the codex stub. `block` rows go into kv before anything runs.
async function scenario(body, block) {
  const dirs = ['cw-ind-', 'cw-ind-p-', 'cw-ind-home-'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const [dataDir, root, home] = dirs;
  try {
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    fs.symlinkSync(fixture('codex-stub.mjs'), path.join(home, '.local/bin/codex'));
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      import { waitFor as until } from ${JSON.stringify(new URL('./helpers/wait.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      const now = () => Date.now() / 1000;
      const claudePrompts = [], chat = [];
      const query = ({ prompt }) => (async function* () {
        claudePrompts.push(prompt);
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 };
      })();
      let subscriptionChecks = 0;
      const o = createOrchestrator({ config: { pollMs: 100 }, query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => { subscriptionChecks++; return true; },
        broadcast() {}, emitChat: (id, m) => chat.push({ id, ...m }), convoExists: () => true });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      for (const [k, v] of Object.entries(${JSON.stringify(block)})) db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run(k, String(now() + v));
      let n = 0;
      const dir = () => { const p = path.join(root, 'p' + ++n); fs.mkdirSync(p); return p; };
      const project = () => { const p = dir(); return Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,?,50,'active',0,0)").run(p, 'p' + n).lastInsertRowid); };
      const task = (pid, title, agent = null, model = null) => Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,agent,model,created_at) VALUES(?,?,?,?,?,0)').run(pid, title, title, agent, model).lastInsertRowid);
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      const pending = () => db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status='pending'").get().n;
      const out = await (async () => { ${body} })();
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const env = { ...process.env, HOME: home, PATH: `${path.join(home, '.local/bin')}:${process.env.PATH}` };
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root], { encoding: 'utf8', timeout: 90000, env });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

test('a Claude block does not defer a codex chat turn; a Claude chat is deferred with a notice naming Claude', { timeout: 60000 }, async () => {
  const r = await scenario(`
    await o.planTurn({ id: 'cx', cwd: dir(), agent: 'codex' }, 'hello codex');
    const cxChat = chat.filter((m) => m.id === 'cx'), pendingAfterCx = pending();
    await o.planTurn({ id: 'cl', cwd: dir() }, 'hello claude');
    return { cxChat, pendingAfterCx, claudeChat: chat.filter((m) => m.id === 'cl'), pending: pending(), claudePrompts: claudePrompts.length,
      plans: db.prepare("SELECT agent FROM tasks WHERE kind='plan'").all(), blocks: o.stateView().blocks };`, { blocked_until: 3600 });
  assert.equal(r.pendingAfterCx, 0);
  assert.ok(!r.cxChat.some((m) => /usage limit/.test(m.text || '')), JSON.stringify(r.cxChat));
  assert.ok(r.cxChat.some((m) => m.t === 'text' && /Done/.test(m.text)), JSON.stringify(r.cxChat));
  // The Claude chat's own agent is blocked: saved, and the notice names Claude.
  assert.equal(r.claudePrompts, 0);
  assert.equal(r.pending, 1);
  assert.ok(r.claudeChat.some((m) => m.t === 'notice' && /^Saved\. Claude is at its usage limit/.test(m.text)), JSON.stringify(r.claudeChat));
  assert.deepEqual(r.plans, [{ agent: null }]);
  assert.deepEqual(Object.keys(r.blocks), ['claude']);
});

test('a Claude block does not stop claiming a codex-routed task; Claude tasks wait', { timeout: 60000 }, async () => {
  const r = await scenario(`
    const pid = project(), pid2 = project();
    const codex = task(pid, 'Add tests', 'codex'), plain = task(pid2, 'Plain');
    await until(() => get(codex).status === 'done');
    await until(() => o.stateView().running === 0);
    const checks = subscriptionChecks;
    await until(() => subscriptionChecks > checks); // Another scheduler check: Claude still waits.
    const view = o.taskDetail(plain).task;
    return { codex: get(codex), plain: get(plain), plainRunsOn: view.runs_on, claudePrompts: claudePrompts.length };`, { blocked_until: 3600 });
  assert.equal(r.codex.status, 'done');
  assert.equal(r.codex.ran_agent, 'codex');
  assert.equal(r.plain.status, 'queued');
  assert.equal(r.plain.started_at, null);
  assert.equal(r.plainRunsOn, 'claude');
  assert.equal(r.claudePrompts, 0);
});

test('a codex block does not affect Claude: its chat turn and tasks run, and only codex shows as blocked', { timeout: 60000 }, async () => {
  const r = await scenario(`
    const pid = project(), pid2 = project();
    const plain = task(pid, 'Plain'), cx = task(pid2, 'Add tests', 'codex');
    await o.planTurn({ id: 'cl', cwd: dir() }, 'hello claude');
    await until(() => get(plain).status === 'done' && get(cx).status === 'done');
    return { plain: get(plain), cx: get(cx), chat, pending: pending(), blocks: o.stateView().blocks, blockedUntil: o.stateView().blockedUntil };`,
  { 'blocked_until:codex': 3600 });
  assert.equal(r.pending, 0);
  assert.ok(!r.chat.some((m) => /usage limit/.test(m.text || '')), JSON.stringify(r.chat));
  assert.equal(r.plain.status, 'done');
  assert.equal(r.plain.ran_agent, 'claude');
  // The codex-routed task falls back to the unblocked Claude.
  assert.equal(r.cx.status, 'done');
  assert.equal(r.cx.ran_agent, 'claude');
  assert.deepEqual(Object.keys(r.blocks), ['codex']);
  assert.equal(r.blockedUntil, null);
});
