// Artificial Analysis client: parsing recorded /language/models pages, CLI-model mapping, the 24 h cache,
// rate limits, key storage and the manual fallback. No real API calls: fetch is a stub serving fixture JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAAStore, fetchModels, matchModels, normName, parseModel, ATTRIBUTION } from '../aa.mjs';

const fixture = (f) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url)), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-aa-'));
const PAGES = { 1: fixture('aa-models-p1.json'), 2: fixture('aa-models-p2.json') };

// A fetch stub: serves the fixture pages, records calls, and can answer 429 or 401.
function stubFetch({ status = 200, remaining = 90, retryAfter = null } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, key: opts.headers['x-api-key'] });
    const page = Number(new URL(url).searchParams.get('page'));
    const hdr = { 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': '2000000000', ...(retryAfter ? { 'retry-after': String(retryAfter) } : {}) };
    return { status, ok: status === 200, headers: new Headers(hdr), json: async () => PAGES[page] };
  };
  fn.calls = calls;
  return fn;
}

// Model lists as the CLIs report them (see data/models.json shape).
const CATALOG = {
  claude: [{ id: 'opus', label: 'Opus 5.5', resolved: 'claude-opus-5-5' }, { id: 'haiku', label: 'Haiku 4.5', resolved: 'claude-haiku-4-5-20251001' },
    { id: 'claude-opus-4-6', label: 'Opus 4.6' }],
  codex: [{ id: 'gpt-6-sol', label: 'GPT-6-Sol' }, { id: 'gpt-5.5', label: 'GPT-5.5' }],
  antigravity: [{ id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' }, { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' }, { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }],
};

test('parseModel: indexes, every numeric benchmark, speed, TTFT, context window and pricing', () => {
  const m = parseModel(PAGES[1].data[0]);
  assert.equal(m.slug, 'gpt-oss-120b');
  assert.equal(m.creator, 'OpenAI');
  assert.equal(m.intelligence_index, 33.3);
  assert.equal(m.coding_index, 28.6);
  assert.equal(m.agentic_index, 30.1);
  assert.deepEqual(m.benchmarks, { terminalbench_hard: 0.18, terminalbench_v2_1: 0.3, scicode: 0.39, tau2_telecom: 0.66, gpqa_diamond: 0.78, hle: 0.18 });
  assert.equal(m.tokens_per_s, 296.47);
  assert.equal(m.ttft_s, 0.65);
  assert.equal(m.context_window, 131072);
  assert.deepEqual(m.pricing, { input: 0.15, output: 0.6, blended: 0.26 });
  // Missing fields are null, not guesses.
  const g = parseModel(PAGES[2].data[1]);
  assert.equal(g.agentic_index, null);
  assert.equal(g.ttft_s, null);
  assert.deepEqual(g.pricing, { input: null, output: null, blended: null });
});

test('fetchModels: sends x-api-key, follows pagination, reports rate-limit headers', async () => {
  const f = stubFetch();
  const r = await fetchModels('k-123', { fetch: f });
  assert.deepEqual(f.calls.map((c) => c.url), ['https://artificialanalysis.ai/api/v2/language/models?page=1', 'https://artificialanalysis.ai/api/v2/language/models?page=2']);
  assert.ok(f.calls.every((c) => c.key === 'k-123'));
  assert.equal(r.models.length, 7);
  assert.equal(r.tier, 'free');
  assert.equal(r.limit.remaining, 90);
  await assert.rejects(fetchModels('k', { fetch: stubFetch({ status: 429, retryAfter: 120 }) }), (e) => e.status === 429 && e.retryAfter === 120);
  await assert.rejects(fetchModels('k', { fetch: stubFetch({ status: 401 }) }), /rejected the API key/);
});

