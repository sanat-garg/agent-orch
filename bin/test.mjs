// npm test: only the test files this checkout's changes can affect (bin/test-select.mjs).
//   npm test                     affected by the diff from the main branch's merge-base (uncommitted and untracked included)
//   npm run test:full            every test file (also AGENT_ORCH_TEST_ALL=1, or `npm test -- --all`)
//   npm test -- test/x.test.mjs  just these files
//   npm test -- --list           print the selection without running it
// Owns every temporary fixture for the run, including leftovers from failed setup hooks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { selectTests, checkoutChanges, readIn, isTest } from './test-select.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const named = argv.filter((a) => !a.startsWith('--'));
const all = argv.includes('--all') || !!process.env.AGENT_ORCH_TEST_ALL;

let files;
let why;
if (named.length) [files, why] = [named, 'named on the command line'];
else if (!all) {
  const co = checkoutChanges(root);
  const pick = co && co.changed.length ? selectTests({ files: co.files, read: readIn(root), changed: co.changed }) : null;
  if (!co) why = 'every file (no main branch to diff against)';
  else if (!co.changed.length) why = 'every file (nothing changed since the main branch)';
  else if (pick.all) why = `every file (${pick.why})`;
  else {
    files = pick.tests;
    const shown = pick.changed.slice(0, 8).join(', ') + (pick.changed.length > 8 ? `, +${pick.changed.length - 8} more` : '');
    why = pick.changed.length ? `affected by ${shown}` : `no code changed (only ${co.changed.slice(0, 5).join(', ')})`;
    if (pick.deferred.length) why += `; ${pick.deferred.length} browser test files left to the full suite`;
  }
}
const total = fs.readdirSync(path.join(root, 'test'), { recursive: true }).filter((f) => isTest(`test/${f}`)).length;
files ??= ['test/**/*.test.mjs'];
const count = files[0] === 'test/**/*.test.mjs' ? total : files.length;
console.log(`npm test: ${count} of ${total} test files, ${why}.${count < total ? ' `npm run test:full` runs them all.' : ''}`);
if (listOnly) { if (count < total) console.log(files.join('\n')); process.exit(0); }
if (!count) process.exit(0);

// One file at a time by default: on 1 core the suite is mostly CPU-bound, and parallel files flaked timing-sensitive tests.
const concurrency = Number(process.env.AGENT_ORCH_TEST_CONCURRENCY) || 1;
const cache = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(cache, { recursive: true });
const temp = fs.mkdtempSync(path.join(cache, 'agent-orch-test-'));
// One suite at a time per machine (several sessions share this 1-core box), at low CPU priority so the live server and
// chats stay responsive. flock waits for the lock; AGENT_ORCH_TEST_NOLOCK=1 skips it.
const lock = path.join(cache, 'agent-orch-test.lock');
const cmd = [process.execPath, '--test', `--test-concurrency=${concurrency}`, ...files];
const [bin, ...args] = process.env.AGENT_ORCH_TEST_NOLOCK ? ['nice', '-n', '10', ...cmd] : ['flock', lock, 'nice', '-n', '10', ...cmd];
// Ample memory: scheduling tests stay deterministic on a busy server (memory-guard tests point at their own file).
const child = spawn(bin, args, {
  cwd: root, stdio: 'inherit', detached: true, // its own process group, so a signal reaches node past flock and nice
  env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, AGENT_ORCH_MEMINFO: path.join(root, 'test/fixtures/meminfo-ample') },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { try { process.kill(-child.pid, signal); } catch {} });
child.on('error', (error) => { console.error(error); });
child.on('close', (code) => {
  fs.rmSync(temp, { recursive: true, force: true });
  process.exitCode = code ?? 1;
});
