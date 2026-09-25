// agents.mjs: the adapter registry and each adapter's event normalisation (claude via a fake SDK stream, codex via a stub binary).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, runAgentCli, codexResetsAt } from '../agents.mjs';

const fakeQuery = (msgs, seen = {}) => (args) => { Object.assign(seen, args); return (async function* () { for (const m of msgs) yield m; })(); };

test('registry: every adapter declares id, label, available(), models and envFilter', () => {
  assert.ok(AGENTS.claude);
  for (const [id, a] of Object.entries(AGENTS)) {
    assert.equal(a.id, id);
    assert.equal(typeof a.label, 'string');
    assert.equal(typeof a.available, 'function');
    assert.equal(typeof a.available(), 'boolean');
    assert.ok(Array.isArray(a.models) && a.models.length);
    assert.ok(a.envFilter instanceof RegExp);
  }
  assert.ok(AGENTS.claude.envFilter.test('ANTHROPIC_API_KEY'));
  assert.ok(!AGENTS.claude.envFilter.test('PATH'));
});

test('unknown agent is rejected', () => {
  assert.throws(() => runAgentCli({ agent: 'nope' }), /unknown agent/);
});

test('claude: SDK messages become normalised events and a classified result', async () => {
  const msgs = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', junk: 1 } }] } },
    { type: 'user', session_id: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a\nb' }], is_error: false }] } },
    { type: 'assistant', parent_tool_use_id: 'x', session_id: 's1', message: { content: [{ type: 'text', text: 'subagent chatter' }] } },
    { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'Done' }] } },
    { type: 'result', subtype: 'success', session_id: 's1', result: 'Done', usage: { input_tokens: 5, output_tokens: 2 }, num_turns: 2 },
  ];
  const seen = {}, events = [], raw = [];
  const res = await runAgentCli({
    agent: 'claude', model: 'sonnet', prompt: 'hi', cwd: '/tmp', systemAppend: 'extra', query: fakeQuery(msgs, seen),
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_USE_BEDROCK: '1' },
    onEvent: (e) => events.push(e), onMessage: (m) => raw.push(m),
  });
  assert.deepEqual(events.map(({ id, lines, ...e }) => e), [
    { k: 'text', text: 'Looking' },
    { k: 'tool', name: 'Bash', input: { command: 'ls' } },
    { k: 'tool_result', text: 'a\nb', isError: false },
    { k: 'text', text: 'Done' },
    { k: 'result', usage: { input_tokens: 5, output_tokens: 2 } },
  ]);
  assert.equal(raw.length, msgs.length);
  assert.equal(res.outcome, 'ok');
  assert.equal(res.text, 'Done');
  assert.equal(res.sessionId, 's1');
  assert.equal(res.numTurns, 2);
  assert.deepEqual(res.usage, { input_tokens: 5, output_tokens: 2 });
  // Billing stays on the subscription: API vars are stripped from the agent's env.
  assert.deepEqual(seen.options.env, { PATH: '/usr/bin' });
  assert.equal(seen.options.model, 'sonnet');
  assert.equal(seen.options.systemPrompt.append, 'extra');
});

