// bin/agent-health.mjs against stub CLIs (a temp HOME and a PATH holding only the stubs), plus the health row rules,
// Copilot's quota windows and the limit store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeWindows, copilotWindows, COPILOT_AUTO_LABEL, copilotModels } from '../agents.mjs';
import { healthRow } from '../health.mjs';
import { createLimitStore } from '../usage.mjs';

const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
const bin = fileURLToPath(new URL('../bin/agent-health.mjs', import.meta.url));
const TID = '01a0d8c5-4305-7c13-9e50-923d5da54713';

// codex + opencode on PATH, kiro in ~/.local/bin; claude, agy and copilot are absent (not installed).
function setup({ rollout = 'ok' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-health-')), stubs = path.join(home, 'stubs');
  fs.mkdirSync(stubs); fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.symlinkSync(fixture('codex-stub.mjs'), path.join(stubs, 'codex'));
  fs.symlinkSync(fixture('opencode-stub.mjs'), path.join(stubs, 'opencode'));
  fs.symlinkSync(fixture('kiro-stub.mjs'), path.join(home, '.local/bin/kiro-cli'));
  fs.symlinkSync(process.execPath, path.join(stubs, 'node'));
  fs.symlinkSync(spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim(), path.join(stubs, 'bash'));
  // The newest codex rollout snapshot (recorded shape, stamped now); 'noreset' drops the reset times.
  let text = fs.readFileSync(fixture('codex-rollout.jsonl'), 'utf8').replace('__NOW__', new Date().toISOString());
  if (rollout === 'noreset') text = text.replace(/,"resets_at":\d+/g, '');
  const day = path.join(home, '.codex/sessions/2026/09/26');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-09-26T10-00-00-${TID}.jsonl`), text);
  return { home, env: { HOME: home, PATH: stubs, KIRO_STUB_WHOAMI: 'in' } };
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
  assert.deepEqual(Object.keys(by), ['claude', 'codex', 'antigravity', 'opencode', 'kiro', 'copilot']);
  for (const id of ['claude', 'antigravity', 'copilot']) assert.equal(by[id].installed, false, id);
  const codex = by.codex;
  assert.equal(codex.version, '0.157.0');
  assert.equal(codex.signedIn, true);
  assert.equal(codex.models.count, 3);
  assert.equal(codex.limits.source, 'codex rollout rate_limits');
  assert.ok(codex.limits.windows.length >= 2 && codex.limits.windows.every((w) => w.resetsAt > 0), JSON.stringify(codex.limits));
  assert.ok(codex.models.at && codex.limits.at);
  assert.deepEqual(by.opencode.models.ids, ['opencode/big-pickle', 'opencode/nemotron-3-ultra-free']);
  assert.equal(by.opencode.signedIn, true);
  assert.deepEqual([by.opencode.limits.exposed, by.opencode.limits.note], [false, 'not exposed by CLI']);
  assert.equal(by.kiro.account, 'dev@example.com');
  assert.deepEqual(by.kiro.models.ids, ['discovered-model']);
  assert.equal(by.kiro.limits.note, 'not exposed by CLI');
  assert.equal(r.json.ok, true);

  const t = run(env);
  assert.equal(t.code, 0);
  assert.match(t.out, /^agent\s+installed\s+signed in\s+models\s+limits \(source\)\s+last fetch\s+errors/);
  assert.match(t.out, /codex\s+yes 0\.157\.0\s+yes/);
  assert.match(t.out, /5h \d+% resets \d{4}-\d\d-\d\d \d\d:\d\dZ/);
  assert.match(t.out, /opencode .*not exposed by CLI/);
  assert.match(t.out, /claude\s+no\s/);
  assert.match(t.out, /\nOK: /);
});

test('agent-health: an installed, signed-in agent with 0 models fails', () => {
  const { env } = setup();
  const r = run({ ...env, CODEX_STUB_MODELS: 'fail' }, '--json', '--agent', 'codex,kiro');
  assert.equal(r.code, 1);
  const codex = r.json.agents.find((a) => a.id === 'codex');
  assert.equal(codex.ok, false);
  assert.match(codex.problems[0], /^no models \(Error: failed to refresh the model catalog: 503/);
  assert.equal(r.json.agents.find((a) => a.id === 'kiro').ok, true);
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
  const r = run({ ...env, KIRO_STUB_WHOAMI: 'out', CODEX_STUB_LOGIN: 'out' }, '--json', '--agent', 'codex,kiro');
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

test('healthRow: Copilot with only auto is healthy; a failed limit check is shown but does not fail', () => {
  const models = { models: copilotModels([{ id: 'auto', name: 'Auto' }]), error: null, at: 1 };
  assert.equal(models.models[0].label, COPILOT_AUTO_LABEL);
  const row = healthRow('copilot', { installed: true, signedIn: true, account: 'me', models, limits: { source: 'x', exposed: true, windows: [], error: 'timed out', at: null } });
  assert.deepEqual([row.ok, row.models.count, row.errors], [true, 1, ['limits: timed out']]);
  const none = healthRow('copilot', { installed: true, signedIn: true, models: { models: [], error: 'not signed in' }, limits: null });
  assert.deepEqual(none.problems, ['no models (not signed in)']);
});

test('copilotWindows: premium quota as a window resetting at quota_reset_date_utc; unlimited quotas skipped', () => {
  // Shape recorded from account.getCurrentAuth().authInfo.copilotUser (2026-09-26, trimmed).
  const user = { quota_reset_date: '2026-10-01', quota_reset_date_utc: '2026-10-01T00:00:00.000Z', quota_snapshots: {
    chat: { entitlement: 0, percent_remaining: 100, unlimited: true, quota_reset_at: 0 },
    premium_interactions: { entitlement: 200, percent_remaining: 82.4, remaining: 164, unlimited: false, quota_reset_at: 0 } } };
  assert.deepEqual(copilotWindows(user), [{ window: 'premium', pct: 17.6, resetsAt: 1790812800 }]);
});

test('claudeWindows: SDK rate_limits become window points with epoch resets', () => {
  assert.deepEqual(claudeWindows({ five_hour: { utilization: 40, resets_at: '2026-09-26T19:30:00Z' }, seven_day: { utilization: 86, resets_at: 1790607600 },
    seven_day_opus: null, model_scoped: [{ display_name: 'Fable', utilization: 5, resets_at: 1790607600 }] }), [
    { window: 'five_hour', pct: 40, resetsAt: 1790451000 }, { window: 'seven_day', pct: 86, resetsAt: 1790607600 }, { window: 'Fable', pct: 5, resetsAt: 1790607600 }]);
});

test('createLimitStore: saves checks, records readings, keeps the last good reading when a check fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-limits-')), file = path.join(dir, 'limits.json');
  const logged = [];
  let fail = false, t = 1000;
  const store = createLimitStore({ file, ids: ['codex', 'kiro'], now: () => t,
    usageLog: { window: (...a) => logged.push(a) },
    fetch: async (id) => (id === 'kiro' ? { source: null, exposed: false, windows: [], error: null, at: t }
      : fail ? { source: 's', exposed: true, windows: [], error: 'boom', at: null }
      : { source: 's', exposed: true, windows: [{ window: '5h', pct: 5, resetsAt: 99 }], error: null, at: 900 }) });
  await store.refresh();
  assert.deepEqual(store.get('codex'), { source: 's', exposed: true, windows: [{ window: '5h', pct: 5, resetsAt: 99 }], error: null, at: 900, checkedAt: 1000 });
  assert.deepEqual(logged, [['codex', '5h', 5, 99, 900]]);
  fail = true; t = 2000;
  await store.refresh(['codex']);
  assert.deepEqual(store.get('codex'), { source: 's', exposed: true, windows: [{ window: '5h', pct: 5, resetsAt: 99 }], error: 'boom', at: 900, checkedAt: 2000 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agents.kiro.exposed, false);
  // A restart starts from the saved checks.
  const again = createLimitStore({ file, ids: ['codex'], fetch: async () => ({}) });
  assert.equal(again.get('codex').error, 'boom');
});
