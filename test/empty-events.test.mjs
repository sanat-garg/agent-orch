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

// A fake agy home holding what agy saves per step: brain/<id>/.system_generated/steps/<i>/output.txt and
// conversations/<id>.db (steps.step_payload, protobuf: field 5.4.3 = the call's JSON args, 140.2.1 = its output).
// Only some steps get an output.txt, so both sources are exercised.
function pbEncode(fields) {
  const varint = (n) => { const b = []; do { let c = n & 0x7f; n = Math.floor(n / 128); if (n) c |= 0x80; b.push(c); } while (n); return Buffer.from(b); };
  return Buffer.concat(fields.map(([f, v]) => { const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v)); return Buffer.concat([varint(f * 8 + 2), varint(b.length), b]); }));
}
function agyHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
  const native = JSON.parse(fs.readFileSync(path.join(DIR, 'antigravity-native.json'), 'utf8'));
  fs.mkdirSync(path.join(home, 'conversations'));
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  for (const [cid, steps] of Object.entries(native)) {
    const db = new DatabaseSync(path.join(home, 'conversations', `${cid}.db`));
    db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_payload blob)');
    for (const [i, s] of Object.entries(steps)) {
      const payload = pbEncode([[1, 'x'], [5, pbEncode([[4, pbEncode([[1, `call_${i}`], [2, 'tool'], [3, JSON.stringify(s.args)]])]])],
        [140, pbEncode([[2, pbEncode([[1, s.output]])]])]]);
      db.prepare('INSERT INTO steps VALUES (?, ?)').run(Number(i), payload);
      if (Number(i) % 4 === 0) {
        const dir = path.join(home, 'brain', cid, '.system_generated/steps', i);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'output.txt'), s.output);
      }
    }
    db.close();
  }
  return { home, native };
}

// Each fixture's native tool calls: id -> the arguments the CLI sent (merged over all its events).
const NATIVE = {
  claude: (m, add) => { if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') add(b.id, b.input); },
  codex: (m, add) => {
    const it = m.item;
    if (!it || !['command_execution', 'web_search', 'mcp_tool_call', 'file_change'].includes(it.type)) return;
    add(it.id, { command: it.command, query: it.query, arguments: it.arguments, changes: it.changes, ...(it.action || {}), type: undefined });
  },
  antigravity: (m, add, native) => {
    const u = m.step_update;
    if (u?.step_type === 'tool') add(String(u.step_index), { ...(native?.[u.conversation_id]?.[u.step_index]?.args || {}), ...u.tool_info?.parameters });
  },
  opencode: (m, add) => { if (m.type === 'tool_use') add(m.part.callID, m.part.state?.input); },
  kiro: (m, add) => { const u = m.params?.update; if (u?.toolCallId) add(u.toolCallId, { ...(u.rawInput || {}), locations: u.locations }); },
  copilot: (m, add) => { if (m.type === 'tool.execution_start') add(m.data.toolCallId, typeof m.data.arguments === 'string' ? { patch: m.data.arguments } : m.data.arguments); },
};
const FIXTURES = [
  ['claude', 'claude.jsonl'], ['codex', 'codex.jsonl'], ['antigravity', 'antigravity.jsonl'], ['antigravity', 'antigravity-run136.jsonl'],
  ['opencode', 'opencode.jsonl'], ['kiro', 'kiro.jsonl'], ['copilot', 'copilot.jsonl'],
];
function replay(agent, file, home) {
  const st = agent === 'codex' ? new Set() : agent === 'antigravity' ? { text: new Map(), started: new Set(), home } : { tools: new Set() };
  const msgs = read(file), events = [];
  for (const m of msgs) for (const e of AGENTS[agent].events(m, st)) events.push(e);
  return { msgs, events };
}

const { home, native } = agyHome();
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));

