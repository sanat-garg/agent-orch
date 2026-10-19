import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLog } from '../usage.mjs';
import { chatUsage, MIN_PCT } from '../chat-usage.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chat-usage-test-'));
const H = 3600e3, D = 86400e3;
const claude = (input, output, cached = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cached });

test('lifetime totals per chat and task are kept, rebuilt from the jsonl, and merged', () => {
  const dir = tmp();
  let t = Date.UTC(2026, 9, 1);
  const log = createUsageLog(dir, { now: () => t });
  log.tokens('claude', claude(100, 10, 1000), 'chat', 'c1', { model: 'opus' });
  t += H;
  log.tokens('claude', claude(50, 5), 'chat', 'c1', { model: 'fable' });
  log.tokens('claude', claude(7, 1), 'chat', 'c2', { model: 'opus' });
  log.tokens('codex', { input_tokens: 30, output_tokens: 3 }, 'task', 9, { model: 'gpt-5' });
  log.tokens('claude', claude(1, 1), 'chat', null); // no ref: history only
  const c1 = log.totalsOf('chat', 'c1');
  assert.equal(c1.turns, 2);
  assert.deepEqual(c1.models['claude/opus'], { input: 100, output: 10, cached: 1000, turns: 1 });
  assert.equal(log.totalsOf('task', 9).models['codex/gpt-5'].input, 30);
  assert.ok(fs.existsSync(path.join(dir, 'metrics', 'token-totals.json')));

  // A missing totals file is rebuilt from the jsonl.
  fs.rmSync(path.join(dir, 'metrics', 'token-totals.json'));
  const again = createUsageLog(dir, { now: () => t });
  assert.deepEqual(again.totalsOf('chat', 'c1'), c1);

  again.mergeTotals('chat', 'c2', 'c1');
  assert.equal(again.totalsOf('chat', 'c2'), null);
  assert.equal(again.totalsOf('chat', 'c1').models['claude/opus'].input, 107);
  assert.equal(again.totalsOf('chat', 'c1').turns, 3);
});

test('a chat is compared with each weekly window, sized from the reading', () => {
  const dir = tmp();
  const start = Date.UTC(2026, 9, 10);
  let t = start - 10 * D; // an older turn: lifetime only
  const log = createUsageLog(dir, { now: () => t });
  log.tokens('claude', claude(1000, 0), 'chat', 'c1', { model: 'opus' });
  t = start + D;
  log.tokens('claude', claude(1000, 0), 'chat', 'c1', { model: 'opus' }); // weight 1000
  log.tokens('claude', claude(3000, 0), 'chat', 'other', { model: 'opus' });
  log.tokens('claude', claude(0, 200), 'task', 4, { model: 'fable' }); // weight 1000
  const resetsAt = (start + 7 * D) / 1000;
  log.window('claude', 'seven_day', 10, resetsAt); // 5000 weighted so far = 10% → a week is 50000
  log.window('claude', 'Fable', 1, resetsAt); // below MIN_PCT: not sized
  log.window('claude', 'five_hour', 80, (t + H) / 1000); // not weekly
  t += H;
  log.tokens('claude', claude(500, 0), 'chat', 'c1', { model: 'opus' }); // after the reading: counts for the chat, not the size

  const r = chatUsage({ usageLog: log, refs: [{ source: 'chat', ref: 'c1' }], tasks: [{ source: 'task', ref: 4 }], now: t });
  assert.equal(r.chat.input, 2500);
  assert.equal(r.chat.turns, 3);
  assert.equal(r.tasks.output, 200);
  const week = r.weeks.find((w) => w.window === 'seven_day');
  assert.equal(week.size, 50000);
  assert.equal(week.week, 3); // 1500 / 50000
  assert.equal(week.life, 5); // 2500 / 50000
  assert.equal(week.tasksWeek, 2);
  assert.ok(!r.weeks.some((w) => w.window === 'five_hour'));
  const fable = r.weeks.find((w) => w.window === 'Fable');
  assert.ok(MIN_PCT > 1 && fable.size === null && fable.life === null); // the chat used no Fable, but its tasks did
  // A sub chat (no tasks), and a chat that never used a per-model window's model, has no row for it.
  const sub = chatUsage({ usageLog: log, refs: [{ source: 'chat', ref: 'c1' }], now: t });
  assert.equal(sub.tasks, null);
  assert.deepEqual(sub.weeks.map((w) => w.window), ['seven_day']);
});

test('recent totals cover only the supplied refs\' turns from now minus seven days through now', () => {
  const dir = tmp();
  const now = Date.UTC(2026, 9, 19, 12);
  let t = now - 7 * D - 1; // just outside the interval: lifetime only
  const log = createUsageLog(dir, { now: () => t });
  log.tokens('claude', claude(1, 1), 'chat', 'c1', { model: 'opus' });
  t = now - 7 * D; // the interval's first millisecond
  log.tokens('claude', claude(100, 10, 1000), 'chat', 'c1', { model: 'opus' });
  t = now - D;
  log.tokens('codex', { input_tokens: 40, output_tokens: 4 }, 'chat', 'c1', { model: 'gpt-5' });
  log.tokens('claude', claude(9000, 900), 'chat', 'other', { model: 'opus' }); // unrelated chat
  log.tokens('claude', claude(8000, 800), 'task', 99, { model: 'opus' }); // unrelated task
  log.tokens('claude', claude(20, 2), 'task', 5, { model: 'fable' });
  t = now; // the interval's last millisecond
  log.tokens('claude', claude(3, 0), 'chat', 'c1', { model: 'opus' });
  t = now + 1; // after `now`: outside
  log.tokens('claude', claude(5000, 0), 'chat', 'c1', { model: 'opus' });
  log.tokens('claude', claude(5000, 0), 'task', 5, { model: 'fable' });

  const r = chatUsage({ usageLog: log, refs: [{ source: 'chat', ref: 'c1' }], tasks: [{ source: 'task', ref: 5 }], now });
  assert.equal(r.recent.since, now - 7 * D);
  assert.equal(r.recent.until, now);
  assert.deepEqual([r.recent.chat.input, r.recent.chat.output, r.recent.chat.cached, r.recent.chat.turns], [143, 14, 1000, 3]);
  assert.equal(r.recent.chat.first, now - 7 * D);
  assert.equal(r.recent.chat.last, now);
  assert.deepEqual(r.recent.chat.models.map((m) => [m.agent, m.model, m.input, m.turns]), [['claude', 'opus', 103, 2], ['codex', 'gpt-5', 40, 1]]);
  assert.deepEqual([r.recent.tasks.input, r.recent.tasks.output, r.recent.tasks.turns], [20, 2, 1]);
  assert.deepEqual(r.recent.tasks.models.map((m) => m.model), ['fable']);
  // The lifetime fields are unchanged: every turn, inside the interval or not.
  assert.equal(r.chat.turns, 5);
  assert.equal(r.chat.input, 5144);
  assert.equal(r.tasks.turns, 2);

  // No tasks supplied: no recent task totals. A chat with nothing recent has an empty recent Sum.
  assert.equal(chatUsage({ usageLog: log, refs: [{ source: 'chat', ref: 'c1' }], now }).recent.tasks, null);
  const quiet = chatUsage({ usageLog: log, refs: [{ source: 'chat', ref: 'c1' }], tasks: [], now: now + 30 * D });
  assert.deepEqual(quiet.recent.chat, { input: 0, output: 0, cached: 0, turns: 0, first: null, last: null, models: [] });
  assert.equal(quiet.recent.tasks.turns, 0);
});
