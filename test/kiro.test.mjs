import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, runAgentCli, kiroAuth, kiroModels } from '../agents.mjs';
import { SPECS, parsePane } from '../connections.mjs';
const stub = fileURLToPath(new URL('./fixtures/kiro-stub.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
const env = (mode, extra = {}) => ({ ...process.env, KIRO_STUB: mode, ...extra });

test('Kiro status requires a browser account and discovers CLI models', async () => {
  assert.deepEqual(kiroAuth('{"account":null}'), { ok: false, account: null });
  assert.deepEqual(kiroAuth('{"account":{"type":"api_key","email":"x@y"}}'), { ok: false, account: null });
  assert.deepEqual(kiroAuth('{"account":{"type":"builder_id","email":"x@y"}}'), { ok: true, account: 'x@y' });
  assert.deepEqual(kiroAuth('{"accountType":"BuilderId","email":"x@y"}'), { ok: true, account: 'x@y' });
  assert.deepEqual(kiroModels('{"models":[{"id":"m1","name":"Model One"}]}'), [{ id: 'm1', label: 'Model One' }]);
  assert.deepEqual(await AGENTS.kiro.listModels({ bin: stub }), [{ id: 'discovered-model', label: 'Discovered Model', default: true }]);
});

// The authenticated stream is an ACP protocol fixture; this VM has no Kiro login to capture a live turn.
test('Kiro stream normalizes ACP text, tools, result, resume, and strips API key', async () => {
  const dir = tmp(), log = path.join(dir, 'log.json'), events = [];
  const res = await runAgentCli({ agent: 'kiro', bin: stub, cwd: dir, prompt: 'work', model: 'discovered-model', resume: 'old',
    systemAppend: 'rules', env: env('success', { KIRO_API_KEY: 'secret', KIRO_STUB_LOG: log }), onEvent: (e) => events.push(e) });
  assert.equal(res.outcome, 'ok'); assert.equal(res.sessionId, 'kiro_session'); assert.equal(res.text, 'Checking Done');
  assert.deepEqual(events.map(({ lines, ...e }) => e), [
    { k: 'text', text: 'Checking ' },
    { k: 'tool', id: 'call_1', name: 'Bash', input: { command: 'cat notes/a.txt' } },
    { k: 'tool_result', id: 'call_1', text: 'hello\n', isError: false },
    { k: 'text', text: 'Done' },
    { k: 'result', usage: { input_tokens: 10, output_tokens: 5 } },
  ]);
  const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.deepEqual(seen.argv, ['chat', '--no-interactive', '--agent-engine', 'v2', '--output-format', 'stream-json', '--trust-all-tools', '--model', 'discovered-model', '--resume-id', 'old', 'rules\n\nwork']);
  assert.ok(!('KIRO_API_KEY' in seen.env));
});

test('Kiro only detects limits from structured errors', async () => {
  const events = [];
  const ok = await runAgentCli({ agent: 'kiro', bin: stub, cwd: tmp(), prompt: 'x', env: env('toolmention'), onEvent: (e) => events.push(e) });
  assert.equal(ok.outcome, 'ok'); assert.ok(!events.some((e) => e.k === 'limit'));
  const hit = await runAgentCli({ agent: 'kiro', bin: stub, cwd: tmp(), prompt: 'x', env: env('limit'), onEvent: (e) => events.push(e) });
  assert.equal(hit.outcome, 'rate_limited');
  assert.equal(hit.resetsAt, Date.parse('2030-01-01T00:00:00Z') / 1000);
  assert.deepEqual(events.filter((e) => e.k === 'limit'), [{ k: 'limit', resetsAt: hit.resetsAt }]);
  const signedout = await runAgentCli({ agent: 'kiro', bin: stub, cwd: tmp(), prompt: 'x', env: env('signedout') });
  assert.equal(signedout.outcome, 'auth_error');
  const missing = await runAgentCli({ agent: 'kiro', bin: stub, cwd: tmp(), prompt: 'x', resume: 'gone', env: env('missing') });
  assert.equal(missing.errorCode, 'no_session');
});

test('Kiro abort kills its process group', async () => {
  const dir = tmp(), pids = path.join(dir, 'pid'), ac = new AbortController();
  const pending = runAgentCli({ agent: 'kiro', bin: stub, cwd: dir, prompt: 'x', signal: ac.signal, env: env('hang', { KIRO_STUB_PIDS: pids }) });
  for (let i = 0; i < 100 && !fs.existsSync(pids); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(pids)); ac.abort();
  assert.equal((await pending).outcome, 'aborted');
  const pid = Number(fs.readFileSync(pids, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(), false);
});

test('Kiro device-flow spec parses the CLI pane and exposes logout', () => {
  assert.deepEqual(parsePane(SPECS.kiro, 'Confirm the following code in the browser\nCode: GVLJ-TJLP\n\nOpen this URL: https://view.awsapps.com/start/#/device?user_code=GVLJ-TJLP'), {
    url: 'https://view.awsapps.com/start/#/device?user_code=GVLJ-TJLP', code: 'GVLJ-TJLP', prompts: [], exited: false, exitCode: null, ok: false, error: null,
  });
  assert.equal(SPECS.kiro.logout.at(-1), 'logout');
});
