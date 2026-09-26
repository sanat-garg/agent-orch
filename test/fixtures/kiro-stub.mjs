#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
if (process.env.KIRO_STUB_LOG) fs.writeFileSync(process.env.KIRO_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
if (process.argv[2] === 'chat' && process.argv.includes('--list-models')) {
  process.stdout.write('{"models":[{"model_id":"discovered-model","model_name":"Discovered Model"}],"default_model":"discovered-model"}');
} else if (process.env.KIRO_STUB === 'hang') {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.KIRO_STUB_PIDS, String(child.pid));
  setInterval(() => {}, 1000);
} else if (process.env.KIRO_STUB === 'missing') {
  process.stdout.write('{"type":"error","error":{"message":"session not found"}}\n');
  process.exitCode = 1;
} else if (process.env.KIRO_STUB === 'signedout') {
  process.stderr.write(fs.readFileSync(new URL('./kiro-signedout.stderr', import.meta.url), 'utf8'));
  process.exitCode = 1;
} else {
  let output = fs.readFileSync(new URL(`./kiro-${process.env.KIRO_STUB === 'limit' ? 'limit' : 'success'}.jsonl`, import.meta.url), 'utf8');
  if (process.env.KIRO_STUB === 'toolmention') output = output.replace('hello\\n', 'usage limit 429\\n');
  process.stdout.write(output);
  if (process.env.KIRO_STUB === 'limit') process.exitCode = 1;
}
