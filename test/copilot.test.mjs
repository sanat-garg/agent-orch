import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, copilotModels, runAgentCli } from '../agents.mjs';
import { SPECS, parsePane } from '../connections.mjs';
import { createUsageLog } from '../usage.mjs';

const stub = fileURLToPath(new URL('./fixtures/copilot-stub.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
const env = (mode, extra = {}) => ({ ...process.env, COPILOT_STUB: mode, ...extra });

test('Copilot model discovery uses the authenticated SDK response', async () => {
  assert.deepEqual(copilotModels([{ id: 'auto', name: 'Auto' }, { id: 'account-model', name: 'Account Model' }, { id: 'byok/model' }]), [
    { id: 'auto', label: 'Auto', default: true }, { id: 'account-model', label: 'Account Model' },
  ]);
  let started = false, stopped = false;
  const rows = await AGENTS.copilot.listModels({ clientFactory: () => ({
    async start() { started = true; }, async listModels() { return [{ id: 'actual-model', name: 'Actual Model' }]; }, async stop() { stopped = true; },
  }) });
  assert.deepEqual(rows, [{ id: 'actual-model', label: 'Actual Model' }]);
  assert.equal(started && stopped, true);
});

test('Copilot stream normalizes tools, final text, usage and resume while stripping overrides', async () => {
  const dir = tmp(), log = path.join(dir, 'log.json'), events = [];
  const res = await runAgentCli({ agent: 'copilot', bin: stub, cwd: dir, prompt: 'work', model: 'actual-model', resume: 'old',
    systemAppend: 'rules', env: env('success', { COPILOT_STUB_LOG: log, COPILOT_GITHUB_TOKEN: 'secret', COPILOT_PROVIDER_API_KEY: 'secret', GH_TOKEN: 'secret' }),
    onEvent: (e) => events.push(e) });
  assert.equal(res.outcome, 'ok'); assert.equal(res.sessionId, 'copilot-session'); assert.equal(res.text, 'Hi!');
  assert.equal(res.usage.premiumRequests, 1);
  assert.deepEqual(events.map(({ lines, ...e }) => e), [
    { k: 'tool', id: 'call_1', name: 'Bash', input: { command: 'cat notes/a.txt' } },
    { k: 'tool_result', id: 'call_1', text: 'hello\n', isError: false },
    { k: 'text', text: 'Hi!' }, { k: 'result', usage: { premiumRequests: 1, totalApiDurationMs: 2317 } },
  ]);
  const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.deepEqual(seen.argv, ['-C', dir, '-p', 'rules\n\nwork', '--output-format', 'json', '--no-ask-user', '--model', 'actual-model', '--resume=old', '--allow-all']);
  for (const k of ['COPILOT_GITHUB_TOKEN', 'COPILOT_PROVIDER_API_KEY', 'GH_TOKEN']) assert.ok(!(k in seen.env));
  assert.equal(seen.env.COPILOT_HOME, path.join(os.homedir(), '.copilot'));
});

test('Copilot only detects limits from structured provider errors', async () => {
  const okEvents = [], hitEvents = [];
  const ok = await runAgentCli({ agent: 'copilot', bin: stub, cwd: tmp(), prompt: 'x', env: env('toolmention'), onEvent: (e) => okEvents.push(e) });
  assert.equal(ok.outcome, 'ok'); assert.ok(!okEvents.some((e) => e.k === 'limit'));
  const hit = await runAgentCli({ agent: 'copilot', bin: stub, cwd: tmp(), prompt: 'x', env: env('limit'), onEvent: (e) => hitEvents.push(e) });
  assert.equal(hit.outcome, 'rate_limited'); assert.equal(hit.resetsAt, null);
  assert.deepEqual(hitEvents.filter((e) => e.k === 'limit'), [{ k: 'limit', resetsAt: null }]);
  const missing = await runAgentCli({ agent: 'copilot', bin: stub, cwd: tmp(), prompt: 'x', resume: 'gone', env: env('missing') });
  assert.equal(missing.errorCode, 'no_session');
});

test('Copilot abort kills the process group', async () => {
  const dir = tmp(), pids = path.join(dir, 'pid'), ac = new AbortController();
  const pending = runAgentCli({ agent: 'copilot', bin: stub, cwd: dir, prompt: 'x', signal: ac.signal, env: env('hang', { COPILOT_STUB_PIDS: pids }) });
  for (let i = 0; i < 100 && !fs.existsSync(pids); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(pids)); ac.abort();
  assert.equal((await pending).outcome, 'aborted');
  const pid = Number(fs.readFileSync(pids, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(), false);
});

test('Copilot shares gh device flow and premium requests reach usage history', () => {
  const p = parsePane(SPECS.copilot, 'First copy your one-time code: 1A2B-3C4D\nPress Enter to open\n');
  assert.equal(p.url, 'https://github.com/login/device'); assert.equal(p.code, '1A2B-3C4D');
  assert.match(SPECS.copilot.logoutWarning, /also signs out GitHub/);
  const dir = tmp(), log = createUsageLog(dir);
  log.tokens('copilot', { premiumRequests: 2 }, 'task', 1);
  const a = log.history('24h').agents.copilot;
  assert.equal(a.tokens.reduce((n, b) => n + b.premiumRequests, 0), 2);
});
