// delegate.mjs: the owner's fallback list; plus the orchestrator moving a waiting task with a fallback list off a limited
// Claude onto its first usable fallback, while tasks with no or an empty list wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDelegator, parseFallbacks } from '../delegate.mjs';

const models = { claude: [{ id: 'opus', default: true }], codex: [{ id: 'gpt-a' }, { id: 'gpt-mini' }], antigravity: [{ id: 'gemini-x' }, { id: 'claude-sonnet-4-6' }] };
const mk = (over = {}) => createDelegator({ agents: () => Object.keys(models), models: (id) => models[id], connected: () => true, blockedUntil: () => 0, windows: () => [], ...over });
const current = { agent: 'claude', model: 'opus' };
const pick = (d, fallbacks, cur = current) => d.nextModel({ fallbacks }, cur)?.model ?? null;

test('nextModel: the first listed model with usage left, in the owner\'s order; none without a list', () => {
  const list = [{ agent: 'codex', model: 'gpt-mini' }, { agent: 'codex', model: 'gpt-a' }, { agent: 'antigravity', model: 'gemini-x' }];
  const d = mk();
  assert.deepEqual(d.nextModel({ fallbacks: JSON.stringify(list) }, current), { agent: 'codex', model: 'gpt-mini', rank: 1, reason: "owner's fallback #1" });
  assert.equal(pick(d, null), null, 'no list: the task waits');
  assert.equal(pick(d, '[]'), null, 'empty list: the task waits');
  assert.equal(pick(d, 'bad'), null);
  assert.equal(pick(d, [{ agent: 'claude', model: 'opus' }, ...list]), 'gpt-mini', 'the current model is skipped');
  assert.equal(pick(d, [{ agent: 'claude', model: 'opus' }], { agent: 'claude', model: null }), null, "a route without a model is the agent's default");
  assert.equal(pick(mk({ windows: (a, m) => m === 'gpt-mini' ? [{ pct: 95 }] : [] }), list), 'gpt-a', 'a window at ≥90% counts as limited');
  assert.equal(pick(mk({ blockedUntil: (a) => a === 'codex' ? 123 : 0 }), list), 'gemini-x');
  assert.equal(pick(mk({ connected: (a) => a !== 'codex' }), list), 'gemini-x');
  assert.equal(pick(d, [{ agent: 'codex', model: 'gone' }, { agent: 'nope', model: 'x' }]), null, 'unknown models and agents are skipped');
  assert.equal(parseFallbacks('bad'), null);
});

test('delegator: antigravity groups are independent: a Gemini block or full Gemini window keeps third-party models', () => {
  const grp = (m) => (/^gemini/.test(m || '') ? 'gemini' : '3p');
  const ids = (d) => d.available().map((m) => `${m.agent}/${m.model}`);
  const list = [{ agent: 'antigravity', model: 'gemini-x' }, { agent: 'antigravity', model: 'claude-sonnet-4-6' }];
  let d = mk({ blockedUntil: (id, m) => (id === 'antigravity' && grp(m) === 'gemini' ? 123 : 0) });
  assert.deepEqual(ids(d), ['claude/opus', 'codex/gpt-a', 'codex/gpt-mini', 'antigravity/claude-sonnet-4-6']);
  assert.equal(d.hasUsage('antigravity', 'gemini-x'), false);
  assert.equal(pick(d, list), 'claude-sonnet-4-6');
  d = mk({ windows: (id, m) => (id === 'antigravity' ? [{ window: `${grp(m)}-5h`, pct: grp(m) === '3p' ? 95 : 10 }] : []) });
  assert.deepEqual(ids(d), ['claude/opus', 'codex/gpt-a', 'codex/gpt-mini', 'antigravity/gemini-x']);
  assert.equal(pick(d, list.slice(1)), null);
});

