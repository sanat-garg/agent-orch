// modelStatus(task) in public/app.js: the one vocabulary for which model a task is on and what happens at a limit.
// app.js is a plain browser script, so the pure helper is pulled out of its source and given an explicit context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const modelStatus = new Function(`${appJs.match(/^function modelStatus\(.*?^}$/ms)[0]}\nreturn modelStatus;`)();
const NAMES = { 'claude/opus': 'Opus', 'antigravity/astra': 'Astra', 'codex/gpt-6': 'GPT-6' };
const NOW = 1_790_000_000, RESET = NOW + 3 * 3600;
const ctx = (blocks = {}) => ({ blocks, now: NOW, name: (a, m) => NAMES[`${a}/${m}`] || m || a, clock: (s) => (s === RESET ? '5:00 AM' : String(s)) });
const task = (o) => ({ id: 1, kind: 'work', status: 'queued', runs_on: 'claude', runs_model: 'opus', limit_scope: 'claude', fallbacks: null, moves: [], ...o });

test('running or queued normally: just the model', () => {
  assert.equal(modelStatus(task({}), ctx()).text, 'Opus');
  assert.equal(modelStatus(task({ fallbacks: [] }), ctx()).kind, 'normal');
  const run = modelStatus(task({ status: 'running', runs_on: null, runs_model: null, ran_agent: 'claude', ran_model: 'opus',
    fallbacks: [{ agent: 'antigravity', model: 'astra' }] }), ctx());
  assert.deepEqual([run.kind, run.text], ['normal', 'Opus']);
});

test('queued with fallbacks: the next one only, the full list in the tooltip', () => {
  const fb = [{ agent: 'claude', model: 'opus' }, { agent: 'antigravity', model: 'astra' }, { agent: 'codex', model: 'gpt-6' }];
  const s = modelStatus(task({ fallbacks: fb }), ctx());
  assert.deepEqual([s.kind, s.text], ['next', 'Opus · then Astra']);
  assert.equal(s.tip, 'Fallbacks: Opus → Astra → GPT-6');
  assert.deepEqual(s.list.map((f) => f.current), [true, false, false]);
});

test('waiting on a limit with no usable fallback: the model and its reset', () => {
  const s = modelStatus(task({}), ctx({ claude: { until: RESET, known: true, reason: 'usage limit' } }));
  assert.deepEqual([s.kind, s.text, s.until], ['waiting', 'Waiting for Opus · 5:00 AM', RESET]);
  // An expired block or another agent's block doesn't make it wait.
  assert.equal(modelStatus(task({}), ctx({ claude: { until: NOW - 1 } })).kind, 'normal');
  assert.equal(modelStatus(task({}), ctx({ codex: { until: RESET } })).kind, 'normal');
});

test('delegated: the new model, where it moved from and until when', () => {
  const t = task({ runs_on: 'antigravity', runs_model: 'astra', limit_scope: 'antigravity:3p', delegated_from: 'claude/opus',
    fallbacks: [{ agent: 'antigravity', model: 'astra' }], moves: [{ at: NOW, from: { agent: 'claude', model: 'opus' }, to: { agent: 'antigravity', model: 'astra' }, until: RESET, by: 'limit' }] });
  const s = modelStatus(t, ctx({ claude: { until: RESET } }));
  assert.deepEqual([s.kind, s.text, s.from], ['delegated', 'Astra · moved from Opus (limit until 5:00 AM)', 'Opus']);
  assert.equal(s.list[0].current, true);
  // Still shown after it finished; an owner's move says so; a legacy row with only delegated_from still reads as moved.
  assert.equal(modelStatus({ ...t, status: 'done', ran_agent: 'antigravity', ran_model: 'astra' }, ctx()).text, 'Astra · moved from Opus (limit until 5:00 AM)');
  assert.equal(modelStatus({ ...t, moves: [{ ...t.moves[0], until: null, by: 'owner' }] }, ctx()).text, 'Astra · moved from Opus (by you)');
  assert.equal(modelStatus({ ...t, moves: [] }, ctx()).text, 'Astra · moved from Opus');
});
