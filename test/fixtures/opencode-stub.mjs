#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
if (process.env.OPENCODE_STUB_LOG) fs.writeFileSync(process.env.OPENCODE_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
if (process.argv[2] === 'models') {
  // `--verbose`: each id line is followed by its JSON (a recorded shape); OPENCODE_STUB_MODELS=zen lists Zen only.
  const cost = (n) => ({ input: n, output: n * 5, cache: { read: 0, write: 0 } });
  const all = [['openai/gpt-5.4', 'GPT-5.4', cost(1.25)], ['openai/gpt-5.3-codex', 'GPT-5.3 Codex', cost(1.25)],
    ['opencode/big-pickle', 'Big Pickle', cost(0)], ['opencode/nemotron-3-ultra-free', 'Nemotron 3 Ultra Free', cost(0)],
    ['opencode/claude-opus-4-5', 'Claude Opus 4.5', cost(5)]].filter(([id]) => process.env.OPENCODE_STUB_MODELS !== 'zen' || id.startsWith('opencode/'));
  process.stdout.write(all.map(([id, name, c]) => (process.argv.includes('--verbose')
    ? `${id}\n${JSON.stringify({ id: id.split('/')[1], providerID: id.split('/')[0], name, cost: c }, null, 2)}\n` : `${id}\n`)).join(''));
  process.exit(0);
}
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
