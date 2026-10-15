#!/usr/bin/env node
// Stand-in for the GitHub CLI (`gh`); tests link it as `gh` on PATH. Signed in as `tester`, every repo name is free.
// `repo create` appends its argv (and GH_CONFIG_DIR, when set) to GH_STUB_LOG, waits a moment (so concurrent callers
// overlap) and adds `origin` under the signed-in login. A user's sign-in (github-users.mjs) lives in GH_CONFIG_DIR:
// `auth login --with-token` stores the token from stdin (`ghp_<login>_…` signs in as <login>; one starting `bad` is
// refused), and `api user` / `auth git-credential get` answer from it. `repo clone <full> <dir> -- <git args>` clones
// GH_STUB_REMOTE (a local repo) with those git args.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [a, b] = process.argv.slice(2);
const store = process.env.GH_CONFIG_DIR && path.join(process.env.GH_CONFIG_DIR, 'stub-token');
const token = () => { try { return fs.readFileSync(store, 'utf8').trim(); } catch { return null; } };
const login = () => (store ? token()?.split('_')[1] || null : 'tester');
if (a === 'api' && b === 'user') {
  if (!login()) { process.stderr.write('gh: To get started with GitHub CLI, please run:  gh auth login\n'); process.exit(4); }
  process.stdout.write(`${login()}\n`); process.exit(0);
}
if (a === 'auth' && b === 'login' && process.argv.includes('--with-token')) {
  const t = fs.readFileSync(0, 'utf8').trim();
  if (t.startsWith('bad')) { process.stderr.write("error validating token: missing required scope 'read:org'\n"); process.exit(1); }
  fs.writeFileSync(store, t);
  process.exit(0);
}
if (a === 'auth' && b === 'git-credential') {
  if (process.argv[4] === 'get' && token()) process.stdout.write(`protocol=https\nhost=github.com\nusername=${login()}\npassword=${token()}\n`);
  process.exit(0);
}
if (a === 'auth') process.exit(0);
if (a === 'repo' && b === 'view') { process.stderr.write('Could not resolve to a Repository\n'); process.exit(1); }
if (a === 'repo' && b === 'create') {
  const name = process.argv[4];
  if (process.env.GH_STUB_LOG) fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify([...process.argv.slice(2), ...(process.env.GH_CONFIG_DIR ? [process.env.GH_CONFIG_DIR] : [])]) + '\n');
  await new Promise((r) => setTimeout(r, 300));
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${login()}/${name}.git`]);
  process.exit(0);
}
if (a === 'repo' && b === 'clone') {
  const [, , , dir, , ...extra] = process.argv.slice(2);
  execFileSync('git', ['clone', ...extra, process.env.GH_STUB_REMOTE, dir], { stdio: 'inherit' });
  process.exit(0);
}
process.stderr.write(`gh-stub: unsupported ${process.argv.slice(2).join(' ')}\n`);
process.exit(1);