test('normName: word order, dots, dates, effort and marketing suffixes', () => {
  assert.equal(normName('claude-4-5-haiku-reasoning').key, normName('claude-haiku-4-5-20251001').key);
  assert.equal(normName('gpt-5.5').key, normName('gpt-5-5').key);
  assert.equal(normName('Gemini 3.1 Pro (High)').key, normName('gemini-3-1-pro-preview').key);
  assert.equal(normName('Gemini 3.1 Pro (High)').effort, 'high');
  assert.ok(normName('Claude Opus 4.6 (Non-reasoning)').nonReasoning);
  assert.notEqual(normName('gpt-6-sol').key, normName('gpt-6').key);
});

test('matchModels: CLI models map to AA entries; unmatched ones are reported; overrides win', async () => {
  const { models } = await fetchModels('k', { fetch: stubFetch() });
  const { matches, unmatched } = matchModels(CATALOG, models);
  const slug = (a, id) => matches[a][id]?.slug ?? null;
  assert.equal(slug('claude', 'haiku'), 'claude-4-5-haiku-reasoning', 'via the resolved id');
  assert.equal(slug('claude', 'claude-opus-4-6'), 'claude-opus-4-6-adaptive', 'reasoning variant preferred');
  assert.equal(slug('antigravity', 'claude-opus-4-6-thinking'), 'claude-opus-4-6-adaptive');
  assert.equal(slug('codex', 'gpt-5.5'), 'gpt-5-5');
  assert.equal(slug('antigravity', 'gemini-3.1-pro-low'), 'gemini-3-1-pro-preview-low', 'same effort level preferred');
  assert.equal(slug('antigravity', 'gemini-3.1-pro-high'), 'gemini-3-1-pro-preview', 'else the best index');
  assert.equal(slug('antigravity', 'gpt-oss-120b-medium'), 'gpt-oss-120b');
  assert.deepEqual(unmatched.map((u) => `${u.agent}:${u.model}`), ['claude:opus', 'codex:gpt-6-sol']);

  const o = matchModels(CATALOG, models, { 'codex:gpt-6-sol': 'gpt-5-5', opus: null, 'gpt-5.5': 'no-such-slug' });
  assert.equal(o.matches.codex['gpt-6-sol'].slug, 'gpt-5-5');
  assert.equal(o.matches.claude.opus, null);
  assert.equal(o.matches.codex['gpt-5.5'], null, 'an override naming an unknown slug matches nothing');
  assert.deepEqual(o.unmatched.map((u) => `${u.agent}:${u.model}`), ['codex:gpt-5.5'], 'null overrides are deliberate, not unmatched');
});

test('store: key in secrets.json (0600), cached 24 h, merged view with source and fetched_at', async () => {
  const dataDir = tmp(), metaDir = tmp();
  fs.writeFileSync(path.join(metaDir, 'model-map.json'), JSON.stringify({ 'codex:gpt-6-sol': 'gpt-5-5' }));
  let t = 1_000_000;
  const f = stubFetch();
  const s = createAAStore({ dataDir, metaDir, catalog: () => CATALOG, env: {}, fetch: f, now: () => t });
  assert.equal(await s.start(), false, 'no key: no request');
  s.stop();
  assert.equal(f.calls.length, 0);
  assert.equal(s.view().source, 'manual');

  const st = await s.setKey(' secret-key ');
  assert.deepEqual({ ...st, attribution: undefined }, { configured: true, from: 'file', fetched_at: t, count: 7, error: null, attribution: undefined });
  assert.ok(!JSON.stringify(st).includes('secret-key'), 'status never carries the key');
  const sec = path.join(dataDir, 'secrets.json');
  assert.equal(fs.statSync(sec).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(sec, 'utf8')).aa_api_key, 'secret-key');
  assert.equal(f.calls.length, 2);
  assert.ok(fs.existsSync(path.join(dataDir, 'aa-models.json')));

  const v = s.view();
  assert.equal(v.source, 'artificialanalysis');
  assert.deepEqual(v.attribution, ATTRIBUTION);
  const e = v.entries.find((x) => x.agent === 'codex' && x.model === 'gpt-5.5');
  assert.deepEqual({ source: e.source, fetched_at: e.fetched_at, aa: e.aa }, { source: 'artificialanalysis', fetched_at: t, aa: { slug: 'gpt-5-5', name: 'GPT-5.5 (xhigh)' } });
  assert.equal(e.metrics.coding_index, 59);
  assert.equal(e.metrics.benchmarks.terminalbench_hard, 0.6);
  assert.equal(e.metrics.benchmarks.scicode, 0.56);
  assert.equal(v.entries.find((x) => x.model === 'gpt-6-sol').aa.slug, 'gpt-5-5', 'model-map.json override applied');
  assert.deepEqual(v.unmatched.map((u) => u.model), ['opus']);
  assert.ok(v.entries.every((x) => x.source && 'fetched_at' in x));

  // Within 24 h: no refetch, also for a fresh store reading the cache file.
  t += 23 * 3600e3;
  assert.equal(await s.refresh(), false);
  const s2 = createAAStore({ dataDir, metaDir, catalog: () => CATALOG, env: {}, fetch: f, now: () => t });
  assert.equal(s2.view().source, 'artificialanalysis');
  assert.equal(await s2.refresh(), false);
  assert.equal(f.calls.length, 2);
  t += 2 * 3600e3;
  assert.equal(await s2.refresh(), true);
  assert.equal(f.calls.length, 4);

  // Removing the key drops back to the manual table.
  assert.equal(s2.removeKey().configured, false);
  assert.equal(s2.view().source, 'manual');
});

