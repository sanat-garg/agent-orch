// delegate.mjs: the delegation policy matrix, task categories and ranking on fixture metrics; plus the orchestrator
// moving a waiting reflection task (but not a default chat task) off a limited Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { eligible, taskCategory, rankCandidates, createDelegator, weightedScore, previewDelegation, parseFallbacks, rankingEntries } from '../delegate.mjs';

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

test('task category: planner-provided wins, else keywords, else general', () => {
  assert.equal(taskCategory({ category: 'scientific', title: 'Fix the API bug' }), 'scientific');
  assert.equal(taskCategory({ title: 'Fix the login bug', prompt: 'Add a test for the endpoint' }), 'coding');
  assert.equal(taskCategory({ title: 'Automate the deploy pipeline', prompt: 'multi-step workflow' }), 'agentic');
  assert.equal(taskCategory({ title: 'Analyze the survey dataset', prompt: 'statistics and plots' }), 'scientific');
  assert.equal(taskCategory({ title: 'Write the README intro', prompt: 'Explain what it is.' }), 'general');
});

// Exact-identity LiveBench view fixtures; conflicting AA metrics must be ignored.
const entry = (agent, model, coding, agentic = coding, math = coding, data = math) => ({ agent, model, label: model,
  livebench: { model, release: '2026-06-25' }, scores: { global_average: coding, categories: { Coding: coding, 'Agentic Coding': agentic, Mathematics: math, 'Data Analysis': data } }, metrics: { coding_index: 100 } });
const entries = [entry('claude', 'opus', 60, 70, 80), entry('codex', 'gpt-a', 59, 40, 79), entry('codex', 'gpt-b', 65, 69, 30), entry('codex', 'gpt-mini', 10), entry('antigravity', 'gemini-x', 40, 75, 85), { agent: 'antigravity', model: 'gemini-none' }];
const current = { agent: 'claude', model: 'opus' };
const view = (over = {}) => ({ source: 'livebench', data_status: 'ready', stale: false, release: '2026-06-25', entries, ...over });
const all = entries.map(({ agent, model }) => ({ agent, model }));
const names = r => r.candidates.map(c => c.model);
const mk = (over = {}) => createDelegator({ agents: () => ['claude', 'codex', 'antigravity'], connected: () => true,
  blockedUntil: () => 0, models: a => all.filter(m => m.agent === a).map(m => ({ id: m.model })), metrics: () => view(), ...over });

test('LiveBench categories, percentage-point threshold, missing categories and same-release comparison', () => {
  const rank = category => rankCandidates({ current, entries, available: all, category });
  assert.deepEqual(names(rank('coding')), ['gpt-a', 'gpt-b', 'gemini-none']);
  assert.deepEqual(names(rank('agentic')), ['gpt-b', 'gemini-x', 'gemini-none']);
  assert.deepEqual(names(rank('scientific')), ['gpt-a', 'gemini-x', 'gemini-none']);
  assert.deepEqual(names(rank('general')), names(rank('coding')));
  assert.equal(weightedScore({ categories: { Coding: 0.5 } }, { Coding: 1 }).score, 0.5);
  assert.equal(weightedScore({ categories: { Mathematics: 80 } }, { Mathematics: .5, 'Data Analysis': .5 }), null);
  const mixed = structuredClone(entries); mixed[1].livebench.release = '2025-01-01';
  const r = rankCandidates({ current, entries: mixed, available: all, category: 'coding' });
  assert.equal(r.candidates.find(c => c.model === 'gpt-a').score, null);
  assert.equal(rank('coding').candidates.find(c => c.model === 'gemini-none').benchmark, false);
});

test('preview and execution agree across categories, exhausted usage, unavailable agents, stale/unavailable data', () => {
  for (const category of ['coding', 'agentic', 'scientific', 'general']) {
    for (const state of [{}, { stale: true }, { data_status: 'unavailable' }, { source: 'artificialanalysis' }]) {
      const v = view(state);
      const usage = (a, m) => ({ status: a === 'claude' || m === 'gpt-b' ? 'limited' : a === 'antigravity' ? 'unavailable' : 'available' });
      const d = mk({ metrics: () => v, connected: a => a !== 'antigravity', blockedUntil: a => a === 'claude' ? 123 : 0,
        windows: (a, m) => m === 'gpt-b' ? [{ pct: 90 }] : [] });
      const execution = d.candidates({ category }, current);
      const preview = previewDelegation({ current, entries: rankingEntries(v), all: all.filter(m => m.agent !== 'antigravity'), usage, category, limit: 100 });
      assert.deepEqual(preview.candidates.filter(c => c.status === 'available').map(c => [c.model, c.score, c.reason]), execution.candidates.map(c => [c.model, c.score, c.reason]));
      if (Object.keys(state).length) assert.ok(execution.candidates.every(c => c.score === null && /non-benchmark/.test(c.reason)));
    }
  }
});