// ---- orchestrator integration: a child process (createOrchestrator starts timers) with Claude blocked.
const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
test('a queued task moves to its first available fallback when its primary is limited; with an empty list it waits', { timeout: 60000 }, async () => {
  const dirs = ['cw-del-', 'cw-del-p-', 'cw-del-home-'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const [dataDir, root, home] = dirs;
  try {
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    fs.symlinkSync(fixture('codex-stub.mjs'), path.join(home, '.local/bin/codex'));
    const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { setModelCatalog } from ${url('agents.mjs')};
      import { waitFor as until } from ${JSON.stringify(new URL('./helpers/wait.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: 1 });
      setModelCatalog('codex', { models: [{ id: 'gpt-a' }, { id: 'gpt-mini' }], error: null, at: 1 });
      setModelCatalog('antigravity', { models: [], error: null, at: 1 });
      let claude = 0;
      const query = () => (async function* () { claude++; yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 }; })();
      const chat = [];
      let subscriptionChecks = 0;
      const o = createOrchestrator({ config: { pollMs: 100 }, query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => { subscriptionChecks++; return true; },
        broadcast() {}, emitChat: (cid, ev) => ev.t === 'moved' && chat.push({ cid, ...ev }), convoExists: () => true });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run('blocked_until', String(Date.now() / 1000 + 3600));
      const pid = (n) => { const p = path.join(root, n); fs.mkdirSync(p); return Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,created_at) VALUES(?,?,'active',0,0)").run(p, n).lastInsertRowid); };
      const task = (n, origin, fallbacks = null) => Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,origin,fallbacks,created_at) VALUES(?,?,?,?,?,0)')
        .run(pid(n), 'Fix the parser bug', 'code', origin, fallbacks).lastInsertRowid);
      const list = JSON.stringify([{ agent: 'codex', model: 'gpt-a' }]);
      // curated: its first fallback (antigravity) is not connected, so it moves to the second.
      const ids = { reflect: task('a', 'reflection', list), chat: task('b', 'chat', list), nolist: task('g', 'chat'), empty: task('f', 'chat', '[]'),
        curated: task('e', 'chat', JSON.stringify([{ agent: 'antigravity', model: 'gemini-x' }, { agent: 'codex', model: 'gpt-mini' }])) };
      db.prepare("UPDATE projects SET convo_id='cb' WHERE name='b'").run();
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      await until(() => ['reflect', 'chat', 'curated'].every((k) => get(ids[k]).status === 'done'));
      // After workers settle, observe another scheduler subscription check: empty lists still wait.
      await until(() => o.stateView().running === 0);
      const checks = subscriptionChecks;
      await until(() => subscriptionChecks > checks);
      const out = Object.fromEntries(Object.entries(ids).map(([k, id]) => { const t = get(id); return [k, { status: t.status, agent: t.agent, model: t.model, from: t.delegated_from, reason: t.delegated_reason, view: o.taskDetail(id).task.delegated_from }]; }));
      out.claude = claude;
      out.cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name).filter((c) => ['auto_delegate', 'pinned_model'].includes(c));
      out.events = db.prepare("SELECT message FROM events WHERE message LIKE '%moved to%'").all().map((e) => e.message);
      out.notices = chat;
      out.moves = o.taskDetail(ids.chat).task.moves;
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const env = { ...process.env, HOME: home, PATH: `${path.join(home, '.local/bin')}:${process.env.PATH}` };
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root], { encoding: 'utf8', timeout: 90000, env });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    for (const k of ['reflect', 'chat']) {
      assert.equal(r[k].status, 'done', JSON.stringify(r));
      assert.deepEqual([r[k].agent, r[k].model, r[k].from, r[k].view], ['codex', 'gpt-a', 'claude/opus', 'claude/opus']);
      assert.equal(r[k].reason, "owner's fallback #1");
    }
    // The list is used in order, skipping unavailable models; no list or an empty list never delegates.
    assert.deepEqual([r.curated.status, r.curated.agent, r.curated.model, r.curated.from, r.curated.reason], ['done', 'codex', 'gpt-mini', 'claude/opus', "owner's fallback #2"]);
    for (const k of ['empty', 'nolist']) assert.deepEqual([r[k].status, r[k].agent, r[k].from], ['queued', null, null]);
    assert.deepEqual(r.cols, [], 'auto_delegate and pinned_model are gone');
    assert.equal(r.claude, 0);
    assert.equal(r.events.length, 3);
    assert.match(r.events[0], /^#\d+ claude\/opus hit its limit → moved to codex\/gpt-a$/);
    // Each move is recorded with the limit's reset; the chat's own task posts one compact notice in that chat.
    assert.deepEqual(r.moves.map((m) => [m.from, m.to, m.by, m.until > 0]), [[{ agent: 'claude', model: 'opus' }, { agent: 'codex', model: 'gpt-a' }, 'limit', true]]);
    assert.deepEqual(r.notices.map((e) => [e.cid, e.from.model, e.to.model, e.until === r.moves[0].until]), [['cb', 'opus', 'gpt-a', true]]);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("a chat's fallback list is snapshotted onto the tasks its messages queue (live turn and saved messages)", { timeout: 60000 }, async () => {
  const dirs = ['cw-snap-', 'cw-snap-p-'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const [dataDir, proj] = dirs;
  try {
    const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { setModelCatalog } from ${url('agents.mjs')};
      import { waitFor as until } from ${JSON.stringify(new URL('./helpers/wait.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import path from 'node:path';
      const [dataDir, proj] = process.argv.slice(1);
      setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: 1 });
      const block = (n) => '\\n\`\`\`agent-orch-tasks\\n' + JSON.stringify([{ title: n, prompt: 'do it' }]) + '\\n\`\`\`';
      const query = ({ prompt }) => (async function* () {
        const reply = /FIRST|SECOND/.test(prompt) ? 'Queued.' + block(/FIRST/.test(prompt) ? 'Task one' : 'Task two') : 'AGENT-ORCH-STATUS: done — ok';
        yield { type: 'result', subtype: 'success', result: reply, session_id: 's', num_turns: 1 };
      })();
      const convo = { id: 'c1', cwd: proj, fallbacks: [{ agent: 'codex', model: 'gpt-a' }] };
      const o = createOrchestrator({ config: { pollMs: 100 }, query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => true, convoFallbacks: () => [{ agent: 'antigravity', model: 'gemini-x' }] });
      await o.planTurn(convo, 'FIRST');
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const pid = db.prepare('SELECT id FROM projects').get().id;
      db.prepare('UPDATE projects SET convo_id=? WHERE id=?').run('c1', pid);
      db.prepare("INSERT INTO messages(project_id,content,created_at) VALUES(?, 'SECOND', 0)").run(pid);
      const tid = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,created_at) VALUES(?, 'plan', 'Answer', 'x', 0)").run(pid).lastInsertRowid);
      o.taskAction(tid, 'next');
      const two = () => db.prepare("SELECT title, fallbacks FROM tasks WHERE kind='work' ORDER BY id").all();
      await until(() => two().length >= 2);
      console.log(JSON.stringify(two()));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, proj], { encoding: 'utf8', timeout: 50000 });
    const rows = JSON.parse(stdout.trim().split('\n').pop());
    assert.deepEqual(rows.map((r) => [r.title, JSON.parse(r.fallbacks)]), [
      ['Task one', [{ agent: 'codex', model: 'gpt-a' }]],
      ['Task two', [{ agent: 'antigravity', model: 'gemini-x' }]],
    ]);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
