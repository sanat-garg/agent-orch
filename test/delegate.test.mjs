// delegate.mjs: the delegation policy matrix and the owner's fallback list; plus the orchestrator moving a waiting
// reflection task (but not a default chat task) off a limited Claude onto its first usable fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { eligible, createDelegator, previewDelegation, parseFallbacks } from '../delegate.mjs';

test('policy matrix: reflect / chat+auto / chat+pinned / chat default', () => {
  assert.equal(eligible({ kind: 'work', origin: 'reflection' }), true);
  assert.equal(eligible({ kind: 'work', source: 'reflection' }), true, 'rows without origin fall back to source');
  assert.equal(eligible({ kind: 'work', origin: 'chat', auto_delegate: 1 }), true);
  assert.equal(eligible({ kind: 'work', origin: 'chat', auto_delegate: 1, pinned_model: 'opus' }), false);
  assert.equal(eligible({ kind: 'work', origin: 'chat', auto_delegate: 0, pinned_model: 'opus' }), false);
  assert.equal(eligible({ kind: 'work', origin: 'chat', auto_delegate: 0 }), false);
  assert.equal(eligible({ kind: 'work', origin: null, source: 'user' }), false);
  assert.equal(eligible({ kind: 'plan', origin: 'reflection' }), false, 'only work tasks move');
});

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

test('previewDelegation: start model, then the owner\'s list with usage; nothing without a list', () => {
  const all = [{ agent: 'claude', model: 'opus', label: 'Opus' }, { agent: 'codex', model: 'gpt-a', label: 'GPT A' }];
  const usage = (a) => ({ status: a === 'codex' ? 'limited' : 'available', until: a === 'codex' ? 9 : null });
  const list = [{ agent: 'codex', model: 'gpt-a' }, { agent: 'claude', model: 'opus' }, { agent: 'codex', model: 'gone' }];
  const r = previewDelegation({ current, all, usage, fallbacks: list });
  assert.deepEqual(r.start, { agent: 'claude', model: 'opus', label: 'Opus', status: 'available', until: null });
  assert.deepEqual(r.fallbacks, list);
  assert.deepEqual(r.candidates.map((c) => [c.model, c.label, c.rank, c.status]), [['gpt-a', 'GPT A', 1, 'limited'], ['gone', 'gone', 3, 'unavailable']]);
  assert.deepEqual(previewDelegation({ current, all, usage }).candidates, []);
});

// ---- orchestrator integration: a child process (createOrchestrator starts timers) with Claude blocked.
const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
test('a waiting reflection task moves to its first usable fallback; chat default, pinned and list-less tasks keep waiting', { timeout: 60000 }, async () => {
  const dirs = ['cw-del-', 'cw-del-p-', 'cw-del-home-'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const [dataDir, root, home] = dirs;
  try {
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    fs.symlinkSync(fixture('codex-stub.mjs'), path.join(home, '.local/bin/codex'));
    const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { setModelCatalog } from ${url('agents.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: 1 });
      setModelCatalog('codex', { models: [{ id: 'gpt-a' }, { id: 'gpt-mini' }], error: null, at: 1 });
      setModelCatalog('antigravity', { models: [], error: null, at: 1 });
      let claude = 0;
      const query = () => (async function* () { claude++; yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 }; })();
      const o = createOrchestrator({ query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => true });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run('blocked_until', String(Date.now() / 1000 + 3600));
      const pid = (n) => { const p = path.join(root, n); fs.mkdirSync(p); return Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,created_at) VALUES(?,?,'active',0,0)").run(p, n).lastInsertRowid); };
      const task = (n, origin, auto, pinned, fallbacks = null) => Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,origin,auto_delegate,pinned_model,fallbacks,created_at) VALUES(?,?,?,?,?,?,?,0)')
        .run(pid(n), 'Fix the parser bug', 'code', origin, auto, pinned, fallbacks).lastInsertRowid);
      const list = JSON.stringify([{ agent: 'codex', model: 'gpt-a' }]);
      const ids = { reflect: task('a', 'reflection', 0, null, list), auto: task('b', 'chat', 1, null, list), nolist: task('g', 'chat', 1, null), pinned: task('c', 'chat', 0, 'opus'), plain: task('d', 'chat', 0, null),
        curated: task('e', 'chat', 1, null, JSON.stringify([{ agent: 'codex', model: 'gpt-mini' }])), empty: task('f', 'chat', 1, null, '[]') };
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 300 && !['reflect', 'auto', 'curated'].every((k) => get(ids[k]).status === 'done'); i++) await sleep(100);
      await sleep(3500);
      const out = Object.fromEntries(Object.entries(ids).map(([k, id]) => { const t = get(id); return [k, { status: t.status, agent: t.agent, model: t.model, from: t.delegated_from, reason: t.delegated_reason, view: o.taskDetail(id).task.delegated_from }]; }));
      out.claude = claude;
      out.events = db.prepare("SELECT message FROM events WHERE message LIKE '%delegated%'").all().map((e) => e.message);
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const env = { ...process.env, HOME: home, PATH: `${path.join(home, '.local/bin')}:${process.env.PATH}` };
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root], { encoding: 'utf8', timeout: 90000, env });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    for (const k of ['reflect', 'auto']) {
      assert.equal(r[k].status, 'done', JSON.stringify(r));
      assert.deepEqual([r[k].agent, r[k].model, r[k].from, r[k].view], ['codex', 'gpt-a', 'claude/opus', 'claude/opus']);
      assert.equal(r[k].reason, "owner's fallback #1");
    }
    // The chat's list is used as-is; no list or an empty list never delegates.
    assert.deepEqual([r.curated.status, r.curated.agent, r.curated.model, r.curated.from], ['done', 'codex', 'gpt-mini', 'claude/opus']);
    assert.match(r.curated.reason, /^owner's fallback #1/);
    for (const k of ['pinned', 'plain', 'empty', 'nolist']) assert.deepEqual([r[k].status, r[k].agent, r[k].from], ['queued', null, null]);
    assert.equal(r.claude, 0);
    assert.equal(r.events.length, 3);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
