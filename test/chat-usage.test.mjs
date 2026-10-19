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
