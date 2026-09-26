import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, runAgentCli, opencodeAuth, opencodeModels, limitScope, limitScopes } from '../agents.mjs';
import { SPECS, parsePane } from '../connections.mjs';
import { normUsage } from '../usage.mjs';

const stub = fileURLToPath(new URL('./fixtures/opencode-stub.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'));
const env = (mode, extra = {}) => ({ PATH: process.env.PATH, OPENCODE_STUB: mode, ...extra });

test('OAuth only: key credentials do not count as a subscription connection', () => {
  const home = tmp(), file = path.join(home, '.local/share/opencode/auth.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ openai: { type: 'api', key: 'secret' } }));
  assert.equal(opencodeAuth(home), false);
  fs.writeFileSync(file, JSON.stringify({ openai: { type: 'oauth', refresh: 'secret', access: 'secret' } }));
  assert.equal(opencodeAuth(home), true);
});

test('model discovery parses provider-specific CLI output without a static catalog', async () => {
  assert.deepEqual(opencodeModels('openai/gpt-5.4\nopenai/gpt-5.3-codex\nother/a\n'), [
    { id: 'openai/gpt-5.4', label: 'gpt-5.4' }, { id: 'openai/gpt-5.3-codex', label: 'gpt-5.3-codex' },
  ]);
  assert.deepEqual(await AGENTS.opencode.listModels({ bin: stub, env: env('success') }), opencodeModels('openai/gpt-5.4\nopenai/gpt-5.3-codex'));
});

test('recorded OpenCode stream normalizes text, tools, paths, results and usage', async () => {
  const dir = tmp(), log = path.join(dir, 'log.json'), events = [];
  const res = await runAgentCli({ agent: 'opencode', bin: stub, cwd: dir, model: 'openai/gpt-5.4', prompt: 'work', systemAppend: 'rules',
    env: env('success', { OPENCODE_STUB_LOG: log, OPENAI_API_KEY: 'secret', AZURE_OPENAI_API_KEY: 'secret', GITHUB_TOKEN: 'secret' }),
    onEvent: (e) => events.push(e) });
  assert.equal(res.outcome, 'ok');
  assert.equal(res.sessionId, 'ses_fixture');
  assert.equal(res.text, 'Done');
  assert.deepEqual(events.map(({ lines, ...e }) => e), [
    { k: 'text', text: 'Looking' },
    { k: 'tool', id: 'call_1', name: 'Bash', input: { command: 'cat src/a.js' } },
    { k: 'tool_result', id: 'call_1', text: 'hello\n', isError: false },
    { k: 'tool', id: 'call_2', name: 'read', input: { file_path: '/tmp/a.js' } },
    { k: 'tool_result', id: 'call_2', text: 'hello', isError: false },
    { k: 'text', text: 'Done' },
    { k: 'result', usage: { input_tokens: 209, output_tokens: 21, cached_input_tokens: 189, reasoning_output_tokens: 2 } },
  ]);
  assert.deepEqual(normUsage('opencode', res.usage), { input: 20, output: 21, cached: 189 });
  const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.deepEqual(seen.argv, ['run', '--dir', dir, '--format', 'json', '--model', 'openai/gpt-5.4', '--auto', 'rules\n\nwork']);
  for (const k of ['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.ok(!(k in seen.env), k);
});

test('resume uses exact session; completed run need not contain step_finish', async () => {
  const dir = tmp(), log = path.join(dir, 'log.json');
  const res = await runAgentCli({ agent: 'opencode', bin: stub, cwd: dir, resume: 'ses_old', prompt: 'more', autonomous: false,
    env: env('success', { OPENCODE_STUB_LOG: log }) });
  assert.equal(res.outcome, 'ok');
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')).argv, ['run', '--dir', dir, '--format', 'json', '--session', 'ses_old', 'more']);
  const missing = await runAgentCli({ agent: 'opencode', bin: stub, cwd: dir, resume: 'gone', prompt: 'more', env: env('missing') });
  assert.equal(missing.errorCode, 'no_session');
});

test('abort kills the OpenCode process group', async () => {
  const dir = tmp(), pids = path.join(dir, 'pids'), ac = new AbortController();
  const pending = runAgentCli({ agent: 'opencode', bin: stub, cwd: dir, prompt: 'wait', signal: ac.signal,
    env: env('hang', { OPENCODE_STUB_PIDS: pids }) });
  for (let i = 0; i < 100 && !fs.existsSync(pids); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(pids));
  ac.abort();
  assert.equal((await pending).outcome, 'aborted');
  const pid = Number(fs.readFileSync(pids, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(), false);
});

test('project API billing configuration is rejected before spawning', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'opencode.json'), '{"provider":{"openai":{"options":{"apiKey":"secret"}}}}');
  const res = await runAgentCli({ agent: 'opencode', bin: stub, cwd: dir, prompt: 'hi', env: env('success') });
  assert.equal(res.outcome, 'auth_error');
  assert.match(res.text, /API key/);
});

test('limits come only from structured error events, not tool output', async () => {
  const events = [];
  const ok = await runAgentCli({ agent: 'opencode', bin: stub, cwd: tmp(), prompt: 'hi', env: env('toolmention'), onEvent: (e) => events.push(e) });
  assert.equal(ok.outcome, 'ok');
  assert.ok(events.some((e) => e.k === 'tool_result' && /usage limit/.test(e.text)));
  assert.ok(!events.some((e) => e.k === 'limit'));
  const limit = await runAgentCli({ agent: 'opencode', bin: stub, cwd: tmp(), prompt: 'hi', env: env('limit'), onEvent: (e) => events.push(e) });
  assert.equal(limit.outcome, 'rate_limited');
  assert.equal(limit.resetsAt, Date.parse('2030-01-01T00:00:00Z') / 1000);
  assert.deepEqual(events.filter((e) => e.k === 'limit'), [{ k: 'limit', resetsAt: limit.resetsAt }]);
  assert.equal(limitScope('opencode', 'openai/gpt-5.4'), 'opencode:openai');
  assert.ok(limitScopes(['opencode']).includes('opencode:openai'));
});

test('recorded signed-out error stays a normal error without a false limit', async () => {
  const events = [];
  const res = await runAgentCli({ agent: 'opencode', bin: stub, cwd: tmp(), prompt: 'hi', env: env('signedout'), onEvent: (e) => events.push(e) });
  assert.equal(res.outcome, 'error');
  assert.equal(res.sessionId, 'ses_fixture');
  assert.ok(!events.some((e) => e.k === 'limit'));
});

test('device-flow sign-in spec parses URL and code', () => {
  assert.deepEqual(parsePane(SPECS.opencode, 'Go to: https://auth.openai.com/codex/device\nEnter code: ABCD-12345'), {
    url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', prompts: [], exited: false, exitCode: null, ok: false, error: null,
  });
  assert.deepEqual(SPECS.opencode.logout, ['opencode', 'auth', 'logout', 'openai']);
});
