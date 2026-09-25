#!/usr/bin/env node
// Stand-in for `agy -p … --output-format stream-json`: prints recorded NDJSON events and never touches the network.
// AGY_STUB=ok|limit|quota-log|auth|hang|nosession picks the script; AGY_STUB_LOG, if set, receives {argv, env, cwd} as JSON.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

// `agy -p /usage`: the recorded command_result (agy-usage.jsonl); AGY_STUB_USAGE=exhausted empties the Gemini 5h bucket.
if (process.argv[3] === '/usage') {
  let text = fs.readFileSync(new URL('./agy-usage.jsonl', import.meta.url), 'utf8');
  if (process.env.AGY_STUB_USAGE === 'exhausted') text = text.replace(/("id":"gemini-5h"[^}]*"remaining_fraction":)[\d.]+/g, '$10');
  process.stdout.write(text);
  process.exit(0);
}
// `agy models`, as recorded from agy 1.2.11: progress on stderr, `<id>\t<name>` lines on stdout; AGY_STUB_LOGIN=out
// answers like a signed-out CLI.
if (process.argv[2] === 'models') {
  process.stderr.write('Fetching available models...\n');
  if (process.env.AGY_STUB_LOGIN === 'out') { process.stderr.write('Error: Please sign in to view available models.\n'); process.exit(1); }
  process.stdout.write('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n');
  process.exit(0);
}
if (process.env.AGY_STUB_LOG) fs.writeFileSync(process.env.AGY_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const mode = process.env.AGY_STUB || 'ok';
const cid = '3f0c9a2e-agy';
const step = (o) => out({ event: 'step_update', step_update: { conversation_id: cid, ...o } });

if (mode === 'nosession') {
  out({ event: 'result', result: { status: 'ERROR', error: 'conversation 9 not found' } });
  process.exitCode = 1;
} else if (mode === 'auth') {
  // Signed out: agy prints an OAuth URL and blocks waiting for a pasted code.
  process.stderr.write('Please visit https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=https://antigravity.google/oauth-callback\n');
  process.stderr.write('Waiting for authentication (timeout 60s)...\n');
  setInterval(() => {}, 1000);
} else {
  out({ event: 'init', conversation_id: cid, init: { cwd: process.cwd(), tools: ['run_command', 'view_file'], permission_mode: 'request-review', model: 'gemini-3.8-flash-high' } });
  if (mode === 'ok') {
    step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Sure, ' });
    step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'looking' });
    step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hello' } } });
    step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hello' }, output: 'hello\n' },
      duration_seconds: 1.5, usage: { input_tokens: 100, output_tokens: 50, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 150 } });
    step({ step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { FilePath: '/x/a.js' }, error: 'no such file' } });
    // A partial line split across writes must still parse.
    const last = JSON.stringify({ event: 'step_update', step_update: { conversation_id: cid, step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'hello' } });
    process.stdout.write(last.slice(0, 20));
    setTimeout(() => {
      process.stdout.write(last.slice(20) + '\n');
      out({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: 'hello', duration_seconds: 6.88, num_turns: 1,
        usage: { input_tokens: 10418, output_tokens: 589, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 11007 } } });
    }, 20);
  } else if (mode === 'limit') {
    const error = 'RESOURCE_EXHAUSTED: You have exhausted your quota. Try again at 2030-01-01T00:00:00Z.';
    process.stderr.write(`Error: ${error}\n`);
    out({ event: 'result', result: { conversation_id: cid, status: 'ERROR', error, duration_seconds: 0.4, num_turns: 0 } });
    process.exitCode = 1;
  } else if (mode === 'quota-log') {
    // A plain failure whose log mentions quota: not a usage limit.
    process.stderr.write('checking quota project settings...\n');
    out({ event: 'result', result: { conversation_id: cid, status: 'ERROR', error: 'tool run_command failed: exit status 2', duration_seconds: 0.4, num_turns: 1 } });
    process.exitCode = 1;
  } else if (mode === 'hang') {
    // A grandchild in the same process group: aborting must kill it too.
    const g = spawn('sleep', ['300'], { stdio: 'ignore' });
    if (process.env.AGY_STUB_PIDS) fs.writeFileSync(process.env.AGY_STUB_PIDS, String(g.pid));
    step({ step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 300' } } });
    setInterval(() => {}, 1000);
  }
}
