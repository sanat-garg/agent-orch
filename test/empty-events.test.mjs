// Task #196: normalised events are never empty when the native CLI event had data. Replays the recorded fixtures in
// test/fixtures/empty-events/ (one per agent; see its README) through each adapter's normaliser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, runAgentCli, nativeInput, toolInputSummary, outputText, finishEmpty } from '../agents.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/empty-events');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const empty = (v) => v == null || v === '' || (typeof v === 'object' && !Object.values(v).some((x) => x != null && x !== '' && !(Array.isArray(x) && !x.length)));

// Each fixture's native tool calls: id -> the arguments the CLI sent (merged over all its events).
const NATIVE = {
  claude: (m, add) => { if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') add(b.id, b.input); },
  codex: (m, add) => {
    const it = m.item;
    if (!it || !['command_execution', 'web_search', 'mcp_tool_call', 'file_change'].includes(it.type)) return;
    add(it.id, { command: it.command, query: it.query, arguments: it.arguments, changes: it.changes, ...(it.action || {}), type: undefined });
  },
};
const FIXTURES = [['claude', 'claude.jsonl'], ['codex', 'codex.jsonl']];
function replay(agent, file) {
  const st = agent === 'codex' ? new Set() : { tools: new Set() };
  const msgs = read(file), events = [];
  for (const m of msgs) for (const e of AGENTS[agent].events(m, st)) events.push(e);
  return { msgs, events };
}

for (const [agent, file] of FIXTURES) {
  test(`invariant (${file}): a native call with arguments never becomes an empty input; every result has text`, () => {
    const { msgs, events } = replay(agent, file);
    const args = new Map();
    for (const m of msgs) NATIVE[agent](m, (id, a) => { if (!empty(a)) args.set(id, { ...(args.get(id) || {}), ...a }); else if (!args.has(id)) args.set(id, {}); });
    const tools = events.filter((e) => e.k === 'tool'), results = events.filter((e) => e.k === 'tool_result');
    assert.ok(tools.length, 'fixture has tool calls');
    for (const [id, a] of args) {
      const calls = tools.filter((e) => String(e.id) === String(id));
      assert.equal(calls.length, 1, `${file}: tool ${id} announced once`);
      assert.ok(calls[0].name, `${file}: tool ${id} has a name`);
      if (!empty(a)) assert.ok(!empty(calls[0].input), `${file}: tool ${id} (${calls[0].name}) had native args ${JSON.stringify(a).slice(0, 200)} but input ${JSON.stringify(calls[0].input)}`);
    }
    assert.equal(results.length, tools.length, `${file}: every tool has a result`);
    for (const r of results) assert.ok(String(r.text).trim(), `${file}: tool ${r.id} result text is empty`);
  });
}

test('claude: Skill/TaskStop inputs kept; ToolSearch and image results have text', () => {
  const { events } = replay('claude', 'claude.jsonl');
  const tool = (n) => events.find((e) => e.k === 'tool' && e.name === n);
  const result = (n) => events.find((e) => e.k === 'tool_result' && e.id === tool(n).id);
  assert.deepEqual(tool('Skill').input, { skill: 'run' });
  assert.deepEqual(tool('TaskStop').input, { task_id: 'bqmdii41d' });
  assert.equal(result('ToolSearch').text, 'Loaded tool WebSearch\nLoaded tool WebFetch');
  assert.equal(result('Read').text, '(image)');
  assert.ok(events.some((e) => e.k === 'image'), 'the image itself still follows');
});

test('codex: web_search is announced with its query from the action; silent and failed commands say so', () => {
  const { events } = replay('codex', 'codex.jsonl');
  const byId = (k, id) => events.filter((e) => e.k === k && e.id === id);
  assert.deepEqual(byId('tool', 'item_1')[0].input, { query: 'livebench leaderboard github' });
  assert.deepEqual(byId('tool', 'item_2')[0].input, { url: 'https://api.github.com/repos/rsms/inter/releases/latest', query: 'https://api.github.com/repos/rsms/inter/releases/latest' });
  assert.match(byId('tool_result', 'item_1')[0].text, /searched: livebench/);
  assert.match(byId('tool_result', 'item_2')[0].text, /Internal Error/);
  assert.deepEqual(byId('tool_result', 'item_3')[0], { k: 'tool_result', id: 'item_3', text: '(no output)', isError: false, lines: 1 });
  assert.equal(byId('tool_result', 'item_4')[0].text, '(exit code 1, no output)');
  assert.equal(byId('tool_result', 'item_4')[0].isError, true);
  assert.deepEqual(byId('tool', 'item_5')[0].input, { query: 'node test runner' });
  assert.equal(byId('tool_result', 'item_5')[0].text, 'node:test docs');
});

test('nativeInput: every argument shape flattens to the UI field names', () => {
  assert.deepEqual(nativeInput('{"cmd":"ls","Cwd":"/w"}'), { command: 'ls', cwd: '/w' });
  assert.deepEqual(nativeInput({ parameters: { file: '/a' } }), { file_path: '/a' });
  assert.deepEqual(nativeInput({ arguments: '{"filePath":"/b","oldString":"x"}' }), { file_path: '/b', old_string: 'x' });
  assert.deepEqual(nativeInput({ cmd: ['bash', '-lc', 'ls'] }), { command: 'bash -lc ls' });
  assert.deepEqual(nativeInput({ dir: '/s', Pattern: '*.js' }), { path: '/s', pattern: '*.js' });
  assert.deepEqual(nativeInput('*** Begin Patch'), { input: '*** Begin Patch' });
  assert.deepEqual(nativeInput(''), {});
  assert.deepEqual(nativeInput(null), {});
  assert.deepEqual(toolInputSummary('poll', { shell_id: '1', delay: 5 }), { shell_id: '1', delay: 5 });
  assert.deepEqual(toolInputSummary('x', { opts: { a: 1 } }), { opts: '{"a":1}' });
  assert.equal(outputText({ stdout: 'out', stderr: 'err' }), 'out\nerr');
  assert.equal(outputText([{ type: 'content', content: { type: 'text', text: 'nested' } }]), 'nested');
  assert.equal(outputText({ stdout: undefined, stderr: '' }), '');
});

const fakeQuery = (msgs) => () => (async function* () { for (const m of msgs) yield m; })();
const useTool = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } };
const ok = { type: 'result', subtype: 'success', result: '', usage: {}, num_turns: 1 };

