// agents.mjs: the adapter registry and the Claude adapter's event normalisation, driven by a fake SDK stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, runAgentCli } from '../agents.mjs';

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