test('claude: a rejected rate limit emits a limit event and a rate_limited outcome', async () => {
  const msgs = [
    { type: 'rate_limit_event', session_id: 's2', rate_limit_info: { status: 'rejected', resetsAt: 1790000000, rateLimitType: 'five_hour' } },
    { type: 'assistant', session_id: 's2', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your limit" }] } },
    { type: 'result', subtype: 'success', is_error: true, session_id: 's2', result: "You've hit your limit", usage: {} },
  ];
  const events = [];
  const res = await runAgentCli({ agent: 'claude', prompt: 'hi', cwd: '/tmp', query: fakeQuery(msgs), env: {}, onEvent: (e) => events.push(e) });
  assert.deepEqual(events.find((e) => e.k === 'limit'), { k: 'limit', resetsAt: 1790000000 });
  assert.equal(res.outcome, 'rate_limited');
  assert.equal(res.resetsAt, 1790000000);
  assert.equal(res.limitType, 'five_hour');
  assert.equal(res.errorCode, 'rate_limit');
});

test('claude: an aborted signal ends with outcome aborted', async () => {
  const ac = new AbortController();
  ac.abort();
  const res = await runAgentCli({ prompt: 'hi', cwd: '/tmp', signal: ac.signal, env: {},
    query: () => (async function* () { throw new Error('aborted by user'); })() });
  assert.equal(res.outcome, 'aborted');
  assert.equal(res.stderr, '');
});

// ---- codex: runs test/fixtures/codex-stub.mjs, which prints recorded `codex exec --json` events.

const STUB = fileURLToPath(new URL('./fixtures/codex-stub.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('codex: JSONL events become normalised text/tool/result events', async () => {
  const dir = tmp(), log = path.join(dir, 'log.json'), events = [];
  const res = await runAgentCli({
    agent: 'codex', bin: STUB, model: 'gpt-5-codex', prompt: 'add tests', systemAppend: 'extra', cwd: dir,
    env: { PATH: process.env.PATH, CODEX_STUB: 'ok', CODEX_STUB_LOG: log, OPENAI_API_KEY: 'sk-x', CODEX_API_KEY: 'k', CODEX_HOME: '/x', AZURE_OPENAI_KEY: 'a' },
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(events.map(({ lines, ...e }) => e), [
    { k: 'text', text: 'Looking' },
    { k: 'tool', id: 'item_2', name: 'Bash', input: { command: 'bash -lc ls' } },
    { k: 'tool_result', id: 'item_2', text: 'README.md\nsrc\n', isError: false },
    { k: 'tool', id: 'item_3', name: 'Edit', input: { file_path: 'update src/a.js' } },
    { k: 'tool_result', id: 'item_3', text: 'update src/a.js', isError: false },
    { k: 'text', text: 'Done. I added the tests.' },
    { k: 'result', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 64 } },
  ]);
  assert.equal(res.outcome, 'ok');
  assert.equal(res.text, 'Done. I added the tests.');
  assert.equal(res.sessionId, '01a0d699-1efd-7d72-b9f4-2616f4bf739a');
  assert.equal(res.usage.output_tokens, 122);
  const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(dir));
  assert.deepEqual(seen.argv, ['exec', '--json', '--skip-git-repo-check', '-c', 'forced_login_method="chatgpt"', '-m', 'gpt-5-codex',
    '--dangerously-bypass-approvals-and-sandbox', '--', 'extra\n\nadd tests']);
  // Billing stays on the ChatGPT login: API-key vars never reach the CLI.
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'AZURE_OPENAI_KEY']) assert.ok(!(k in seen.env), k);
  assert.equal(seen.env.CODEX_STUB, 'ok');
});

test('codex: resume passes the thread id; non-autonomous keeps the sandbox', async () => {
  const dir = tmp(), log = path.join(dir, 'log.json');
  const res = await runAgentCli({ agent: 'codex', bin: STUB, prompt: 'more', cwd: dir, resume: 'abc', autonomous: false,
    env: { PATH: process.env.PATH, CODEX_STUB: 'ok', CODEX_STUB_LOG: log } });
  assert.equal(res.outcome, 'ok');
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')).argv, ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'forced_login_method="chatgpt"',
    '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', '--', 'abc', 'more']);
});

test('codex: a usage-limit failure is rate_limited with resetsAt', async () => {
  const events = [];
  const res = await runAgentCli({ agent: 'codex', bin: STUB, prompt: 'hi', cwd: tmp(), env: { PATH: process.env.PATH, CODEX_STUB: 'limit' }, onEvent: (e) => events.push(e) });
  const reset = Date.parse('2030-01-01T00:00:00Z') / 1000;
  assert.equal(res.outcome, 'rate_limited');
  assert.equal(res.resetsAt, reset);
  assert.match(res.text, /usage limit/);
  assert.deepEqual(events.filter((e) => e.k === 'limit'), [{ k: 'limit', resetsAt: reset }, { k: 'limit', resetsAt: reset }]);
  assert.ok(!events.some((e) => e.k === 'result'));
});

test('codex: resetsAt parsing handles clock times and missing hints', () => {
  const now = new Date(2026, 8, 25, 10, 0, 0);
  assert.equal(codexResetsAt('try again at 3:05 PM.', now), new Date(2026, 8, 25, 15, 5).getTime() / 1000);
  assert.equal(codexResetsAt('Try again at 9:00 AM', now), new Date(2026, 8, 26, 9, 0).getTime() / 1000);
  assert.equal(codexResetsAt("You've hit your usage limit.", now), null);
});

test('codex: abort kills the process group and ends with outcome aborted', async () => {
  const dir = tmp(), pids = path.join(dir, 'pids'), ac = new AbortController();
  const p = runAgentCli({ agent: 'codex', bin: STUB, prompt: 'hi', cwd: dir, signal: ac.signal, env: { PATH: process.env.PATH, CODEX_STUB: 'hang', CODEX_STUB_PIDS: pids },
    onEvent: (e) => { if (e.k === 'tool') ac.abort(); } });
  const res = await p;
  assert.equal(res.outcome, 'aborted');
  const g = Number(fs.readFileSync(pids, 'utf8'));
  for (let i = 0; i < 50 && alive(g); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(!alive(g), 'grandchild survived the abort');
});
