import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLog, bucketTokens, downsample, normUsage, readRecords, usageHistory, KEEP_MS, MAX_POINTS } from '../usage.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
const H = 3600e3, D = 86400e3;

test('the store round-trips window, token and limit records with dedupe', () => {
  const dir = tmp();
  let t = Date.UTC(2026, 8, 25, 12);
  const log = createUsageLog(dir, { now: () => t });
  try {
    assert.ok(log.window('claude', 'five_hour', 40, '2026-09-25T15:00:00Z'));
    t += 60e3;
    assert.equal(log.window('claude', 'five_hour', 40, '2026-09-25T15:00:00Z'), null); // unchanged within 5 min
    assert.ok(log.window('claude', 'five_hour', 41, '2026-09-25T15:00:00Z'));
    t += 6 * 60e3;
    assert.ok(log.window('claude', 'five_hour', 41, '2026-09-25T15:00:00Z')); // unchanged but older than 5 min
    assert.ok(log.tokens('codex', { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 }, 'task', 7));
    assert.ok(log.tokens('claude', { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 90, output_tokens: 3 }, 'chat', 'c1'));
    assert.equal(log.tokens('claude', {}, 'chat', 'c1'), null);
    assert.equal(log.limitCleared('codex'), null); // never hit
    assert.ok(log.limitHit('codex', 1893456000));
    assert.equal(log.limitHit('codex', 1893456000), null);
    assert.ok(log.limitCleared('codex'));
    assert.equal(log.limitCleared('codex'), null);

    const recs = readRecords(path.join(dir, 'metrics', 'usage.jsonl'));
    assert.deepEqual(recs.map((r) => r.kind), ['window', 'window', 'window', 'tokens', 'tokens', 'limit', 'limit']);
    assert.equal(recs[0].resetsAt, Date.UTC(2026, 8, 25, 15) / 1000);
    assert.deepEqual(recs[3], { t, agent: 'codex', kind: 'tokens', input: 200, output: 50, cached: 800, source: 'task', ref: 7 });
    assert.deepEqual([recs[4].input, recs[4].cached, recs[4].output], [15, 90, 3]);
    assert.deepEqual(recs.slice(5).map((r) => [r.status, r.resetsAt]), [['hit', 1893456000], ['cleared', 1893456000]]);

    // A fresh instance picks the dedupe state up from the file.
    const again = createUsageLog(dir, { now: () => t });
    assert.equal(again.window('claude', 'five_hour', 41, '2026-09-25T15:00:00Z'), null);
    assert.equal(again.limitCleared('codex'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('antigravity limits are kept per model group in the log and in history status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-usage-g-'));
  let t = Date.UTC(2026, 8, 25, 12);
  const log = createUsageLog(dir, { now: () => t });
  try {
    const at = t / 1000 + 3600;
    assert.ok(log.limitHit('antigravity', at, 'gemini-5h', 'gemini'));
    assert.ok(log.limitHit('antigravity', at + 60, '3p-weekly', '3p'));
    assert.equal(log.limitHit('antigravity', at, 'gemini-5h', 'gemini'), null); // same hit, same reset
    assert.equal(log.lastLimit('antigravity', 'gemini').window, 'gemini-5h');
    assert.ok(log.limitCleared('antigravity', '3p'));
    assert.equal(log.lastLimit('antigravity', 'gemini').status, 'hit'); // clearing third-party leaves Gemini hit
    for (const [w, pct] of [['gemini-5h', 100], ['gemini-weekly', 20], ['3p-5h', 40], ['3p-weekly', 60]]) log.window('antigravity', w, pct, at);
    const s = log.history('24h').agents.antigravity.status;
    assert.deepEqual(Object.keys(s.windows).sort(), ['3p-5h', '3p-weekly', 'gemini-5h', 'gemini-weekly']);
    assert.equal(s.blocked, true);
    assert.deepEqual(s.groups, { gemini: at });
    t += 2 * 3600e3; // past the reset
    assert.equal(log.history('24h').agents.antigravity.status.blocked, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('compact drops records older than 30 days', () => {
  const dir = tmp();
  const t = Date.UTC(2026, 8, 25);
  try {
    fs.mkdirSync(path.join(dir, 'metrics'));
    const lines = [{ t: t - KEEP_MS - 1, agent: 'claude', kind: 'tokens', input: 1 }, { t: t - D, agent: 'claude', kind: 'tokens', input: 2 }];
    fs.writeFileSync(path.join(dir, 'metrics', 'usage.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
    const log = createUsageLog(dir, { now: () => t });
    assert.equal(log.compact(), 2);
    assert.deepEqual(readRecords(log.file).map((r) => r.input), [2]);
    assert.equal(log.compact(), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('normUsage maps every adapter to uncached input, output and cached', () => {
  // agy's cache reads are not part of input_tokens: recorded live (#149) with 19071 input and 56618 cached.
  assert.deepEqual(normUsage('antigravity', { input_tokens: 19071, output_tokens: 1635, cache_read_tokens: 56618, total_tokens: 20706 }), { input: 19071, output: 1635, cached: 56618 });
  assert.deepEqual(normUsage('antigravity', { input_tokens: 10418, output_tokens: 589, cache_read_tokens: 8113 }), { input: 10418, output: 589, cached: 8113 });
  assert.deepEqual(normUsage('codex', null), { input: 0, output: 0, cached: 0 });
});

test('tokens bucket per hour/day and window series downsample to 300 points', () => {
  const at = Date.UTC(2026, 8, 25, 12, 30);
  const recs = [
    { t: at - 10 * 60e3, agent: 'claude', kind: 'tokens', input: 5, output: 1, cached: 2 },
    { t: at - 20 * 60e3, agent: 'claude', kind: 'tokens', input: 5, output: 1, cached: 2 },
    { t: at - 3 * H, agent: 'claude', kind: 'tokens', input: 7, output: 0, cached: 0 },
    { t: at - 2 * D, agent: 'claude', kind: 'tokens', input: 100, output: 0, cached: 0 }, // outside 24h
  ];
  const hours = bucketTokens(recs, at - D, at, H);
  assert.equal(hours.length, 25);
  assert.equal(hours.at(-1).t, Date.UTC(2026, 8, 25, 12));
  assert.deepEqual(hours.at(-1), { t: Date.UTC(2026, 8, 25, 12), input: 10, output: 2, cached: 4, turns: 2 });
  assert.equal(hours.at(-4).input, 7);
  assert.equal(hours.reduce((s, b) => s + b.input, 0), 17);
  const days = bucketTokens(recs, at - 7 * D, at, D);
  assert.equal(days.length, 8);
  assert.equal(days.at(-1).input, 17);
  assert.equal(days.at(-3).input, 100);

  const pts = Array.from({ length: 1000 }, (_, i) => ({ t: i, pct: i }));
  const ds = downsample(pts);
  assert.equal(ds.length, MAX_POINTS);
  assert.deepEqual([ds[0].t, ds.at(-1).t], [0, 999]);
  assert.equal(downsample(pts.slice(0, 5)).length, 5);
});

test('6h range buckets tokens per 15 minutes', () => {
  const at = Date.UTC(2026, 8, 25, 12, 40);
  const recs = [
    { t: at - 5 * 60e3, agent: 'claude', kind: 'tokens', input: 3, output: 1, cached: 0 }, // 12:35
    { t: at - 12 * 60e3, agent: 'claude', kind: 'tokens', input: 4, output: 0, cached: 0 }, // 12:28
    { t: at - 5 * H, agent: 'claude', kind: 'tokens', input: 9, output: 0, cached: 0 }, // 07:40
    { t: at - 7 * H, agent: 'claude', kind: 'tokens', input: 100, output: 0, cached: 0 }, // outside 6h
  ];
  const h = usageHistory(recs, '6h', at);
  assert.deepEqual([h.range, h.bucketMs, h.from], ['6h', 15 * 60e3, at - 6 * H]);
  const b = h.agents.claude.tokens;
  assert.equal(b.length, 25);
  assert.ok(b.every((x, i) => i === 0 || x.t - b[i - 1].t === 15 * 60e3));
  assert.deepEqual(b.at(-1), { t: Date.UTC(2026, 8, 25, 12, 30), input: 3, output: 1, cached: 0, turns: 1 });
  assert.equal(b.at(-2).input, 4);
  assert.equal(b.find((x) => x.t === Date.UTC(2026, 8, 25, 7, 30)).input, 9);
  assert.equal(b.reduce((s, x) => s + x.input, 0), 16);
});

test('usageHistory groups by agent with limit events and current status', () => {
  const at = Date.UTC(2026, 8, 25, 12);
  const s = at / 1000;
  const recs = [
    { t: at - 3 * D, agent: 'claude', kind: 'window', window: 'seven_day', pct: 20, resetsAt: s + D / 1000 }, // before the range: status only
    ...Array.from({ length: 500 }, (_, i) => ({ t: at - D + 1 + i * 60e3, agent: 'claude', kind: 'window', window: 'five_hour', pct: i % 100, resetsAt: s + 3600 })),
    { t: at - H, agent: 'codex', kind: 'limit', status: 'hit', resetsAt: s + 3600 },
    { t: at - 2 * H, agent: 'antigravity', kind: 'limit', status: 'hit', resetsAt: s - 60 }, // reset has passed
  ];
  const h = usageHistory(recs, '24h', at);
  assert.deepEqual([h.range, h.bucketMs, h.to], ['24h', H, at]);
  assert.deepEqual(Object.keys(h.agents).sort(), ['antigravity', 'claude', 'codex']);
  const c = h.agents.claude;
  assert.equal(c.windows.five_hour.length, MAX_POINTS);
  assert.equal(c.windows.seven_day, undefined);
  assert.equal(c.status.windows.seven_day.pct, 20);
  assert.equal(c.status.windows.five_hour.pct, 499 % 100);
  assert.equal(c.status.blocked, false);
  assert.equal(c.tokens.length, 25);
  assert.deepEqual(h.agents.codex.limits, [{ t: at - H, status: 'hit', resetsAt: s + 3600 }]);
  assert.deepEqual([h.agents.codex.status.blocked, h.agents.codex.status.resetsAt], [true, s + 3600]);
  assert.equal(h.agents.antigravity.status.blocked, false);
  assert.equal(usageHistory([], 'bogus', at).range, '24h');
  assert.equal(usageHistory([], '30d', at).bucketMs, D);
});

test('a polled window reading keeps its snapshot time and reads as stale once older than its window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-at-'));
  let t = Date.UTC(2026, 8, 26, 0, 0);
  const log = createUsageLog(dir, { now: () => t });
  const s = t / 1000;
  log.window('codex', '5h', 37, s + 3600, t - 10 * 60e3);
  log.window('codex', 'weekly', 22, s + 5 * 86400, t - 6 * 3600e3); // a 6 h old weekly reading is still current
  let w = log.history('6h').agents.codex.status.windows;
  assert.deepEqual(w['5h'], { pct: 37, resetsAt: s + 3600, t: t - 10 * 60e3, stale: false });
  assert.equal(w.weekly.stale, false);
  t += 2 * 3600e3; // the 5h window has reset since that reading
  w = log.history('6h').agents.codex.status.windows;
  assert.equal(w['5h'].stale, true);
  assert.equal(w.weekly.stale, false);
  assert.equal(usageHistory([{ t, agent: 'codex', kind: 'window', window: '5h', pct: 5, resetsAt: null, at: t - 6 * 3600e3 }], '6h', t).agents.codex.status.windows['5h'].stale, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