test('empty final reply: keeps the last assistant text, else a marked summary of the tools, else an error', async () => {
  const run = (msgs) => {
    const events = [];
    return runAgentCli({ agent: 'claude', prompt: 'p', cwd: os.tmpdir(), query: fakeQuery(msgs), onEvent: (e) => events.push(e) }).then((res) => ({ res, events }));
  };
  let { res } = await run([{ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } }, useTool, ok]);
  assert.equal(res.outcome, 'ok');
  assert.equal(res.text, 'All done.');

  let events;
  ({ res, events } = await run([useTool, useTool, ok]));
  assert.equal(res.outcome, 'ok');
  assert.equal(res.synthesized, true);
  assert.match(res.text, /^\(No final reply from Claude Code; summary synthesized by agent-orch\) Used 2 tool calls: Bash ×2\.$/);
  assert.deepEqual(events.at(-1), { k: 'text', text: res.text, synthesized: true });

  ({ res } = await run([ok]));
  assert.equal(res.outcome, 'error');
  assert.equal(res.errorCode, 'empty_response');
  assert.match(res.text, /returned an empty response/);

  // Other outcomes pass through untouched.
  assert.equal(finishEmpty({ outcome: 'aborted', text: '' }, { agent: AGENTS.codex, lastText: '', tools: [], onEvent() {} }).outcome, 'aborted');
});
