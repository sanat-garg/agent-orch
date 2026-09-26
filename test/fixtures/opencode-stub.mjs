#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
if (process.env.OPENCODE_STUB_LOG) fs.writeFileSync(process.env.OPENCODE_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
if (process.argv[2] === 'models') { process.stdout.write('openai/gpt-5.4\nopenai/gpt-5.3-codex\n'); process.exit(0); }
const mode = process.env.OPENCODE_STUB || 'success';
if (mode === 'hang') {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.OPENCODE_STUB_PIDS, String(child.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'missing') {
  process.stdout.write(JSON.stringify({ type: 'error', error: { name: 'NotFoundError', data: { message: 'session not found' } } }) + '\n');
  process.exitCode = 1;
} else if (mode === 'toolmention') {
  const lines = fs.readFileSync(new URL('./opencode-success.jsonl', import.meta.url), 'utf8').replace('hello\\n', 'usage limit 429\\n');
  process.stdout.write(lines);
} else {
  process.stdout.write(fs.readFileSync(new URL(`./opencode-${mode}.jsonl`, import.meta.url), 'utf8'));
  if (mode === 'limit' || mode === 'signedout') process.exitCode = 1;
}
