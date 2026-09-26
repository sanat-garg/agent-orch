#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.COPILOT_STUB || 'success';
if (process.env.COPILOT_STUB_LOG) fs.writeFileSync(process.env.COPILOT_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
if (mode === 'hang') {
  const child = spawn('sleep', ['60']);
  fs.writeFileSync(process.env.COPILOT_STUB_PIDS, String(child.pid));
  setInterval(() => {}, 1000);
} else {
  const file = mode === 'limit' ? 'copilot-limit.jsonl' : 'copilot-success.jsonl';
  let body = fs.readFileSync(path.join(dir, file), 'utf8');
  if (mode === 'toolmention') body = body.replace('hello\\n', '429 rate limit reached\\n');
  if (mode === 'missing') body = JSON.stringify({ type: 'error', data: { error: { code: 'session_not_found', message: 'Session not found' } } }) + '\n' + JSON.stringify({ type: 'result', exitCode: 1 }) + '\n';
  process.stdout.write(body);
  process.exit(mode === 'limit' || mode === 'missing' ? 1 : 0);
}
