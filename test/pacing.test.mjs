// Pacing governor: decide() turns 5h/weekly usage readings into allowed urgencies, slots and cooldowns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../orchestrator.mjs';

const T = 1_800_000_000, H = 3600, D = 86400;
const ALL = ['urgent', 'normal', 'background'];
const week = (utilization, resetsIn, age = 0) => ({ limit_type: 'seven_day', utilization, resets_at: T + resetsIn, observed_at: T - age });
const fiveH = (utilization, resetsIn, age = 0) => ({ limit_type: 'five_hour', utilization, resets_at: T + resetsIn, observed_at: T - age });

test('no data gives the default pace', () => {
  assert.deepEqual(decide([], T, false), {
    allowed: ALL, concurrency: 2, cooldown: 3600, pushHarder: false, scarce: false,
    reason: 'no usage data yet -- running at default pace',
  });
});

test('weekly use near the reset spends the leftover', () => {
  const d = decide([week(0.5, 6 * H)], T, false);
  assert.deepEqual(d.allowed, ALL);
  assert.equal(d.concurrency, 3);
  assert.equal(d.cooldown, 300);
  assert.equal(d.pushHarder, true);
  assert.equal(d.scarce, false);
  assert.match(d.reason, /weekly usage at 50% with the reset 6h away -- using the leftover 50%/);
});

test('a stale weekly reading does not spend the leftover, and says so', () => {
  const d = decide([week(0.5, 6 * H, 20 * 60)], T, false);
  assert.equal(d.pushHarder, false);
  assert.equal(d.concurrency, 2);
  assert.deepEqual(d.allowed, ALL);
  assert.match(d.reason, /weekly reading is stale -- not pushing on it/);
});

test('high weekly use allows urgent only while urgent work waits', () => {
  const d = decide([week(0.95, 6 * D)], T, true);
  assert.deepEqual(d.allowed, ['urgent']);
  assert.equal(d.scarce, true);
  assert.equal(d.concurrency, 2);
  assert.match(d.reason, /weekly usage at 95% -- urgent work only while it waits/);
});

test('high weekly use with nothing urgent waiting allows urgent+normal', () => {
  const d = decide([week(0.95, 6 * D)], T, false);
  assert.deepEqual(d.allowed, ['urgent', 'normal']);
  assert.equal(d.scarce, true);
  assert.match(d.reason, /nothing urgent waits, so normal work continues/);
});

test('background work pauses at the background_stop tier', () => {
  const d = decide([week(0.8, 6 * D)], T, true);
  assert.deepEqual(d.allowed, ['urgent', 'normal']);
  assert.equal(d.scarce, true);
  assert.equal(d.pushHarder, false);
  assert.match(d.reason, /weekly usage at 80% -- pausing background work/);
});

test('the background_stop threshold rises with the elapsed week', () => {
  // 1 day left: elapsed ~0.857, so bgStop ~0.957 and 0.8 is on pace.
  const d = decide([week(0.8, 1 * D)], T, false);
  assert.deepEqual(d.allowed, ALL);
  assert.equal(d.scarce, false);
  assert.match(d.reason, /weekly usage at 80% with 24h to go, on pace/);
});

test('an under-used 5h window late in the window pushes harder', () => {
  const d = decide([week(0.1, 6 * D), fiveH(0.1, 1 * H)], T, false);
  assert.deepEqual(d.allowed, ALL);
  assert.equal(d.concurrency, 3);
  assert.equal(d.cooldown, 300);
  assert.equal(d.pushHarder, true);
  assert.match(d.reason, /5h window only 10% used with 60m left \(should be near 80%\) -- pushing harder/);
});

test('no 5h push when the week is ahead of pace', () => {
  const d = decide([week(0.5, 6 * D), fiveH(0.1, 1 * H)], T, false);
  assert.equal(d.pushHarder, false);
  assert.equal(d.concurrency, 2);
  assert.match(d.reason, /not pushing the 5h window harder because the week is ahead of pace/);
});

test('a 5h window early on is not pushed', () => {
  const d = decide([fiveH(0.1, 4.5 * H)], T, false);
  assert.equal(d.pushHarder, false);
  assert.equal(d.concurrency, 2);
  assert.equal(d.reason, 'no weekly usage data yet');
});

test('high 5h utilisation drops concurrency to 1, even while spending the weekly leftover', () => {
  const d = decide([fiveH(0.95, 2 * H)], T, false);
  assert.equal(d.concurrency, 1);
  assert.equal(d.pushHarder, false);
  assert.equal(d.cooldown, 3600);
  assert.match(d.reason, /5h window at 95% -- dropping to one slot/);
  const u = decide([week(0.5, 6 * H), fiveH(0.95, 2 * H)], T, false);
  assert.equal(u.concurrency, 1);
  assert.equal(u.pushHarder, false);
  assert.deepEqual(u.allowed, ALL);
});

test('readings older than 5h/7d are disregarded, and the reason says so', () => {
  const d = decide([week(0.95, 6 * D, 8 * D), fiveH(0.95, 2 * H, 6 * H)], T, true);
  assert.deepEqual(d.allowed, ALL);
  assert.equal(d.concurrency, 2);
  assert.equal(d.reason, 'no usage data yet -- running at default pace; 5h reading too old -- disregarded; weekly reading too old -- disregarded');
  const w = decide([week(0.5, 6 * D), fiveH(0.95, 2 * H, 6 * H)], T, false);
  assert.equal(w.concurrency, 2);
  assert.match(w.reason, /; 5h reading too old -- disregarded$/);
});

test('a stale 5h reading does not push harder, and adds a note', () => {
  const d = decide([week(0.1, 6 * D), fiveH(0.1, 1 * H, 20 * 60)], T, false);
  assert.equal(d.pushHarder, false);
  assert.equal(d.concurrency, 2);
  assert.match(d.reason, /; 5h reading is stale -- not pushing on it$/);
});
