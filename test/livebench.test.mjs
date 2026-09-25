// LiveBench results adapter: parsing recorded official files (livebench.ai table/categories for release 2026-06-25,
// GitHub listing of LiveBench/livebench.github.io public/), malformed responses, exact-only mapping, and the cache
// keeping last-known-good data. No real network: fetch is a stub serving fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveBenchStore, fetchResults, mapModels, parseCategories, parseReleases, parseTable, LB_SITE, LB_RELEASES_API } from '../livebench.mjs';

const raw = (f) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/livebench/${f}`, import.meta.url)), 'utf8');
const TABLE = raw('table_2026_06_25.csv'), CATS = raw('categories_2026_06_25.json'), RELEASES = raw('releases.json');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-lb-'));

// Serves the fixtures by URL; `over` replaces a body ({url: {status?, body}}) or throws for `fail: true`.
function stubFetch(over = {}) {
  const files = { [LB_RELEASES_API]: RELEASES, [`${LB_SITE}/table_2026_06_25.csv`]: TABLE, [`${LB_SITE}/categories_2026_06_25.json`]: CATS };
  const fn = async (url) => {
    fn.calls.push(url);
    const o = over[url];
    if (o?.fail) throw new Error('ECONNRESET');
    const status = o?.status ?? (url in files ? 200 : 404);
    const body = o && 'body' in o ? o.body : files[url] ?? 'Not found';
    return { status, ok: status === 200, text: async () => body };
  };
  fn.calls = [];
  return fn;
}

test('parseReleases: newest release that has both files', () => {
  const list = JSON.parse(RELEASES);
  assert.deepEqual(parseReleases(list), ['2026_06_25', '2026_01_08']);
  assert.deepEqual(parseReleases(list.filter((f) => f.name !== 'categories_2026_06_25.json')), ['2026_01_08']);
  assert.throws(() => parseReleases({ message: 'API rate limit exceeded' }), /Invalid LiveBench data/);
});

test('parseTable: task scores, category means and global average as the leaderboard computes them', () => {
  const cats = parseCategories(JSON.parse(CATS));
  assert.deepEqual(Object.keys(cats), ['Reasoning', 'Coding', 'Agentic Coding', 'Mathematics', 'Data Analysis', 'Language', 'IF']);
  const rows = parseTable(TABLE, cats);
  assert.equal(rows.length, 4);
  const o = rows.find((r) => r.model === 'claude-opus-5-5-max-effort');
  assert.equal(o.tasks.python, 70);
  assert.equal(o.categories.Coding, 89.253); // (86.957 + 91.549) / 2
  assert.equal(o.categories['Agentic Coding'], 71.717); // (81.818 + 63.333 + 70) / 3
  const cv = Object.values(o.categories);
  assert.ok(Math.abs(o.global_average - cv.reduce((a, b) => a + b) / cv.length) < 0.001);
  // An empty cell is "not run": left out of the mean, not counted as 0.
  const holed = TABLE.replace('gpt-6-sol-max,98.0,80.435,83.099', 'gpt-6-sol-max,98.0,,83.099');
  assert.equal(parseTable(holed, cats).find((r) => r.model === 'gpt-6-sol-max').categories.Coding, 83.099);
});

test('malformed responses are rejected whole', () => {
  const cats = parseCategories(JSON.parse(CATS));
  const cases = {
    html: '<!doctype html><html></html>',
    empty: '',
    header: TABLE.replace(/^model,/, 'name,'),
    missingColumn: TABLE.replace(',python,', ',pythonx,'),
    nonNumeric: TABLE.replace('gpt-6-sol-max,98.0', 'gpt-6-sol-max,N/A'),
    outOfRange: TABLE.replace('gpt-6-sol-max,98.0', 'gpt-6-sol-max,980'),
    shortRow: TABLE.replace(/,100\.0\n?$/, '\n'),
    duplicate: `${TABLE.trimEnd()}\n${TABLE.trimEnd().split('\n').at(-1)}\n`,
  };
  for (const [k, csv] of Object.entries(cases)) assert.throws(() => parseTable(csv, cats), /Invalid LiveBench data/, k);
  for (const c of [null, [], {}, { Coding: [] }, { Coding: 'code_generation' }, { A: ['x'], B: ['x'] }]) assert.throws(() => parseCategories(c), /Invalid LiveBench data/);
});

test('fetchResults: records source URLs, release, category scores and fetch time', async () => {
  const f = stubFetch();
  const r = await fetchResults({ fetch: f, now: () => 1000 });
  assert.equal(r.release, '2026-06-25');
  assert.equal(r.fetched_at, 1000);
  assert.deepEqual(r.source, { site: LB_SITE, repo: 'https://github.com/LiveBench/livebench.github.io', releases: LB_RELEASES_API,
    table: `${LB_SITE}/table_2026_06_25.csv`, categories: `${LB_SITE}/categories_2026_06_25.json` });
  assert.equal(r.models.length, 4);
  // Release discovery down: the known release is used; without one it fails.
  const down = stubFetch({ [LB_RELEASES_API]: { status: 403, body: '{}' } });
  assert.equal((await fetchResults({ fetch: down, release: '2026_06_25' })).release, '2026-06-25');
  await assert.rejects(fetchResults({ fetch: down }), /HTTP 403/);
});

test('mapModels: exact identities and explicit aliases only, never another effort or version', () => {
  const models = parseTable(TABLE, parseCategories(JSON.parse(CATS)));
  const catalog = {
    claude: [{ id: 'opus', label: 'Opus 5.5', resolved: 'claude-opus-5-5' }, { id: 'claude-opus-5', label: 'Opus 5' }],
    codex: [{ id: 'gpt-6-sol', label: 'GPT-6-Sol' }],
    antigravity: [{ id: 'gemini-3.8-flash-high' }, { id: 'gemini-3.8-flash-low' }],
  };
  const none = mapModels(catalog, models, {});
  assert.deepEqual(none.antigravity, { 'gemini-3.8-flash-high': { model: 'gemini-3.8-flash-high', via: 'exact' }, 'gemini-3.8-flash-low': null });
  assert.equal(none.claude.opus, null); // claude-opus-5-5 ≠ claude-opus-5-5-max-effort / -xhigh-effort
  assert.equal(none.claude['claude-opus-5'], null); // no prefix match onto 5.5
  assert.equal(none.codex['gpt-6-sol'], null);
  const al = mapModels(catalog, models, { 'claude:opus': 'claude-opus-5-5-xhigh-effort', 'gpt-6-sol': 'gpt-6-sol-xhigh', 'gemini-3.8-flash-high': null });
  assert.deepEqual(al.claude.opus, { model: 'claude-opus-5-5-xhigh-effort', via: 'alias' });
  assert.equal(al.codex['gpt-6-sol'], null); // alias to a name not in this release: no fallback to -max
  assert.equal(al.antigravity['gemini-3.8-flash-high'], null); // null alias overrides the exact match
});

test('store: caches valid results, retains last-known-good on failure, reports stale/unavailable', async () => {
  const dataDir = tmp(), metaDir = tmp();
  fs.writeFileSync(path.join(metaDir, 'livebench-map.json'), JSON.stringify({ 'claude:opus': 'claude-opus-5-5-xhigh-effort' }));
  const catalog = () => ({ claude: [{ id: 'opus', label: 'Opus 5.5', resolved: 'claude-opus-5-5' }], antigravity: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }, { id: 'gemini-3.1-pro-high' }] });
  let t = 1e12, fetch = stubFetch({ [LB_RELEASES_API]: { fail: true } });
  const mk = () => createLiveBenchStore({ dataDir, metaDir, catalog, fetch: (...a) => fetch(...a), now: () => t });

  // Never fetched, first attempt fails: unavailable, no scores.
  let s = mk();
  assert.equal(s.view().data_status, 'loading');
  assert.equal(await s.refresh(), false);
  let v = s.view();
  assert.equal(v.data_status, 'unavailable');
  assert.match(v.data_error, /ECONNRESET/);
  assert.ok(v.entries.every((e) => e.scores === null));
  assert.equal(await s.refresh(), false); // inside the 1 h retry wait: no request
  assert.equal(fetch.calls.length, 1);

  // Success after the wait: cached to disk and mapped.
  t += 3600e3; fetch = stubFetch();
  assert.equal(await s.refresh(), true);
  v = s.view();
  assert.equal(v.data_status, 'ready'); assert.equal(v.stale, false); assert.equal(v.data_error, null);
  assert.equal(v.release, '2026-06-25'); assert.equal(v.fetched_at, t);
  const opus = v.entries.find((e) => e.model === 'opus');
  assert.deepEqual(opus.livebench, { model: 'claude-opus-5-5-xhigh-effort', via: 'alias', release: '2026-06-25' });
  assert.equal(opus.scores.categories['Agentic Coding'], 65.353);
  assert.equal(v.entries.find((e) => e.model === 'gemini-3.8-flash-high').livebench.via, 'exact');
  assert.deepEqual(v.unmatched, [{ agent: 'antigravity', model: 'gemini-3.1-pro-high', label: 'gemini-3.1-pro-high' }]);
  assert.equal(await s.refresh(), false); // fresh: no refetch

  // A malformed refresh a day later keeps the last good data (also across a restart), marked stale with the error.
  const good = t;
  t += 24 * 3600e3; fetch = stubFetch({ [`${LB_SITE}/table_2026_06_25.csv`]: { body: TABLE.replace('gpt-6-sol-max,98.0', 'gpt-6-sol-max,oops') } });
  assert.equal(await s.refresh(), false);
  for (const st of [s, mk()]) {
    v = st.view();
    assert.equal(v.data_status, 'ready'); assert.equal(v.stale, true); assert.match(v.data_error, /Invalid LiveBench data/);
    assert.equal(v.fetched_at, good);
    assert.equal(v.entries.find((e) => e.model === 'opus').scores.categories['Agentic Coding'], 65.353);
  }
  // HTTP failure: same, and discovery failure falls back to the cached release.
  t += 3600e3; fetch = stubFetch({ [LB_RELEASES_API]: { status: 500, body: '' }, [`${LB_SITE}/categories_2026_06_25.json`]: { status: 503, body: '' } });
  assert.equal(await s.refresh(), false);
  assert.ok(fetch.calls.includes(`${LB_SITE}/categories_2026_06_25.json`));
  assert.match(s.view().data_error, /HTTP 503/);
  assert.equal(s.view().fetched_at, good);
  // Recovery clears the error.
  t += 3600e3; fetch = stubFetch();
  assert.equal(await s.refresh(), true);
  assert.equal(s.view().stale, false); assert.equal(s.view().data_error, null);
});
