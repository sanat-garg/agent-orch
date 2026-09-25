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
import { eligible, taskCategory, rankCandidates, createDelegator, weightedScore, previewDelegation } from '../delegate.mjs';

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

// Fixture metrics in the aa.mjs view shape (benchmarks as AA fractions).
const M = (ii, ci, ai, tb, sc) => ({ intelligence_index: ii, coding_index: ci, agentic_index: ai, benchmarks: { terminalbench_hard: tb, scicode: sc } });
const entries = [
  { agent: 'claude', model: 'opus', label: 'Opus', metrics: M(70, 60, 65, 0.50, 0.45) },    // coding 56
  { agent: 'claude', model: 'haiku', label: 'Haiku', metrics: M(40, 30, 35, 0.20, 0.30) },  // coding 26
  { agent: 'codex', model: 'gpt-a', label: 'GPT A', metrics: M(69, 58, 50, 0.48, 0.44) },   // coding 54, 96%
  { agent: 'codex', model: 'gpt-b', label: 'GPT B', metrics: M(75, 64, 70, 0.55, 0.40) },   // coding 60.4, above
  { agent: 'codex', model: 'gpt-mini', label: 'GPT mini', metrics: M(30, 20, 20, 0.10, 0.10) }, // coding 12
  { agent: 'antigravity', model: 'gemini-x', label: 'Gemini X', metrics: M(60, 45, 66, 0.35, 0.60) }, // coding 41
  { agent: 'antigravity', model: 'gemini-none', label: 'Gemini none', metrics: null },
];
const avail = (...ids) => entries.filter((e) => ids.includes(e.model)).map(({ agent, model }) => ({ agent, model }));

test('weighted score puts indexes and fractional benchmarks on one scale', () => {
  const s = weightedScore(entries[0].metrics, { coding_index: 0.6, terminalbench_hard: 0.4 });
  assert.equal(Math.round(s.score * 10) / 10, 56);
  assert.deepEqual(s.used, { coding_index: 60, terminalbench_hard: 50 });
});

test('ranking (coding): comparable by ≥95% score or within 2 ranks, most similar first, with reasons', () => {
  const r = rankCandidates({ current: { agent: 'claude', model: 'opus' }, entries, available: avail('opus', 'gpt-a', 'gpt-b', 'gpt-mini', 'gemini-x', 'gemini-none'), category: 'coding' });
  assert.equal(r.original.score, 56);
  // Order by score: gpt-b 60.4, opus 56, gpt-a 54, gemini-x 41, gpt-mini 12 → gemini-x is 2 ranks below; gpt-mini 3.
  assert.deepEqual(r.candidates.map((c) => c.model), ['gpt-a', 'gpt-b', 'gemini-x']);
  const [a, , g] = r.candidates;
  assert.equal(a.score, 54); assert.ok(a.ratio >= 0.95);
  assert.deepEqual(a.metrics, { coding_index: 58, terminalbench_hard: 48 });
  assert.match(a.reason, /^coding: 54 vs Opus 56 \(96%\); Coding Index 58, Terminal-Bench 48$/);
  assert.match(g.reason, /rank 4 vs 2/);
  assert.ok(!r.candidates.some((c) => c.model === 'opus' || c.model === 'gemini-none'));
});

test('ranking uses the category metrics and the rank window from cfg', () => {
  const all = avail('gpt-a', 'gpt-b', 'gpt-mini', 'gemini-x', 'haiku');
  // agentic: opus 65 → gemini-x 66 and gpt-b 70 by score; gpt-a 50 and haiku 35 within 2 ranks (70, 66, [65], 50, 35, 20).
  const ag = rankCandidates({ current: { agent: 'claude', model: 'opus' }, entries, available: all, category: 'agentic' });
  assert.deepEqual(ag.candidates.map((c) => c.model), ['gemini-x', 'gpt-b', 'gpt-a', 'haiku']);
  // scientific: SciCode only (no rank window); gemini-x (60) is far above, gpt-b (40) below 95%.
  const sc = rankCandidates({ current: { agent: 'claude', model: 'opus' }, entries, available: all, category: 'scientific', cfg: { minRatio: 0.95, rankWindow: 0 } });
  assert.deepEqual(sc.candidates.map((c) => c.model), ['gpt-a', 'gemini-x']);
  // general with a tight window: only ≥95% of 70 on the Intelligence Index.
  const ge = rankCandidates({ current: { agent: 'claude', model: 'opus' }, entries, available: all, category: 'general', cfg: { minRatio: 0.95, rankWindow: 0 } });
  assert.deepEqual(ge.candidates.map((c) => c.model), ['gpt-a', 'gpt-b']);
  // No metrics for the original: nothing is comparable.
  assert.deepEqual(rankCandidates({ current: { agent: 'antigravity', model: 'gemini-none' }, entries, available: all }).candidates, []);
});

