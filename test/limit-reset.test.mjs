import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitReset } from '../orchestrator.mjs';

const t = 1_000_000;
const opts = (o = {}) => ({ reason: 'five_hour', blockedUntil: t + 320, known: false, bufferSec: 20, t, ...o });

test('uses the rejected limit\'s own reset from the limits table', () => {
  const rows = [{ limit_type: 'five_hour', status: 'rejected', resets_at: t + 5 * 3600 },
    { limit_type: 'seven_day', status: 'allowed', utilization: 0.4, resets_at: t + 3 * 86400 }];
  assert.deepEqual(limitReset(rows, opts()), { at: t + 5 * 3600, known: true });
});

test('falls back to the latest exhausted usage window when the limit type is unknown', () => {
  const rows = [{ limit_type: 'five_hour', status: 'rejected', utilization: 1, resets_at: t + 3600 },
    { limit_type: 'seven_day', status: 'rejected', utilization: 1.02, resets_at: t + 2 * 86400 },
    { limit_type: 'seven_day_opus', status: 'allowed', utilization: 0.2, resets_at: t + 3 * 86400 }];
  assert.deepEqual(limitReset(rows, opts({ reason: 'usage limit' })), { at: t + 2 * 86400, known: true });
});

test('ignores stale rows whose reset has passed', () => {
  const rows = [{ limit_type: 'five_hour', status: 'rejected', resets_at: t - 10 }];
  assert.deepEqual(limitReset(rows, opts()), { at: t + 320, known: false });
});

test('a reported reset without table data is blocked_until minus the buffer', () => {
  assert.deepEqual(limitReset([], opts({ known: true, blockedUntil: t + 1020 })), { at: t + 1000, known: true });
});

test('only a backoff guess: the retry time, marked unknown', () => {
  const rows = [{ limit_type: 'seven_day', status: 'allowed', utilization: 0.5, resets_at: t + 86400 }];
  assert.deepEqual(limitReset(rows, opts({ reason: 'usage limit' })), { at: t + 320, known: false });
  assert.deepEqual(limitReset(null, opts()), { at: t + 320, known: false });
});
