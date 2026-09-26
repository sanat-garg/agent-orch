#!/usr/bin/env node
// A misbehaving helper CLI: ignores SIGTERM and forks a long-lived child that ignores it too (argv[2] is a marker the
// tests find in /proc). Modes (argv[3]): hang (default) | exit (prints, exits 0, leaves the child) | child;
// and `models` as argv[2] (counts spawns in TREE_STUB_COUNT, then prints one free Zen model like `opencode models --verbose`).
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [marker, mode = 'hang'] = process.argv.slice(2);
process.on('SIGTERM', () => {});
if (marker === 'models') {
  fs.appendFileSync(process.env.TREE_STUB_COUNT, 'x\n');
  const cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
  setTimeout(() => process.stdout.write(`opencode/big-pickle\n${JSON.stringify({ id: 'big-pickle', providerID: 'opencode', name: 'Big Pickle', cost }, null, 2)}\n`), 300);
} else if (mode === 'child') {
  setInterval(() => {}, 1000);
} else {
  spawn(process.execPath, [fileURLToPath(import.meta.url), marker, 'child'], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (mode === 'exit') setTimeout(() => { process.stdout.write('done\n'); process.exit(0); }, 500); // once the child ignores SIGTERM
  setInterval(() => {}, 1000);
}
