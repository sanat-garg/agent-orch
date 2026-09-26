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
// Claude runs) and HOME/PATH pointing at the codex and agy stubs. `block` rows go into kv before anything runs.
async function scenario(body, block) {
  const dirs = ['cw-ind-', 'cw-ind-p-', 'cw-ind-home-'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const [dataDir, root, home] = dirs;
  try {
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    fs.symlinkSync(fixture('agy-stub.mjs'), path.join(home, '.local/bin/agy'));
    fs.symlinkSync(fixture('codex-stub.mjs'), path.join(home, '.local/bin/codex'));
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      import { setModelCatalog } from ${JSON.stringify(new URL('../agents.mjs', import.meta.url).href)};
      setModelCatalog('antigravity', { models: ['gemini-3.8-flash-high', 'claude-sonnet-4-6', 'gpt-oss-120b-medium'].map((id) => ({ id, label: id })), error: null, at: Date.now() });
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
      const o = createOrchestrator({ query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat: (id, m) => chat.push({ id, ...m }), convoExists: () => true });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      for (const [k, v] of Object.entries(${JSON.stringify(block)})) db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run(k, String(now() + v));
      let n = 0;
      const dir = () => { const p = path.join(root, 'p' + ++n); fs.mkdirSync(p); return p; };
      const project = () => { const p = dir(); return Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,?,50,'active',0,0)").run(p, 'p' + n).lastInsertRowid); };
      const task = (pid, title, agent = null, model = null) => Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,agent,model,created_at) VALUES(?,?,?,?,?,0)').run(pid, title, title, agent, model).lastInsertRowid);
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (f) => { for (let i = 0; i < 300 && !f(); i++) await sleep(100); };
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

test('a Claude block does not defer an antigravity chat turn; a Claude chat is deferred with a notice naming Claude', { timeout: 60000 }, async () => {
  const r = await scenario(`
    await o.planTurn({ id: 'agy', cwd: dir(), agent: 'antigravity', model: 'gemini-3.8-flash-high' }, 'hello agy');
    const agyChat = chat.filter((m) => m.id === 'agy'), pendingAfterAgy = pending();
    await o.planTurn({ id: 'cl', cwd: dir() }, 'hello claude');
    return { agyChat, pendingAfterAgy, claudeChat: chat.filter((m) => m.id === 'cl'), pending: pending(), claudePrompts: claudePrompts.length,
      plans: db.prepare("SELECT agent FROM tasks WHERE kind='plan'").all(), blocks: o.stateView().blocks };`, { blocked_until: 3600 });
  assert.equal(r.pendingAfterAgy, 0);
  assert.ok(!r.agyChat.some((m) => /usage limit/.test(m.text || '')), JSON.stringify(r.agyChat));
  assert.ok(r.agyChat.some((m) => m.t === 'text' && /hello/.test(m.text)), JSON.stringify(r.agyChat));
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
    await sleep(3500); // another poll: the Claude task still waits
    const view = o.taskDetail(plain).task;
    return { codex: get(codex), plain: get(plain), plainRunsOn: view.runs_on, claudePrompts: claudePrompts.length };`, { blocked_until: 3600 });
  assert.equal(r.codex.status, 'done');
  assert.equal(r.codex.ran_agent, 'codex');
  assert.equal(r.plain.status, 'queued');
  assert.equal(r.plain.started_at, null);
  assert.equal(r.plainRunsOn, 'claude');
  assert.equal(r.claudePrompts, 0);
});

test('an antigravity block does not affect Claude: its chat turn and tasks run, and only agy shows as blocked', { timeout: 60000 }, async () => {
  const r = await scenario(`
    const pid = project(), pid2 = project();
    const plain = task(pid, 'Plain'), agy = task(pid2, 'UI work', 'antigravity');
    await o.planTurn({ id: 'cl', cwd: dir() }, 'hello claude');
    await until(() => get(plain).status === 'done' && get(agy).status === 'done');
    return { plain: get(plain), agy: get(agy), chat, pending: pending(), blocks: o.stateView().blocks, blockedUntil: o.stateView().blockedUntil };`,
  { 'blocked_until:antigravity:gemini': 3600, 'blocked_until:antigravity:3p': 3600 });
  assert.equal(r.pending, 0);
  assert.ok(!r.chat.some((m) => /usage limit/.test(m.text || '')), JSON.stringify(r.chat));
  assert.equal(r.plain.status, 'done');
  assert.equal(r.plain.ran_agent, 'claude');
  // The agy-routed task falls back to the unblocked Claude.
  assert.equal(r.agy.status, 'done');
  assert.equal(r.agy.ran_agent, 'claude');
  assert.deepEqual(Object.keys(r.blocks), ['antigravity:gemini', 'antigravity:3p']);
  assert.equal(r.blockedUntil, null);
});

// Antigravity's Gemini and third-party (Claude/GPT-OSS) models have separate limits: one group's block never
// defers, reroutes or delegates away the other group's work.
test('antigravity: a Gemini block leaves third-party models running on agy; Gemini work falls back to Claude', { timeout: 60000 }, async () => {
  const r = await scenario(`
    const pid = project(), pid2 = project(), pid3 = project();
    const tp = task(pid, 'Third-party work', 'antigravity', 'claude-sonnet-4-6'), gem = task(pid2, 'Gemini work', 'antigravity', 'gemini-3.8-flash-high');
    const def = task(pid3, 'Default agy work', 'antigravity');
    const views = [tp, gem, def].map((id) => o.taskDetail(id).task);
    await until(() => [tp, gem, def].every((id) => get(id).status === 'done'));
    return { tp: get(tp), gem: get(gem), def: get(def), views: views.map((v) => [v.runs_on, v.limit_scope]), blocks: o.stateView().blocks };`,
  { 'blocked_until:antigravity:gemini': 3600 });
  assert.equal(r.tp.ran_agent, 'antigravity');
  assert.equal(r.tp.ran_model, 'claude-sonnet-4-6');
  assert.equal(r.gem.ran_agent, 'claude');
  assert.equal(r.def.ran_agent, 'claude'); // agy's default model is a Gemini one
  assert.deepEqual(r.views, [['antigravity', 'antigravity:3p'], ['claude', 'claude'], ['claude', 'claude']]);
  assert.deepEqual(Object.keys(r.blocks), ['antigravity:gemini']);
});

test('antigravity: a third-party block defers only a third-party chat, naming the group; a Gemini chat still runs', { timeout: 60000 }, async () => {
  const r = await scenario(`
    await o.planTurn({ id: 'gem', cwd: dir(), agent: 'antigravity', model: 'gemini-3.8-flash-high' }, 'hello gemini');
    const pendingAfterGem = pending();
    await o.planTurn({ id: 'tp', cwd: dir(), agent: 'antigravity', model: 'gpt-oss-120b-medium' }, 'hello gpt');
    return { gemChat: chat.filter((m) => m.id === 'gem'), tpChat: chat.filter((m) => m.id === 'tp'), pendingAfterGem, pending: pending(), blocks: o.stateView().blocks,
      plans: db.prepare("SELECT agent, model FROM tasks WHERE kind='plan'").all() };`,
  { 'blocked_until:antigravity:3p': 3600 });
  assert.equal(r.pendingAfterGem, 0);
  assert.ok(r.gemChat.some((m) => m.t === 'text' && /hello/.test(m.text)), JSON.stringify(r.gemChat));
  assert.equal(r.pending, 1);
  assert.ok(r.tpChat.some((m) => m.t === 'notice' && /^Saved\. Antigravity CLI \(third-party models\) is at its usage limit/.test(m.text)), JSON.stringify(r.tpChat));
  assert.deepEqual(r.plans, [{ agent: 'antigravity', model: 'gpt-oss-120b-medium' }]);
  assert.deepEqual(Object.keys(r.blocks), ['antigravity:3p']);
});
