// cron.mjs: parsing, next run in a time zone (incl. DST), and the plain-English description.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCron, nextRun, parseCron, validTz } from '../cron.mjs';

const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();

test('fields: lists, ranges, steps, names, 7 = Sunday, aliases', () => {
  const c = parseCron('0,30 9-17/4 * jan-mar mon,fri,7');
  assert.deepEqual([...c.minute], [0, 30]);
  assert.deepEqual([...c.hour], [9, 13, 17]);
  assert.deepEqual([...c.month], [1, 2, 3]);
  assert.deepEqual([...c.dow].sort(), [0, 1, 5]);
  assert.deepEqual([...parseCron('@daily').hour], [0]);
  assert.deepEqual([...parseCron('5/20 * * * *').minute], [5, 25, 45]);
});

test('bad expressions throw readable errors', () => {
  for (const [bad, msg] of [['', /5 fields/], ['* * *', /got 3/], ['60 * * * *', /minute: 60 is outside 0-59/], ['5-1 * * * *', /backwards/],
    ['x * * * *', /not a number/], ['*/0 * * * *', /positive/], ['* * 0 * *', /day of month: 0/]]) assert.throws(() => parseCron(bad), msg);
});

test('nextRun is strictly after, in the given zone', () => {
  const now = at('2026-10-04T11:00:30Z');
  assert.equal(iso(nextRun('0 9 * * *', now, 'Asia/Kolkata')), '2026-10-05T03:30:00.000Z');
  assert.equal(iso(nextRun('*/15 * * * *', now, 'UTC')), '2026-10-04T11:15:00.000Z');
  assert.equal(iso(nextRun('0 11 * * *', at('2026-10-04T11:00:00Z'), 'UTC')), '2026-10-05T11:00:00.000Z');
  assert.equal(iso(nextRun('30 18 * * 1-5', now, 'America/New_York')), '2026-10-05T22:30:00.000Z'); // Sunday → Monday
  assert.equal(iso(nextRun('0 0 1 * *', now, 'UTC')), '2026-11-01T00:00:00.000Z');
  assert.equal(nextRun('0 9 31 2 *', now, 'UTC'), null);
  assert.equal(iso(nextRun('0 9 * * *', now, 'Not/AZone')), '2026-10-05T09:00:00.000Z'); // unknown zone → UTC
});

test('day of month OR day of week when both are set', () => {
  // 2026-10-05 is a Monday, before the 15th.
  assert.equal(iso(nextRun('0 9 15 * 1', at('2026-10-04T12:00Z'), 'UTC')), '2026-10-05T09:00:00.000Z');
});

test('DST: a repeated hour runs once, a skipped one still runs that day', () => {
  // New York falls back on 2026-11-01 (01:00-02:00 happens twice).
  const first = nextRun('30 1 * * *', at('2026-11-01T04:00Z'), 'America/New_York');
  assert.equal(iso(first), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(nextRun('30 1 * * *', first, 'America/New_York')), '2026-11-02T06:30:00.000Z');
  // Springs forward on 2027-03-14 (02:30 doesn't exist).
  const t = nextRun('30 2 * * *', at('2027-03-13T12:00Z'), 'America/New_York');
  assert.ok(t > at('2027-03-14T05:00Z') && t < at('2027-03-14T08:00Z'), iso(t));
});

test('describeCron', () => {
  for (const [e, d] of [['0 9 * * *', 'Every day at 09:00'], ['30 18 * * 1-5', 'Weekdays at 18:30'], ['0 10 * * 0,6', 'Weekends at 10:00'],
    ['0 8 * * 1,3', 'Every Mon, Wed at 08:00'], ['0 7 1 * *', 'Monthly on the 1st at 07:00'], ['*/15 * * * *', 'Every 15 minutes'],
    ['0 * * * *', 'Every hour'], ['0 */6 * * *', 'Every 6 hours'], ['@weekly', 'Every Sun at 00:00'], ['0 9 1 1 *', 'Cron: 0 9 1 1 *']]) assert.equal(describeCron(e), d, e);
});

test('validTz', () => {
  assert.equal(validTz('Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(validTz('Mars/Olympus'), null);
  assert.equal(validTz(''), null);
});
