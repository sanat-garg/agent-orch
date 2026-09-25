// Model discovery: each CLI's real list (stub binaries / a fake SDK query), the <DATA>/models.json cache and refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, agyModels, claudeModels, clearLoginCache, codexModels, discoverModels, modelCatalog, setModelCatalog } from '../agents.mjs';
import { createModelStore } from '../models.mjs';

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
  assert.deepEqual(models[1], { id: 'gpt-6-sol', label: 'GPT-6-Sol', description: 'Workhorse model for coding and everyday work.' });
  await assert.rejects(AGENTS.codex.listModels({ bin: fixture('codex-stub.mjs'), env: { ...process.env, CODEX_STUB_MODELS: 'fail' } }), /503 Service Unavailable/);
  assert.deepEqual(codexModels({}), []);
});

test('antigravity: `agy models` (stub) → id and display name per line', async () => {
  const models = await AGENTS.antigravity.listModels({ bin: fixture('agy-stub.mjs') });
  assert.deepEqual(models, [
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  ]);
  await assert.rejects(AGENTS.antigravity.listModels({ bin: fixture('agy-stub.mjs'), env: { ...process.env, AGY_STUB_LOGIN: 'out' } }), /Please sign in/);
  assert.deepEqual(agyModels('Fetching available models...\n\n'), []);
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
  t.after(() => { for (const id of ['codex', 'antigravity']) setModelCatalog(id, { models: [], error: 'loading', at: null }); fs.rmSync(dir, { recursive: true, force: true }); });
  let n = 0;
  const lists = { codex: [{ id: 'gpt-6-sol', label: 'GPT-6-Sol' }], antigravity: [] };
  const discover = async (id) => { n++; return lists[id].length ? { models: lists[id], error: null, at: 1000 + n } : { models: [], error: 'not signed in', at: 1000 + n }; };
  const changes = [];
  const store = createModelStore({ file, ids: ['codex', 'antigravity'], discover, intervalMs: 40, onChange: (ids) => changes.push(ids) });
  assert.equal(modelCatalog('codex').error, 'loading');
  await store.start();
  t.after(() => store.stop());
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.saved > 0);
  assert.deepEqual(saved.agents.codex.models, lists.codex);
  assert.ok(saved.agents.codex.at);
  assert.deepEqual(saved.agents.antigravity, { models: [], error: 'not signed in', at: saved.agents.antigravity.at });
  assert.deepEqual(changes[0], ['codex', 'antigravity']);
  // A sign-in refreshes just that agent.
  lists.antigravity = [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }];
  await store.refresh(['antigravity']);
  assert.deepEqual(modelCatalog('antigravity').models.map((m) => m.id), ['gemini-3.8-flash-high']);
  assert.deepEqual(changes.at(-1), ['antigravity']);
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
