#!/usr/bin/env node
// Stand-in `codex` for the worker e2e test: signed in, lists the recorded model catalog, and `exec` edits a file in its
// cwd (hello.txt) while printing `codex exec --json` events. A prompt containing SLOW takes 60 s to finish (pause/cancel tests).
import fs from 'node:fs';

const [cmd, sub] = process.argv.slice(2);
if (cmd === '--version') { process.stdout.write('codex-cli 0.157.0\n'); process.exit(0); }
if (cmd === 'login' && sub === 'status') { process.stderr.write('Logged in using ChatGPT\n'); process.exit(0); }
if (cmd === 'debug' && sub === 'models') { process.stdout.write(fs.readFileSync(new URL('./codex-models.json', import.meta.url))); process.exit(0); }
if (cmd !== 'exec') { process.stderr.write(`unexpected: ${process.argv.slice(2).join(' ')}\n`); process.exit(2); }

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const prompt = process.argv.at(-1);
out({ type: 'thread.started', thread_id: '01a0d699-1efd-7d72-b9f4-000000000218' });
out({ type: 'turn.started' });
out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: `Working on: ${prompt.slice(0, 60)}` } });
fs.writeFileSync('hello.txt', 'hello from the stub agent\n');
out({ type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [{ path: 'hello.txt', kind: 'add' }], status: 'completed' } });
setTimeout(() => {
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Done. AGENT-ORCH-STATUS: done — hello.txt added' } });
  out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } });
}, prompt.includes('SLOW') ? 60_000 : 10);