test('store: a 429 waits for Retry-After; a nearly spent window waits for its reset', async () => {
  const dataDir = tmp(), metaDir = tmp();
  let t = 5_000_000;
  const limited = stubFetch({ status: 429, retryAfter: 600 });
  const s = createAAStore({ dataDir, metaDir, catalog: () => CATALOG, env: { AA_API_KEY: 'env-key' }, fetch: limited, now: () => t });
  assert.equal(s.status().from, 'env');
  assert.equal(await s.refresh(), false);
  assert.match(s.status().error, /rate limit/);
  assert.equal(await s.refresh({ force: true }), false);
  assert.equal(limited.calls.length, 1, 'no retry inside Retry-After');
  assert.equal(limited.calls[0].key, 'env-key');

  const low = stubFetch({ remaining: 1 });
  const s2 = createAAStore({ dataDir: tmp(), metaDir, catalog: () => CATALOG, env: { AA_API_KEY: 'k' }, fetch: low, now: () => t, ttl: 1 });
  assert.equal(await s2.refresh(), true);
  t += 10;
  assert.equal(await s2.refresh(), false, 'stale, but the window is spent until its reset');
  assert.equal(low.calls.length, 2);
});

test('store without a key: .agent-orch/model-metrics.json, labelled manual everywhere', () => {
  const dataDir = tmp(), metaDir = tmp();
  fs.writeFileSync(path.join(metaDir, 'model-metrics.json'), JSON.stringify({ updated: '2026-09-25', models: {
    'codex:gpt-5.5': { coding_index: 59, benchmarks: { scicode: 0.56, bogus: 'x' }, tokens_per_s: 90 }, 'claude-opus-4-6': { agentic_index: 67 } } }));
  const s = createAAStore({ dataDir, metaDir, catalog: () => CATALOG, env: {}, fetch: stubFetch() });
  const v = s.view();
  assert.equal(v.source, 'manual');
  assert.equal(v.fetched_at, Date.parse('2026-09-25'));
  assert.ok(v.entries.every((e) => e.source === 'manual' && !e.aa));
  const e = v.entries.find((x) => x.model === 'gpt-5.5');
  assert.equal(e.metrics.coding_index, 59);
  assert.deepEqual(e.metrics.benchmarks, { scicode: 0.56 });
  assert.equal(v.entries.find((x) => x.model === 'claude-opus-4-6').metrics.agentic_index, 67);
  assert.equal(v.entries.find((x) => x.model === 'opus').metrics, null);
  assert.ok(v.unmatched.some((u) => u.model === 'opus'));
  assert.equal(s.status().configured, false);
});
