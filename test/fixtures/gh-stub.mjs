#!/usr/bin/env node
// Stand-in for the GitHub CLI (`gh`); tests link it as `gh` on PATH. Signed in as `tester`, every repo name is free.
// `repo create` appends its argv to GH_STUB_LOG, waits a moment (so concurrent callers overlap) and adds `origin`.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const [a, b] = process.argv.slice(2);
if (a === 'api' && b === 'user') { process.stdout.write('tester\n'); process.exit(0); }
if (a === 'auth') process.exit(0);
if (a === 'repo' && b === 'view') { process.stderr.write('Could not resolve to a Repository\n'); process.exit(1); }
if (a === 'repo' && b === 'create') {
  const name = process.argv[4];
  if (process.env.GH_STUB_LOG) fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
  await new Promise((r) => setTimeout(r, 300));
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/tester/${name}.git`]);
  process.exit(0);
}
process.stderr.write(`gh-stub: unsupported ${process.argv.slice(2).join(' ')}\n`);
process.exit(1);
