// agents.mjs: the adapter registry and each adapter's event normalisation (claude via a fake SDK stream, codex and antigravity via stub binaries).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, runAgentCli, codexResetsAt, codexWindows, codexRolloutState, codexLatestSnapshot, isMissingSession } from '../agents.mjs';
import { createUsageLog } from '../usage.mjs';

const fakeQuery = (msgs, seen = {}) => (args) => { Object.assign(seen, args); return (async function* () { for (const m of msgs) yield m; })(); };

test('registry: every adapter declares id, label, available(), listModels() and envFilter', () => {
  assert.ok(AGENTS.claude);
  for (const [id, a] of Object.entries(AGENTS)) {
    assert.equal(a.id, id);
    assert.equal(typeof a.label, 'string');
    assert.equal(typeof a.available, 'function');
    assert.equal(typeof a.available(), 'boolean');
    assert.equal(typeof a.listModels, 'function');
    assert.equal(a.models, undefined, 'no hardcoded model list');
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

test('codex: resuming a thread with no rollout is errorCode no_session', async () => {
  const res = await runAgentCli({ agent: 'codex', bin: STUB, prompt: 'more', cwd: tmp(), resume: 'dead-id', env: { PATH: process.env.PATH, CODEX_STUB: 'nosession' } });
  assert.equal(res.outcome, 'error');
  assert.equal(res.errorCode, 'no_session');
  assert.match(res.text, /no rollout found for thread id dead-id/);
  assert.ok(isMissingSession(res));
  assert.ok(isMissingSession({ outcome: 'error', text: 'No conversation found with session ID: x' }));
  assert.ok(!isMissingSession({ outcome: 'error', text: 'boom', errorCode: null }));
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

// test/fixtures/codex-rollout.jsonl: token_count snapshots recorded from a real `codex exec` rollout (0.157.0, Plus plan);
// the stub writes it into CODEX_STUB_HOME/sessions, the latest snapshot stamped now and an older one from the day before.
test('codex: the rollout rate-limit snapshot becomes 5h/weekly usage window points', async () => {
  const home = tmp(), data = tmp(), events = [];
  const res = await runAgentCli({ agent: 'codex', bin: STUB, prompt: 'hi', cwd: tmp(), codexHome: home,
    env: { PATH: process.env.PATH, CODEX_STUB: 'ok', CODEX_STUB_HOME: home }, onEvent: (e) => events.push(e) });
  const want = [{ window: '5h', pct: 0, resetsAt: 1790361203 }, { window: 'weekly', pct: 17, resetsAt: 1790454622 }];
  assert.equal(res.outcome, 'ok');
  assert.deepEqual(res.windows, want); // the stale day-old snapshot (3% / 12%) is skipped
  assert.deepEqual(events.at(-1), { k: 'windows', windows: want });
  const log = createUsageLog(data);
  assert.equal(log.windows('codex', res.windows).length, 2);
  assert.equal(log.windows('codex', res.windows).length, 0); // unchanged readings are deduped
  const h = log.history('24h').agents.codex;
  assert.deepEqual(h.windows['5h'].map(({ t, ...p }) => p), [{ pct: 0, resetsAt: 1790361203 }]);
  assert.deepEqual(h.windows.weekly.map(({ t, ...p }) => p), [{ pct: 17, resetsAt: 1790454622 }]);
  assert.deepEqual(h.status.windows.weekly.pct, 17);
});

test('codex: a streamed token_count snapshot is used as is; a full window names the limit', async () => {
  const events = [], t0 = Date.now();
  const res = await runAgentCli({ agent: 'codex', bin: STUB, prompt: 'hi', cwd: tmp(), codexHome: tmp(),
    env: { PATH: process.env.PATH, CODEX_STUB: 'ok', CODEX_STUB_STREAM_LIMITS: '1' }, onEvent: (e) => events.push(e) });
  assert.equal(res.windows[0].window, '5h');
  assert.equal(res.windows[0].pct, 42.5);
  assert.ok(Math.abs(res.windows[0].resetsAt - (t0 / 1000 + 600)) < 5); // resets_in_seconds -> epoch s
  assert.deepEqual(res.windows[1], { window: 'weekly', pct: 7, resetsAt: 1790454622 });
  assert.equal(events.filter((e) => e.k === 'windows').length, 1);

  const home = tmp();
  const lim = await runAgentCli({ agent: 'codex', bin: STUB, prompt: 'hi', cwd: tmp(), codexHome: home, env: { PATH: process.env.PATH, CODEX_STUB: 'limit', CODEX_STUB_HOME: home } });
  assert.equal(lim.outcome, 'rate_limited');
  assert.equal(lim.limitType, '5h');
  assert.equal(lim.resetsAt, Date.parse('2030-01-01T00:00:00Z') / 1000); // 'try again at' wins over the snapshot
  assert.deepEqual(lim.windows[0], { window: '5h', pct: 100, resetsAt: 1790361203 });
  assert.deepEqual(codexWindows({ primary: { used_percent: 5, window_minutes: 60, resets_at: 1 }, secondary: { used_percent: 1, window_minutes: 45 } }),
    [{ window: '1h', pct: 5, resetsAt: 1 }, { window: '45m', pct: 1, resetsAt: null }]);
});

// #146: tool output, assistant text, retry notices and stderr quoting limit phrases are not a limit.
test('codex: limit phrases in tool output or assistant text are not a limit (false-positive regression)', async () => {
  const events = [];
  const ok = await runAgentCli({ agent: 'codex', bin: STUB, prompt: 'hi', cwd: tmp(), codexHome: tmp(),
    env: { PATH: process.env.PATH, CODEX_STUB: 'toolmention' }, onEvent: (e) => events.push(e) });
  assert.equal(ok.outcome, 'ok');
  assert.equal(ok.errorCode, null);
  assert.equal(ok.resetsAt, null);
  assert.ok(events.some((e) => e.k === 'tool_result' && /usage limit/.test(e.text)));
  assert.ok(!events.some((e) => e.k === 'limit'));
  const fail = await runAgentCli({ agent: 'codex', bin: STUB, prompt: 'hi', cwd: tmp(), codexHome: tmp(),
    env: { PATH: process.env.PATH, CODEX_STUB: 'toolfail' }, onEvent: (e) => events.push(e) });
  assert.equal(fail.outcome, 'error'); // a network failure, even though stderr and tool output say "usage limit"
  assert.notEqual(fail.errorCode, 'rate_limit');
  assert.ok(!events.some((e) => e.k === 'limit'));
});

// test/fixtures/codex-rollout-real-limit.jsonl: recorded from the rollout of a real 5h-limit hit (codex-cli 0.157.0,
// 2026-09-25): 97% and 99% snapshots, an assistant message mentioning usage limits, a windowless `premium` snapshot
// and the task_complete usage_limit_exceeded error.
const REAL = fileURLToPath(new URL('./fixtures/codex-rollout-real-limit.jsonl', import.meta.url));
test('codex: rollout snapshot parsing yields 5h and weekly windows with resets_at; windowless snapshots are skipped', () => {
  const s = codexRolloutState(REAL);
  assert.deepEqual(s.windows, [{ window: '5h', pct: 99, resetsAt: 1790385621 }, { window: 'weekly', pct: 32, resetsAt: 1790454622 }]);
  assert.equal(s.t, Date.parse('2026-09-25T20:58:59.343Z'));
  assert.equal(s.limit.resetsAt, Math.floor(new Date(2026, 8, 26, 1, 20).getTime() / 1000));
  assert.match(s.limit.message, /hit your usage limit/);
  // The newest rollout with a snapshot wins across threads.
  const home = tmp(), day = path.join(home, 'sessions/2026/09/25');
  fs.mkdirSync(day, { recursive: true });
  fs.copyFileSync(REAL, path.join(day, 'rollout-a.jsonl'));
  fs.writeFileSync(path.join(day, 'rollout-b.jsonl'), '{"type":"session_meta","payload":{}}\n'); // newer, no snapshot
  assert.deepEqual(codexLatestSnapshot(home).windows, s.windows);
  assert.equal(codexLatestSnapshot(tmp()), null);
});

test('codex: a real limit takes its reset from the error, else from the exhausted window snapshot', async () => {
  const home = tmp();
  const real = await runAgentCli({ agent: 'codex', bin: STUB, prompt: 'hi', cwd: tmp(), codexHome: home, env: { PATH: process.env.PATH, CODEX_STUB: 'limitreal', CODEX_STUB_HOME: home } });
  assert.equal(real.outcome, 'rate_limited');
  assert.equal(real.resetsAt, Math.floor(new Date(2026, 8, 26, 1, 20).getTime() / 1000)); // "try again at Sep 26th, 2026 1:20 AM"
  assert.equal(real.limitType, '5h');
  assert.deepEqual(real.windows.map((w) => w.window), ['5h', 'weekly']); // the later `premium` snapshot has no windows
  const home2 = tmp();
  const bare = await runAgentCli({ agent: 'codex', bin: STUB, prompt: 'hi', cwd: tmp(), codexHome: home2, env: { PATH: process.env.PATH, CODEX_STUB: 'limitbare', CODEX_STUB_HOME: home2 } });
  assert.equal(bare.outcome, 'rate_limited');
  assert.equal(bare.limitType, '5h');
  assert.equal(bare.resetsAt, 1790385621);
});

test('codex: resetsAt parsing handles clock times and missing hints', () => {
  assert.equal(codexResetsAt('or try again at Sep 26th, 2026 1:20 AM.'), Math.floor(new Date(2026, 8, 26, 1, 20).getTime() / 1000));
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

test('codex: background commands left by a clean run are killed (SIGKILL for ones ignoring SIGTERM)', async () => {
  const pids = path.join(tmp(), 'pids'), bin = fileURLToPath(new URL('./fixtures/bg-stub.mjs', import.meta.url));
  const t0 = Date.now();
  const res = await runAgentCli({ agent: 'codex', bin, prompt: 'hi', cwd: tmp(), env: { PATH: process.env.PATH, BG_STUB_PIDS: pids } });
  assert.equal(res.outcome, 'ok');
  assert.ok(Date.now() - t0 < 4000, 'the result waited for the SIGKILL timer');
  const { plain, stubborn } = JSON.parse(fs.readFileSync(pids, 'utf8'));
  for (let i = 0; i < 100 && alive(plain); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(!alive(plain), 'background sleep survived the run');
  for (let i = 0; i < 200 && alive(stubborn); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!alive(stubborn), 'SIGTERM-ignoring member survived the SIGKILL follow-up');
});

// ---- antigravity: runs test/fixtures/agy-stub.mjs, which prints recorded `agy --output-format stream-json` events.

const AGY = fileURLToPath(new URL('./fixtures/agy-stub.mjs', import.meta.url));
const noSettings = '/nonexistent/agy-settings.json';
const AGY_WINDOWS = [
  { window: 'gemini-weekly', pct: 0.13, resetsAt: Date.parse('2026-09-26T22:58:53Z') / 1000 },
  { window: 'gemini-5h', pct: 0, resetsAt: Date.parse('2026-09-25T18:36:12Z') / 1000 },
  { window: '3p-weekly', pct: 0, resetsAt: Date.parse('2026-10-02T13:36:12Z') / 1000 },
  { window: '3p-5h', pct: 0, resetsAt: Date.parse('2026-09-25T18:36:12Z') / 1000 },
];

test('antigravity: NDJSON events become normalised text/tool/result events; API vars are stripped', async () => {
  const dir = tmp(), log = path.join(dir, 'log.json'), events = [];
  const res = await runAgentCli({
    agent: 'antigravity', bin: AGY, model: 'gemini-3.8-flash-high', prompt: 'say hello', systemAppend: 'extra', cwd: dir, settingsPath: noSettings,
    env: { PATH: process.env.PATH, AGY_STUB: 'ok', AGY_STUB_LOG: log, GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'k', GOOGLE_GENAI_USE_VERTEXAI: '1',
      GOOGLE_APPLICATION_CREDENTIALS: '/c.json', GOOGLE_CLOUD_PROJECT: 'p', AGY_ADC_AUTH: '1' },
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(events.map(({ lines, ...e }) => e), [
    { k: 'text', text: 'Sure, looking' },
    { k: 'tool', id: '2', name: 'Bash', input: { command: 'echo hello' } },
    { k: 'tool_result', id: '2', text: 'hello\n', isError: false },
    { k: 'tool', id: '3', name: 'view_file', input: { file_path: '/x/a.js' } },
    { k: 'tool_result', id: '3', text: 'no such file', isError: true },
    { k: 'text', text: 'hello' },
    { k: 'result', usage: { input_tokens: 10418, output_tokens: 589, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 11007 } },
    { k: 'windows', windows: AGY_WINDOWS },
  ]);
  assert.equal(res.outcome, 'ok');
  assert.equal(res.text, 'hello');
  // The windows come from a follow-up `agy -p /usage` (the recorded agy-usage.jsonl), one 5h + weekly pair per model group.
  assert.deepEqual(res.windows, AGY_WINDOWS);
  assert.equal(res.sessionId, '3f0c9a2e-agy');
  assert.equal(res.numTurns, 1);
  assert.equal(res.usage.total_tokens, 11007);
  const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(dir));
  assert.deepEqual(seen.argv, ['-p', 'extra\n\nsay hello', '--output-format', 'stream-json', '--print-timeout', '0',
    '--model', 'gemini-3.8-flash-high', '--dangerously-skip-permissions']);
  // Billing stays on the Google account login: API-key / Vertex / ADC vars never reach the CLI.
  for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'AGY_ADC_AUTH']) assert.ok(!(k in seen.env), k);
  assert.equal(seen.env.AGY_STUB, 'ok');
});

test('antigravity: resume passes --conversation; non-autonomous drops the skip-permissions flag', async () => {
  const dir = tmp(), log = path.join(dir, 'log.json');
  const res = await runAgentCli({ agent: 'antigravity', bin: AGY, prompt: 'more', cwd: dir, resume: 'abc', autonomous: false, settingsPath: noSettings,
    env: { PATH: process.env.PATH, AGY_STUB: 'ok', AGY_STUB_LOG: log } });
  assert.equal(res.outcome, 'ok');
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')).argv, ['-p', 'more', '--output-format', 'stream-json', '--print-timeout', '0', '--conversation', 'abc']);
});

test('antigravity: a tool headless agy denied is reported, not a silent empty success', async () => {
  // Recorded live (2026-09-26, gemini-3.1-pro-high, autonomous: false): the denied run_command looks DONE with no output
  // and the turn ends SUCCESS with an empty response; only result.denied_actions says what happened.
  const events = [];
  const res = await runAgentCli({ agent: 'antigravity', bin: AGY, prompt: 'run echo', cwd: tmp(), autonomous: false,
    settingsPath: noSettings, usageProbe: false, env: { PATH: process.env.PATH, AGY_STUB: 'denied' }, onEvent: (e) => events.push(e) });
  assert.equal(res.outcome, 'ok');
  assert.match(res.text, /^Antigravity denied RunCommand without asking: .*--dangerously-skip-permissions/);
  assert.deepEqual(events.filter((e) => e.k === 'text').map((e) => e.text), [res.text]);
  assert.deepEqual(events.find((e) => e.k === 'tool'), { k: 'tool', id: '2', name: 'Bash', input: { command: 'echo DENY_PROBE_42' } });
});

test('antigravity: recorded file tools retain paths, native errors and successful reads', async () => {
  // Live read-only control: absent file followed by an existing file (2026-09-25).
  const events = [];
  const res = await runAgentCli({ agent: 'antigravity', bin: AGY, prompt: 'read files', cwd: tmp(),
    settingsPath: noSettings, usageProbe: false, env: { PATH: process.env.PATH, AGY_STUB: 'file-tools' },
    onEvent: (e) => events.push(e) });
  assert.equal(res.outcome, 'ok'); // a recoverable tool error does not fail the turn
  assert.deepEqual(events.filter((e) => e.k === 'tool'), [
    { k: 'tool', id: '2', name: 'view_file', input: { file_path: '/workspace/missing.txt' } },
    { k: 'tool', id: '4', name: 'view_file', input: { file_path: '/workspace/present.txt' } },
  ]);
  const results = events.filter((e) => e.k === 'tool_result');
  assert.equal(results.length, 2);
  assert.equal(results[0].id, '2');
  assert.equal(results[0].isError, true);
  assert.deepEqual(JSON.parse(results[0].text), {
    type: 'TOOL_ERROR',
    message: 'declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) failed to read file: stat /workspace/missing.txt: no such file or directory',
  });
  assert.deepEqual(results[1], { k: 'tool_result', id: '4', text: '2 lines, 24 bytes', isError: false, lines: 1 });
  assert.match(res.text, /ANTIGRAVITY_READ_OK_134/);
});

test('antigravity: recorded write/edit tools keep their TargetFile path; search tools keep theirs', async () => {
  // Live gemini-3.1-pro-high run (2026-09-26, #148): write_to_file and replace_file_content only carry TargetFile.
  const events = [];
  const res = await runAgentCli({ agent: 'antigravity', bin: AGY, prompt: 'edit', cwd: tmp(), settingsPath: noSettings, usageProbe: false,
    env: { PATH: process.env.PATH, AGY_STUB: 'edit-tools' }, onEvent: (e) => events.push(e) });
  assert.equal(res.outcome, 'ok');
  assert.deepEqual(events.filter((e) => e.k === 'tool'), [
    { k: 'tool', id: '4', name: 'write_to_file', input: { file_path: '/workspace/notes/new.txt' } },
    { k: 'tool', id: '5', name: 'replace_file_content', input: { file_path: '/workspace/math.mjs' } },
  ]);
  assert.deepEqual(events.filter((e) => e.k === 'tool_result').map((e) => [e.id, e.isError]), [['4', false], ['5', false]]);
  const tool = (tool_name, parameters) => [...AGENTS.antigravity.events({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name, tool_info: { parameters } } })][0].input;
  assert.deepEqual(tool('grep_search', { SearchPath: '/w/src', Query: 'export', IsRegex: false }), { path: '/w/src', query: 'export' });
  assert.deepEqual(tool('find_by_name', { SearchDirectory: '/w', Pattern: '*.mjs' }), { path: '/w', pattern: '*.mjs' });
  assert.deepEqual(tool('list_dir', { DirectoryPath: '/w' }), { path: '/w' });
});

test('antigravity: resuming a missing conversation is errorCode no_session', async () => {
  const res = await runAgentCli({ agent: 'antigravity', bin: AGY, prompt: 'more', cwd: tmp(), resume: '9', settingsPath: noSettings,
    env: { PATH: process.env.PATH, AGY_STUB: 'nosession' } });
  assert.equal(res.outcome, 'error');
  assert.equal(res.errorCode, 'no_session');
  assert.ok(isMissingSession(res));
});

test('antigravity: a RESOURCE_EXHAUSTED result is rate_limited with resetsAt', async () => {
  const events = [];
  const res = await runAgentCli({ agent: 'antigravity', bin: AGY, prompt: 'hi', cwd: tmp(), settingsPath: noSettings,
    env: { PATH: process.env.PATH, AGY_STUB: 'limit' }, onEvent: (e) => events.push(e) });
  const reset = Date.parse('2030-01-01T00:00:00Z') / 1000;
  assert.equal(res.outcome, 'rate_limited');
  assert.equal(res.errorCode, 'rate_limit');
  assert.equal(res.resetsAt, reset);
  assert.match(res.text, /RESOURCE_EXHAUSTED/);
  assert.deepEqual(events, [{ k: 'limit', resetsAt: reset }, { k: 'windows', windows: AGY_WINDOWS }]);
  assert.equal(res.limitType, null); // no bucket is empty in the recorded /usage
});

test('antigravity: an empty /usage bucket names the limit window; usageProbe false skips the probe', async () => {
  const res = await runAgentCli({ agent: 'antigravity', bin: AGY, prompt: 'hi', cwd: tmp(), settingsPath: noSettings,
    env: { PATH: process.env.PATH, AGY_STUB: 'limit', AGY_STUB_USAGE: 'exhausted' } });
  assert.equal(res.outcome, 'rate_limited');
  assert.equal(res.limitType, 'gemini-5h');
  assert.equal(res.resetsAt, Date.parse('2030-01-01T00:00:00Z') / 1000); // the error's own hint wins
  assert.deepEqual(res.windows.find((w) => w.window === 'gemini-5h'), { window: 'gemini-5h', pct: 100, resetsAt: Date.parse('2026-09-25T18:36:12Z') / 1000 });
  const off = await runAgentCli({ agent: 'antigravity', bin: AGY, prompt: 'hi', cwd: tmp(), settingsPath: noSettings, usageProbe: false,
    env: { PATH: process.env.PATH, AGY_STUB: 'ok' } });
  assert.equal(off.outcome, 'ok');
  assert.equal(off.windows, null);
});

test('antigravity: stderr mentioning quota does not make a failed run a limit', async () => {
  const res = await runAgentCli({ agent: 'antigravity', bin: AGY, prompt: 'hi', cwd: tmp(), settingsPath: noSettings,
    env: { PATH: process.env.PATH, AGY_STUB: 'quota-log' } });
  assert.equal(res.outcome, 'error');
  assert.equal(res.resetsAt, null);
});

test('antigravity: a signed-out CLI waiting on OAuth is killed at once as auth_error', async () => {
  const t0 = Date.now();
  const res = await runAgentCli({ agent: 'antigravity', bin: AGY, prompt: 'hi', cwd: tmp(), settingsPath: noSettings, env: { PATH: process.env.PATH, AGY_STUB: 'auth' } });
  assert.equal(res.outcome, 'auth_error');
  assert.equal(res.errorCode, 'authentication_failed');
  assert.ok(Date.now() - t0 < 5000);
});

test('antigravity: API-key mode in settings.json is refused without spawning', async () => {
  const dir = tmp(), settingsPath = path.join(dir, 'settings.json'), log = path.join(dir, 'log.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ modelProvider: 'gemini' }));
  const res = await runAgentCli({ agent: 'antigravity', bin: AGY, prompt: 'hi', cwd: dir, settingsPath, env: { PATH: process.env.PATH, AGY_STUB: 'ok', AGY_STUB_LOG: log } });
  assert.equal(res.outcome, 'auth_error');
  assert.match(res.text, /API-key mode/);
  assert.ok(!fs.existsSync(log));
});

test('antigravity: abort kills the process group and ends with outcome aborted', async () => {
  const dir = tmp(), pids = path.join(dir, 'pids'), ac = new AbortController();
  const res = await runAgentCli({ agent: 'antigravity', bin: AGY, prompt: 'hi', cwd: dir, signal: ac.signal, settingsPath: noSettings,
    env: { PATH: process.env.PATH, AGY_STUB: 'hang', AGY_STUB_PIDS: pids }, onEvent: (e) => { if (e.k === 'tool') ac.abort(); } });
  assert.equal(res.outcome, 'aborted');
  const g = Number(fs.readFileSync(pids, 'utf8'));
  for (let i = 0; i < 50 && alive(g); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(!alive(g), 'grandchild survived the abort');
});
