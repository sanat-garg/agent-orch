#!/usr/bin/env node
// Stand-in for `codex exec --json`: prints recorded JSONL events and never touches the network.
// CODEX_STUB=ok|limit|limitreal|limitbare|toolmention|toolfail|auth|hang|nosession picks the script; CODEX_STUB_LOG, if set, receives {argv, env, cwd} as JSON.
// `login status` answers like the real CLI: logged in unless CODEX_STUB_LOGIN=out. `debug models` prints a catalog.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

if (process.argv[2] === '--version') { process.stdout.write('codex-cli 0.157.0\n'); process.exit(0); }
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  if (process.env.CODEX_STUB_LOGIN === 'out') { process.stderr.write('Not logged in\n'); process.exit(1); }
  process.stderr.write('Logged in using ChatGPT\n');
  process.exit(0);
}

// `debug models`: a trimmed catalog recorded from codex-cli 0.157.0 (codex-models.json); CODEX_STUB_MODELS=fail errors out,
// =wide adds two more listed models (for UI tests that need several fallbacks).
if (process.argv[2] === 'debug' && process.argv[3] === 'models') {
  if (process.env.CODEX_STUB_MODELS === 'fail') { process.stderr.write('Error: failed to refresh the model catalog: 503 Service Unavailable\n'); process.exit(1); }
  const catalog = JSON.parse(fs.readFileSync(new URL('./codex-models.json', import.meta.url), 'utf8'));
  if (process.env.CODEX_STUB_MODELS === 'wide') catalog.models.push({ slug: 'gpt-6-nova', display_name: 'GPT-6-Nova', visibility: 'list', priority: 4 },
    { slug: 'gpt-6-lumen', display_name: 'GPT-6-Lumen', visibility: 'list', priority: 5 });
  process.stdout.write(JSON.stringify(catalog));
  process.exit(0);
}

if (process.env.CODEX_STUB_LOG) fs.writeFileSync(process.env.CODEX_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const mode = process.env.CODEX_STUB || 'ok';

if (mode === 'nosession') {
  // What the real CLI prints when `exec resume <id>` names a thread with no rollout on disk.
  process.stderr.write(`Error: thread/resume failed: no rollout found for thread id ${process.argv.at(-2)}\n`);
  process.exit(1);
}
const tid = '01a0d699-1efd-7d72-b9f4-2616f4bf739a';
// CODEX_STUB_HOME: write the thread's rollout (recorded token_count rate-limit snapshots, the latest stamped now),
// as the real CLI does in ~/.codex/sessions; CODEX_STUB_STREAM_LIMITS: also stream a token_count event.
if (process.env.CODEX_STUB_HOME) {
  const dir = `${process.env.CODEX_STUB_HOME}/sessions/2026/09/25`;
  // limitreal/limitbare: a real rollout that hit the 5h limit (codex-rollout-real-limit.jsonl), every line stamped now.
  const real = mode === 'limitreal' || mode === 'limitbare';
  const src = new URL(`./codex-rollout${real ? '-real-limit' : mode === 'limit' ? '-limit' : ''}.jsonl`, import.meta.url);
  let text = fs.readFileSync(src, 'utf8').replace('__NOW__', new Date().toISOString());
  if (real) text = text.replace(/"timestamp":"[^"]+"/g, `"timestamp":"${new Date().toISOString()}"`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/rollout-2026-09-25T13-33-21-${tid}.jsonl`, text);
}
out({ type: 'thread.started', thread_id: tid });
if (process.env.CODEX_STUB_STREAM_LIMITS) out({ type: 'token_count', info: null,
  rate_limits: { primary: { used_percent: 42.5, window_minutes: 300, resets_in_seconds: 600 }, secondary: { used_percent: 7, window_minutes: 10080, resets_at: 1790454622 } } });
out({ type: 'turn.started' });
if (mode === 'ok') {
  process.stderr.write('Reading prompt...\n');
  out({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' });
  out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Scanning the repo**' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Looking' } });
  out({ type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'bash -lc ls', aggregated_output: '', exit_code: null, status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'bash -lc ls', aggregated_output: 'README.md\nsrc\n', exit_code: 0, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: 'src/a.js', kind: 'update' }], status: 'completed' } });
  out({ type: 'item.updated', item: { id: 'item_4', type: 'todo_list', items: [{ text: 'write tests', completed: false }] } });
  // A partial line split across writes must still parse.
  const last = JSON.stringify({ type: 'item.completed', item: { id: 'item_5', type: 'agent_message', text: 'Done. I added the tests.' } });
  process.stdout.write(last.slice(0, 20));
  setTimeout(() => {
    process.stdout.write(last.slice(20) + '\n');
    out({ type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 64 } });
  }, 20);
} else if (mode === 'limit') {
  const msg = "You've hit your usage limit. Upgrade to Pro or try again at 2030-01-01T00:00:00Z.";
  out({ type: 'error', message: msg });
  out({ type: 'turn.failed', error: { message: msg } });
  process.exitCode = 1;
} else if (mode === 'limitreal' || mode === 'limitbare') {
  // The message codex-cli 0.157.0 recorded on 2026-09-25 (limitbare: without the 'try again at' hint).
  const msg = mode === 'limitreal'
    ? 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 26th, 2026 1:20 AM.'
    : 'You’ve hit your usage limit.';
  out({ type: 'error', message: msg });
  out({ type: 'turn.failed', error: { message: msg } });
  process.exitCode = 1;
} else if (mode === 'toolmention' || mode === 'toolfail') {
  // Tool output and assistant text quoting limit phrases (the agent read .agent-orch/AGENTS.md and agents.mjs).
  const quoted = "- Adapter rule: match `/usage limit|usage_limit_reached|quota_exceeded|429|rate limit/i` in `turn.failed`\n  contains **`You've hit your usage limit`**, internal codes `usage_limit_reached`, `quota_exceeded`\n";
  process.stderr.write(quoted);
  out({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: 429 Too Many Requests; rate limit)' });
  out({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: "bash -lc 'grep -n usage .agent-orch/AGENTS.md'", status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: "bash -lc 'grep -n usage .agent-orch/AGENTS.md'", aggregated_output: quoted, exit_code: 0, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: "The adapter treats \"You've hit your usage limit\" (usage_limit_reached, 429) as a rate limit." } });
  if (mode === 'toolmention') out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } });
  else {
    out({ type: 'error', message: 'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)' });
    out({ type: 'turn.failed', error: { message: 'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)' } });
    process.exitCode = 1;
  }
} else if (mode === 'auth') {
  out({ type: 'error', message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' });
  out({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } });
  process.exitCode = 1;
} else if (mode === 'hang') {
  // A grandchild in the same process group: aborting must kill it too.
  const g = spawn('sleep', ['300'], { stdio: 'ignore' });
  if (process.env.CODEX_STUB_PIDS) fs.writeFileSync(process.env.CODEX_STUB_PIDS, String(g.pid));
  out({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'sleep 300', status: 'in_progress' } });
  setInterval(() => {}, 1000);
}
