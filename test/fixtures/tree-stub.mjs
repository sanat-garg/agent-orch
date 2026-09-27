#!/usr/bin/env node
// A misbehaving helper CLI: ignores SIGTERM and forks a long-lived child that ignores it too (argv[2] is a marker the
// tests find in /proc). Modes (argv[3]): hang (default) | exit (prints, exits 0, leaves the child) | child;
// and a stand-in `codex`: `login status` answers signed in; `debug models` counts spawns in TREE_STUB_COUNT, then prints
// a one-model catalog like the real CLI.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [marker, mode = 'hang'] = process.argv.slice(2);
process.on('SIGTERM', () => {});
if (marker === 'login' && mode === 'status') {
  process.stderr.write('Logged in using ChatGPT\n');
  process.exit(0);
} else if (marker === 'debug' && mode === 'models') {
  fs.appendFileSync(process.env.TREE_STUB_COUNT, 'x\n');
  setTimeout(() => { process.stdout.write(JSON.stringify({ models: [{ slug: 'gpt-x', display_name: 'GPT X', visibility: 'list', priority: 1 }] })); process.exit(0); }, 300);
} else if (mode === 'child') {
  setInterval(() => {}, 1000);
} else {
  spawn(process.execPath, [fileURLToPath(import.meta.url), marker, 'child'], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (mode === 'exit') setTimeout(() => { process.stdout.write('done\n'); process.exit(0); }, 500); // once the child ignores SIGTERM
  setInterval(() => {}, 1000);
}