test('delegator: blocked, disconnected and ≥90% windows exclude an agent; default model stands in for none', () => {
  const models = { claude: [{ id: 'opus', default: true }, { id: 'haiku' }], codex: [{ id: 'gpt-a' }, { id: 'gpt-b' }], antigravity: [{ id: 'gemini-x' }] };
  const mk = (over = {}) => createDelegator({ agents: () => Object.keys(models), models: (id) => models[id], metrics: () => ({ entries }),
    connected: () => true, blockedUntil: (id) => (id === 'claude' ? 123 : 0), windows: () => [], ...over });
  const task = { title: 'Fix the parser bug', prompt: 'code' };
  let r = mk().candidates(task, { agent: 'claude', model: null });
  assert.equal(r.original.model, 'opus');
  assert.deepEqual(r.candidates.map((c) => c.model), ['gpt-a', 'gpt-b', 'gemini-x']);
  r = mk({ windows: (id) => (id === 'codex' ? [{ window: '5h', pct: 91 }] : []) }).candidates(task, { agent: 'claude', model: 'opus' });
  assert.deepEqual(r.candidates.map((c) => c.model), ['gemini-x']);
  r = mk({ connected: (id) => id !== 'antigravity', windows: (id) => (id === 'codex' ? [{ window: '5h', pct: 89 }] : []) }).candidates(task, { agent: 'claude', model: 'opus' });
  assert.deepEqual(r.candidates.map((c) => c.model), ['gpt-a', 'gpt-b']);
});

test('preview: start model plus top 3; a limited agent\'s models are marked and ranked after usable ones', () => {
  const all = avail('opus', 'haiku', 'gpt-a', 'gpt-b', 'gpt-mini', 'gemini-x').map((m) => ({ ...m, label: entries.find((e) => e.model === m.model).label }));
  const usage = (a) => (a === 'codex' ? { status: 'limited', until: 999, note: 'usage limit' } : a === 'antigravity' ? { status: 'near', until: null, note: '5h window at 80%' } : { status: 'available', until: null, note: null });
  const r = previewDelegation({ current: { agent: 'claude', model: 'opus' }, entries, all, usage });
  assert.equal(r.category, 'coding');
  assert.deepEqual([r.start.label, r.start.score, r.start.status, r.start.metrics.agentic_index], ['Opus', 56, 'available', 65]);
  // By similarity: gpt-a, gpt-b, gemini-x; codex is limited, so gemini-x (near, still usable) comes first.
  assert.deepEqual(r.candidates.map((c) => [c.model, c.status]), [['gemini-x', 'near'], ['gpt-a', 'limited'], ['gpt-b', 'limited']]);
  assert.equal(r.candidates[1].until, 999);
  assert.equal(r.candidates[1].note, 'usage limit');
  assert.match(r.candidates[1].reason, /^coding: 54 vs Opus 56/);
  assert.equal(r.candidates[0].metrics.benchmarks.terminalbench_hard, 0.35);
  assert.equal(previewDelegation({ current: { agent: 'claude', model: 'opus' }, entries, all, usage, limit: 1 }).candidates.length, 1);
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
        broadcast() {}, emitChat() {}, convoExists: () => true, modelMetrics: () => ({ entries }) });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run('blocked_until', String(Date.now() / 1000 + 3600));
      const pid = (n) => { const p = path.join(root, n); fs.mkdirSync(p); return Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,created_at) VALUES(?,?,'active',0,0)").run(p, n).lastInsertRowid); };
      const task = (n, origin, auto, pinned) => Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,origin,auto_delegate,pinned_model,created_at) VALUES(?,?,?,?,?,?,0)')
        .run(pid(n), 'Fix the parser bug', 'code', origin, auto, pinned).lastInsertRowid);
      const ids = { reflect: task('a', 'reflection', 0, null), auto: task('b', 'chat', 1, null), pinned: task('c', 'chat', 0, 'opus'), plain: task('d', 'chat', 0, null) };
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 300 && !(get(ids.reflect).status === 'done' && get(ids.auto).status === 'done'); i++) await sleep(100);
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
      assert.match(r[k].reason, /^coding: 54 vs Opus 56/);
    }
    for (const k of ['pinned', 'plain']) assert.deepEqual([r[k].status, r[k].agent, r[k].from], ['queued', null, null]);
    assert.equal(r.claude, 0);
    assert.equal(r.events.length, 2);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
