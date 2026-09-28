// bin/agent-health.mjs against stub CLIs (a temp HOME and a PATH holding only the stubs), plus the health row rules
// and the limit store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeWindows } from '../agents.mjs';
import { healthRow } from '../health.mjs';
import { createLimitStore } from '../usage.mjs';

const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
const bin = fileURLToPath(new URL('../bin/agent-health.mjs', import.meta.url));
const TID = '01a0d8c5-4305-7c13-9e50-923d5da54713';

// codex on PATH; claude is absent (not installed).
function setup({ rollout = 'ok' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-health-')), stubs = path.join(home, 'stubs');
  fs.mkdirSync(stubs); fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.symlinkSync(fixture('codex-stub.mjs'), path.join(stubs, 'codex'));
  fs.symlinkSync(process.execPath, path.join(stubs, 'node'));
  fs.symlinkSync(spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim(), path.join(stubs, 'bash'));
  // The newest codex rollout snapshot (recorded shape, stamped now); 'noreset' drops the reset times.
  let text = fs.readFileSync(fixture('codex-rollout.jsonl'), 'utf8').replace('__NOW__', new Date().toISOString());
  if (rollout === 'noreset') text = text.replace(/,"resets_at":\d+/g, '');
  const day = path.join(home, '.codex/sessions/2026/09/26');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-09-26T10-00-00-${TID}.jsonl`), text);
  return { home, env: { HOME: home, PATH: stubs } };
}
const run = (env, ...args) => {
  const r = spawnSync(process.execPath, [bin, '--data', path.join(env.HOME, 'data'), ...args], { env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr, json: args.includes('--json') ? JSON.parse(r.stdout) : null };
};

test('agent-health: every signed-in stub agent has models and limits or "not exposed by CLI" → exit 0', () => {
  const { env } = setup();
  const r = run(env, '--json');
  assert.equal(r.code, 0, r.err || r.out);
  const by = Object.fromEntries(r.json.agents.map((a) => [a.id, a]));
  assert.deepEqual(Object.keys(by), ['claude', 'codex']);
  assert.equal(by.claude.installed, false);
  const codex = by.codex;
  assert.equal(codex.version, '0.157.0');
  assert.equal(codex.signedIn, true);
  assert.equal(codex.models.count, 3);
  assert.equal(codex.limits.source, 'codex rollout rate_limits');
  assert.ok(codex.limits.windows.length >= 2 && codex.limits.windows.every((w) => w.resetsAt > 0), JSON.stringify(codex.limits));
  assert.ok(codex.models.at && codex.limits.at);
  assert.equal(r.json.ok, true);

  const t = run(env);
  assert.equal(t.code, 0);
  assert.match(t.out, /^agent\s+installed\s+signed in\s+models\s+limits \(source\)\s+last fetch\s+errors/);
  assert.match(t.out, /codex\s+yes 0\.157\.0\s+yes/);
  assert.match(t.out, /5h \d+% resets \d{4}-\d\d-\d\d \d\d:\d\dZ/);
  assert.match(t.out, /claude\s+no\s/);
  assert.match(t.out, /\nOK: /);
});

test('agent-health: an installed, signed-in agent with 0 models fails', () => {
  const { env } = setup();
  const r = run({ ...env, CODEX_STUB_MODELS: 'fail' }, '--json', '--agent', 'codex');
  assert.equal(r.code, 1);
  const codex = r.json.agents.find((a) => a.id === 'codex');
  assert.equal(codex.ok, false);
  assert.match(codex.problems[0], /^no models \(Error: failed to refresh the model catalog: 503/);
  assert.match(run({ ...env, CODEX_STUB_MODELS: 'fail' }, '--agent', 'codex').out, /FAIL: codex \(no models/);
});

test('agent-health: windows without a reset fail when the source reports resets', () => {
  const { env } = setup({ rollout: 'noreset' });
  const r = run(env, '--json', '--agent', 'codex');
  assert.equal(r.code, 1);
  assert.deepEqual(r.json.agents[0].problems, ['no reset time for 5h, weekly']);
});

test('agent-health: signed-out agents are listed but never fail the check', () => {
  const { env } = setup();
  const r = run({ ...env, CODEX_STUB_LOGIN: 'out' }, '--json', '--agent', 'codex');
  assert.equal(r.code, 0, r.out);
  for (const a of r.json.agents) assert.deepEqual([a.installed, a.signedIn, a.ok], [true, false, true]);
});

test('agent-health --cached reads the server caches and shows their fetch times', () => {
  const { env, home } = setup();
  fs.mkdirSync(path.join(home, 'data'));
  fs.writeFileSync(path.join(home, 'data/models.json'), JSON.stringify({ agents: { codex: { models: [{ id: 'gpt-x', label: 'X' }], error: null, at: 1790000000000 } } }));
  fs.writeFileSync(path.join(home, 'data/limits.json'), JSON.stringify({ agents: { codex: { source: 'codex rollout rate_limits', exposed: true,
    windows: [{ window: '5h', pct: 10, resetsAt: 1790010000 }], error: null, at: 1790000100000 } } }));
  const r = run(env, '--json', '--cached', '--agent', 'codex');
  assert.equal(r.code, 0);
  assert.deepEqual([r.json.agents[0].models.ids, r.json.agents[0].models.at, r.json.agents[0].limits.at], [['gpt-x'], 1790000000000, 1790000100000]);
});

test('healthRow: one model is healthy; a failed limit check is shown but does not fail', () => {
  const models = { models: [{ id: 'gpt-x', label: 'X' }], error: null, at: 1 };
  const row = healthRow('codex', { installed: true, signedIn: true, account: 'me', models, limits: { source: 'x', exposed: true, windows: [], error: 'timed out', at: null } });
  assert.deepEqual([row.ok, row.models.count, row.errors], [true, 1, ['limits: timed out']]);
  const none = healthRow('codex', { installed: true, signedIn: true, models: { models: [], error: 'not signed in' }, limits: null });
  assert.deepEqual(none.problems, ['no models (not signed in)']);
});

test('healthRow: a list kept after a failed rediscovery is stale (an error with both dates), not a problem', () => {
  const at = Date.UTC(2026, 8, 25, 8), failedAt = Date.UTC(2026, 8, 27, 9, 30), state = { installed: true, signedIn: true, limits: null };
  const stale = healthRow('codex', { ...state, models: { models: [{ id: 'gpt-x', label: 'X' }], error: 'timed out', at, failedAt } });
  assert.deepEqual([stale.ok, stale.problems, stale.models.count, stale.models.stale, stale.models.failedAt], [true, [], 1, true, failedAt]);
  const lines = stale.errors.filter((e) => e.startsWith('models:'));
  assert.deepEqual(lines, ['models: rediscovery failed 2026-09-27T09:30:00.000Z (timed out); showing the list from 2026-09-25T08:00:00.000Z']);
  const fresh = healthRow('codex', { ...state, models: { models: [{ id: 'gpt-x', label: 'X' }], error: null, at } });
  assert.deepEqual([fresh.ok, fresh.models.stale, fresh.models.failedAt, fresh.errors.filter((e) => e.startsWith('models:'))], [true, undefined, undefined, []]);
  const empty = healthRow('codex', { ...state, models: { models: [], error: 'timed out', at: null, failedAt } });
  assert.deepEqual([empty.ok, empty.problems, empty.models.stale], [false, ['no models (timed out)'], undefined]);
});

test('agent-health --cached prints a stale model list as an error and exits 0', () => {
  const { env, home } = setup();
  fs.mkdirSync(path.join(home, 'data'));
  fs.writeFileSync(path.join(home, 'data/models.json'), JSON.stringify({ agents: { codex: { models: [{ id: 'gpt-x', label: 'X' }], error: 'timed out',
    at: Date.UTC(2026, 8, 25, 8), failedAt: Date.UTC(2026, 8, 27, 9, 30) } } }));
  const r = run(env, '--cached', '--agent', 'codex');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /models: rediscovery failed 2026-09-27T09:30:00\.000Z \(timed out\); showing the list from 2026-09-25T08:00:00\.000Z/);
});

test('claudeWindows: SDK rate_limits become window points with epoch resets', () => {
  assert.deepEqual(claudeWindows({ five_hour: { utilization: 40, resets_at: '2026-09-26T19:30:00Z' }, seven_day: { utilization: 86, resets_at: 1790607600 },
    seven_day_opus: null, model_scoped: [{ display_name: 'Fable', utilization: 5, resets_at: 1790607600 }] }), [
    { window: 'five_hour', pct: 40, resetsAt: 1790451000 }, { window: 'seven_day', pct: 86, resetsAt: 1790607600 }, { window: 'Fable', pct: 5, resetsAt: 1790607600 }]);
});

test('createLimitStore: saves checks, records readings, keeps the last good reading when a check fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-limits-')), file = path.join(dir, 'limits.json');
  const logged = [];
  let fail = false, t = 1000, calls = 0;
  const store = createLimitStore({ file, ids: ['codex', 'claude'], now: () => t,
    usageLog: { window: (...a) => logged.push(a) },
    fetch: async (id) => (calls++, id === 'claude' ? { source: null, exposed: false, windows: [], error: null, at: t }
      : fail ? { source: 's', exposed: true, windows: [], error: 'boom', at: null }
      : { source: 's', exposed: true, windows: [{ window: '5h', pct: 5, resetsAt: 99 }], error: null, at: 900 }) });
  await store.refresh();
  assert.deepEqual(store.get('codex'), { source: 's', exposed: true, windows: [{ window: '5h', pct: 5, resetsAt: 99 }], error: null, at: 900, checkedAt: 1000 });
  assert.deepEqual(logged, [['codex', '5h', 5, 99, 900]]);
  // Within a minute of the last check, a refresh answers from the cache (the check is deferred to the gap's end).
  fail = true; t = 30_000;
  await store.refresh(['codex']);
  assert.equal(calls, 2);
  assert.equal(store.get('codex').checkedAt, 1000);
  store.stop();
  t = 61_000;
  await store.refresh(['codex']);
  assert.equal(calls, 3);
  assert.deepEqual(store.get('codex'), { source: 's', exposed: true, windows: [{ window: '5h', pct: 5, resetsAt: 99 }], error: 'boom', at: 900, checkedAt: 61_000 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agents.claude.exposed, false);
  // A restart starts from the saved checks.
  const again = createLimitStore({ file, ids: ['codex'], fetch: async () => ({}) });
  assert.equal(again.get('codex').error, 'boom');
});
