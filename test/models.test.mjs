// Model discovery: each CLI's real list (stub binaries / a fake SDK query), the <DATA>/models.json cache and refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, claudeModels, clearLoginCache, codexModels, discoverModels, modelCatalog, setModelCatalog } from '../agents.mjs';
import { createModelStore, MODELS_TTL } from '../models.mjs';

const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-models-'));

// supportedModels() rows as the SDK returns them (recorded 2026-09-25, trimmed).
const SDK_ROWS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Most capable for ambitious work' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Most efficient for everyday tasks' },
  { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'For your toughest challenges' },
];

test('claude: supportedModels() rows become models; the default row marks its alias', async () => {
  let seen = null, aborted = false;
  const query = (args) => {
    seen = args;
    args.options.abortController.signal.addEventListener('abort', () => { aborted = true; });
    return { supportedModels: async () => SDK_ROWS };
  };
  const models = await AGENTS.claude.listModels({ query, bin: '/x/claude', env: { PATH: '/bin', ANTHROPIC_API_KEY: 'k' } });
  assert.deepEqual(models, [
    { id: 'opus', label: 'Opus 5.5', description: 'Most capable for ambitious work', resolved: 'claude-opus-5-5', default: true },
    { id: 'sonnet', label: 'Sonnet 5', description: 'Most efficient for everyday tasks', resolved: 'claude-sonnet-5' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1', description: 'For your toughest challenges' },
  ]);
  assert.equal(seen.options.pathToClaudeCodeExecutable, '/x/claude');
  assert.equal(seen.options.env.ANTHROPIC_API_KEY, undefined, 'API key stripped');
  assert.ok(aborted, 'the probe query is closed');
  assert.deepEqual(claudeModels(null), []);
});

test('claude: a supportedModels() that never answers times out', async () => {
  const query = () => ({ supportedModels: () => new Promise(() => {}) });
  await assert.rejects(AGENTS.claude.listModels({ query, timeoutMs: 50 }), /took over/);
});

test('codex: `codex debug models` (stub) → listed models in priority order, hidden ones skipped', async () => {
  const models = await AGENTS.codex.listModels({ bin: fixture('codex-stub.mjs') });
  assert.deepEqual(models.map((m) => m.id), ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.5']);
  // efforts: the model's supported_reasoning_levels (gpt-5.5 stops at xhigh in codex-cli 0.157).
  assert.deepEqual(models[1], { id: 'gpt-6-sol', label: 'GPT-6-Sol', description: 'Workhorse model for coding and everyday work.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] });
  assert.deepEqual(models[2].efforts, ['low', 'medium', 'high', 'xhigh']);
  await assert.rejects(AGENTS.codex.listModels({ bin: fixture('codex-stub.mjs'), env: { ...process.env, CODEX_STUB_MODELS: 'fail' } }), /503 Service Unavailable/);
  assert.deepEqual(codexModels({}), []);
});

test('discoverModels: signed out or failing → empty list with the reason', async (t) => {
  const bin = tmp(), path0 = process.env.PATH;
  fs.symlinkSync(fixture('codex-stub.mjs'), path.join(bin, 'codex'));
  process.env.PATH = `${bin}:${path0}`;
  t.after(() => {
    process.env.PATH = path0;
    for (const k of ['CODEX_STUB_LOGIN', 'CODEX_STUB_MODELS']) delete process.env[k];
    clearLoginCache();
    fs.rmSync(bin, { recursive: true, force: true });
  });
  clearLoginCache();
  const ok = await discoverModels('codex');
  assert.equal(ok.error, null);
  assert.equal(ok.models[0].id, 'gpt-6-astra');
  process.env.CODEX_STUB_MODELS = 'fail';
  const failed = await discoverModels('codex');
  assert.deepEqual(failed.models, []);
  assert.match(failed.error, /503/);
  process.env.CODEX_STUB_LOGIN = 'out';
  clearLoginCache();
  const out = await discoverModels('codex');
  assert.deepEqual([out.models, out.error], [[], 'not signed in']);
  assert.equal((await discoverModels('nope')).error, 'unknown agent');
});

test('model store: caches to models.json with a timestamp, reloads it, and refreshes on a timer and on demand', async (t) => {
  const dir = tmp(), file = path.join(dir, 'models.json');
  t.after(() => { for (const id of ['codex', 'claude']) setModelCatalog(id, { models: [], error: 'loading', at: null }); fs.rmSync(dir, { recursive: true, force: true }); });
  let n = 0;
  const lists = { codex: [{ id: 'gpt-6-sol', label: 'GPT-6-Sol' }], claude: [] };
  const discover = async (id) => { n++; return lists[id].length ? { models: lists[id], error: null, at: 1000 + n } : { models: [], error: 'not signed in', at: 1000 + n }; };
  const changes = [];
  const store = createModelStore({ file, ids: ['codex', 'claude'], discover, intervalMs: 40, minGapMs: 0, onChange: (ids) => changes.push(ids) });
  assert.equal(modelCatalog('codex').error, 'loading');
  await store.start();
  t.after(() => store.stop());
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.saved > 0);
  assert.deepEqual(saved.agents.codex.models, lists.codex);
  assert.ok(saved.agents.codex.at);
  assert.deepEqual(saved.agents.claude, { models: [], error: 'not signed in', at: saved.agents.claude.at });
  assert.deepEqual(changes.slice(0, 2), [['codex'], ['claude']]); // one agent at a time
  // A sign-in refreshes just that agent.
  lists.claude = [{ id: 'opus', label: 'Opus' }];
  await store.refresh(['claude']);
  assert.deepEqual(modelCatalog('claude').models.map((m) => m.id), ['opus']);
  assert.deepEqual(changes.at(-1), ['claude']);
  // The periodic refresh keeps running.
  const before = n;
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(n > before + 1, 'refreshed on the interval');
  store.stop();
  // A new process starts from the cached lists before discovering again.
  setModelCatalog('codex', { models: [], error: 'loading', at: null });
  assert.ok(createModelStore({ file, ids: ['codex'], discover }).load());
  assert.deepEqual(modelCatalog('codex').models, lists.codex);
});

test('model store: at most one discovery per agent per minimum gap; an early request runs at the gap\'s end', async (t) => {
  const dir = tmp(), file = path.join(dir, 'models.json');
  t.after(() => { setModelCatalog('codex', { models: [], error: 'loading', at: null }); fs.rmSync(dir, { recursive: true, force: true }); });
  let n = 0;
  const discover = async () => { n++; return { models: [{ id: `m${n}`, label: 'M' }], error: null, at: Date.now() }; };
  const store = createModelStore({ file, ids: ['codex'], discover, minGapMs: 300 });
  t.after(() => store.stop());
  await Promise.all([store.start(), store.refresh(), store.refresh(['codex'])]);
  assert.equal(n, 1, 'boot + concurrent requests share one discovery');
  await store.refresh(['codex']);
  await store.refresh(['codex']);
  assert.equal(n, 1, 'too soon: served from the cache');
  assert.deepEqual(modelCatalog('codex').models.map((m) => m.id), ['m1']);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(n, 2, 'the deferred request ran once, after the gap');
  // A restart within the gap of the cached lists doesn't rediscover at boot right away.
  store.stop();
  const again = createModelStore({ file, ids: ['codex'], discover, minGapMs: 60_000 });
  await again.start();
  again.stop();
  assert.equal(n, 2);
});

test('model store: a cached list younger than a day is not rediscovered at boot; an older one is', async (t) => {
  const dir = tmp(), file = path.join(dir, 'models.json');
  t.after(() => { for (const id of ['codex', 'claude']) setModelCatalog(id, { models: [], error: 'loading', at: null }); fs.rmSync(dir, { recursive: true, force: true }); });
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ agents: { codex: { models: [{ id: 'old', label: 'Old' }], error: null, at: now - 25 * 3600e3 },
    claude: { models: [{ id: 'opus', label: 'Opus' }], error: null, at: now - 3600e3 } } }));
  const asked = [];
  const store = createModelStore({ file, ids: ['codex', 'claude'], discover: async (id) => { asked.push(id); return { models: [{ id: 'new', label: 'New' }], error: null, at: Date.now() }; } });
  t.after(() => store.stop());
  assert.equal(MODELS_TTL, 24 * 3600e3);
  await store.start();
  assert.deepEqual(asked, ['codex']);
  assert.deepEqual(modelCatalog('claude').models.map((m) => m.id), ['opus']);
  await store.refreshStale();
  assert.deepEqual(asked, ['codex'], 'nothing is a day old now');
});