test('unmatched deterministic fallback prefers current agent; explicit owner order and empty override win', () => {
  const d = mk({ metrics: () => view({ stale: true }) });
  assert.deepEqual(names(d.candidates({}, { agent: 'codex', model: 'gpt-a' })), ['gpt-b', 'gpt-mini', 'gemini-none', 'gemini-x', 'opus']);
  const list = [{ agent: 'codex', model: 'gpt-mini' }, { agent: 'codex', model: 'gpt-a' }];
  assert.deepEqual(names(d.candidates({ fallbacks: JSON.stringify(list) }, current)), ['gpt-mini', 'gpt-a']);
  assert.deepEqual(names(d.candidates({ fallbacks: '[]' }, current)), []);
  assert.deepEqual(names(mk({ windows: (a, m) => m === 'gpt-mini' ? [{ pct: 95 }] : [] }).candidates({ fallbacks: list }, current)), ['gpt-a']);
  assert.deepEqual(names(mk().candidates({ fallbacks: [{ agent: 'codex', model: 'gone' }] }, current)), []);
  assert.equal(parseFallbacks('bad'), null);
});

test('delegator: antigravity groups are independent: a Gemini block or full Gemini window keeps third-party models', () => {
  const models = { claude: [{ id: 'opus', default: true }], codex: [{ id: 'gpt-a' }], antigravity: [{ id: 'gemini-x' }, { id: 'claude-sonnet-4-6' }] };
  const grp = (m) => (/^gemini/.test(m || '') ? 'gemini' : '3p');
  const mk = (over = {}) => createDelegator({ agents: () => Object.keys(models), models: (id) => models[id], metrics: () => view(),
    connected: () => true, blockedUntil: () => 0, windows: () => [], ...over });
  const ids = (d) => d.available().map((m) => `${m.agent}/${m.model}`);
  let d = mk({ blockedUntil: (id, m) => (id === 'antigravity' && grp(m) === 'gemini' ? 123 : 0) });
  assert.deepEqual(ids(d), ['claude/opus', 'codex/gpt-a', 'antigravity/claude-sonnet-4-6']);
  assert.equal(d.hasUsage('antigravity', 'gemini-x'), false);
  d = mk({ windows: (id, m) => (id === 'antigravity' ? [{ window: `${grp(m)}-5h`, pct: grp(m) === '3p' ? 95 : 10 }] : []) });
  assert.deepEqual(ids(d), ['claude/opus', 'codex/gpt-a', 'antigravity/gemini-x']);
});

// ---- orchestrator integration: a child process (createOrchestrator starts timers) with Claude blocked.
const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
test('a waiting reflection task moves to the top candidate; chat default and pinned tasks keep waiting', { timeout: 60000 }, async () => {
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
      const entries = ${JSON.stringify(entries)};
      let claude = 0;
      const query = () => (async function* () { claude++; yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 }; })();
      const o = createOrchestrator({ query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => true, modelMetrics: () => ({ source: 'livebench', data_status: 'ready', stale: false, release: '2026-06-25', entries }) });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run('blocked_until', String(Date.now() / 1000 + 3600));
      const pid = (n) => { const p = path.join(root, n); fs.mkdirSync(p); return Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,created_at) VALUES(?,?,'active',0,0)").run(p, n).lastInsertRowid); };
      const task = (n, origin, auto, pinned, fallbacks = null) => Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,origin,auto_delegate,pinned_model,fallbacks,created_at) VALUES(?,?,?,?,?,?,?,0)')
        .run(pid(n), 'Fix the parser bug', 'code', origin, auto, pinned, fallbacks).lastInsertRowid);
      const ids = { reflect: task('a', 'reflection', 0, null), auto: task('b', 'chat', 1, null), pinned: task('c', 'chat', 0, 'opus'), plain: task('d', 'chat', 0, null),
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
      assert.match(r[k].reason, /^LiveBench 2026-06-25 coding: 59 vs opus 60/);
    }
    // The chat's curated list is used as-is (gpt-mini is far from comparable); an empty list never delegates.
    assert.deepEqual([r.curated.status, r.curated.agent, r.curated.model, r.curated.from], ['done', 'codex', 'gpt-mini', 'claude/opus']);
    assert.match(r.curated.reason, /^owner's fallback #1/);
    for (const k of ['pinned', 'plain', 'empty']) assert.deepEqual([r[k].status, r[k].agent, r[k].from], ['queued', null, null]);
    assert.equal(r.claude, 0);
    assert.equal(r.events.length, 3);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