for (const [agent, file] of FIXTURES) {
  test(`invariant (${file}): a native call with arguments never becomes an empty input; every result has text`, () => {
    const { msgs, events } = replay(agent, file, home);
    const args = new Map();
    for (const m of msgs) NATIVE[agent](m, (id, a) => { if (!empty(a)) args.set(id, { ...(args.get(id) || {}), ...a }); else if (!args.has(id)) args.set(id, {}); }, native);
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

test('antigravity: exit codes, edit output and missing args come from the saved conversation', () => {
  const { events } = replay('antigravity', 'antigravity.jsonl', home);
  const r = (id) => events.find((e) => e.k === 'tool_result' && e.id === id);
  const t = (id) => events.find((e) => e.k === 'tool' && e.id === id);
  assert.deepEqual([r('2').text, r('2').isError], ['(no output)', false]);
  assert.deepEqual([r('4').text, r('4').isError], ['(exit code 1, no output)', true], '`false` is a failure');
  assert.equal(r('8').text, 'Created file file:///workspace/b.txt with requested content.');
  assert.match(r('10').text, /^The following changes were made by the replace_file_content tool[\s\S]*-hello\n\+hi/);
  assert.match(r('12').text, /^total 20/);
  assert.deepEqual(t('8').input, { file_path: '/workspace/b.txt' });
  const old = replay('antigravity', 'antigravity-run136.jsonl', home).events;
  const ot = (id) => old.find((e) => e.k === 'tool' && e.id === id);
  assert.deepEqual(ot('2').input, { file_path: '/workspace/.agent-orch/BRIEF.md' }, 'no stream params: the saved call has them');
  assert.deepEqual(ot('87').input, { action: 'status', task_id: 'agy-run136-fixture/task-75' });
  assert.equal(ot('89').input.timer_condition, 'agy-run136-fixture/task-75');
});

test('copilot: apply_patch keeps its patch and files; shell exit codes mark failures', () => {
  const { events } = replay('copilot', 'copilot.jsonl');
  const patches = events.filter((e) => e.k === 'tool' && e.name === 'apply_patch');
  assert.equal(patches.length, 2);
  assert.equal(patches[0].input.file_path, '/workspace/b.txt');
  assert.match(patches[0].input.content, /^\*\*\* Begin Patch/);
  const bash = events.filter((e) => e.k === 'tool' && e.name === 'Bash');
  const res = (id) => events.find((e) => e.k === 'tool_result' && e.id === id);
  assert.equal(res(bash[0].id).isError, false);
  assert.equal(res(bash[1].id).isError, true, '`false` exited 1');
});

test('opencode: edit keeps oldString/newString; bash exit codes mark failures', () => {
  const { events } = replay('opencode', 'opencode.jsonl');
  const edit = events.find((e) => e.k === 'tool' && e.name === 'edit');
  assert.deepEqual(edit.input, { file_path: '/workspace/a.txt', old_string: 'hello', new_string: 'hi' });
  const bash = events.filter((e) => e.k === 'tool' && e.name === 'Bash');
  const res = (id) => events.find((e) => e.k === 'tool_result' && e.id === id);
  assert.deepEqual([res(bash[0].id).isError, res(bash[1].id).isError], [false, true]);
});

test('kiro: a call announced without rawInput waits for it; locations and nested content are used', () => {
  const { events } = replay('kiro', 'kiro.jsonl');
  const tools = events.filter((e) => e.k === 'tool');
  assert.deepEqual(tools.map((e) => [e.name, e.input]), [['read', { file_path: '/workspace/notes/a.txt' }], ['shell', { command: 'false' }]]);
  const results = events.filter((e) => e.k === 'tool_result');
  assert.deepEqual(results.map((e) => [e.text, e.isError]), [['hello\n', false], ['(exit code 1, no output)', true]]);
});

test('nativeInput: every argument shape flattens to the UI field names', () => {
  assert.deepEqual(nativeInput('{"CommandLine":"ls","Cwd":"/w"}'), { command: 'ls', cwd: '/w' });
  assert.deepEqual(nativeInput({ parameters: { AbsolutePath: '/a' } }), { file_path: '/a' });
  assert.deepEqual(nativeInput({ arguments: '{"filePath":"/b","oldString":"x"}' }), { file_path: '/b', old_string: 'x' });
  assert.deepEqual(nativeInput({ cmd: ['bash', '-lc', 'ls'] }), { command: 'bash -lc ls' });
  assert.deepEqual(nativeInput({ SearchDirectory: '/s', Pattern: '*.js' }), { path: '/s', pattern: '*.js' });
  assert.deepEqual(nativeInput('*** Begin Patch'), { input: '*** Begin Patch' });
  assert.deepEqual(nativeInput(''), {});
  assert.deepEqual(nativeInput(null), {});
  assert.deepEqual(toolInputSummary('read_bash', { shell_id: '1', delay: 5 }), { shell_id: '1', delay: 5 });
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
