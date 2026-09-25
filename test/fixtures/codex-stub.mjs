#!/usr/bin/env node
// Stand-in for `codex exec --json`: prints recorded JSONL events and never touches the network.
// CODEX_STUB=ok|limit|hang picks the script; CODEX_STUB_LOG, if set, receives {argv, env, cwd} as JSON.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

if (process.env.CODEX_STUB_LOG) fs.writeFileSync(process.env.CODEX_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const mode = process.env.CODEX_STUB || 'ok';

out({ type: 'thread.started', thread_id: '01a0d699-1efd-7d72-b9f4-2616f4bf739a' });
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
} else if (mode === 'hang') {
  // A grandchild in the same process group: aborting must kill it too.
  const g = spawn('sleep', ['300'], { stdio: 'ignore' });
  if (process.env.CODEX_STUB_PIDS) fs.writeFileSync(process.env.CODEX_STUB_PIDS, String(g.pid));
  out({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'sleep 300', status: 'in_progress' } });
  setInterval(() => {}, 1000);
}
