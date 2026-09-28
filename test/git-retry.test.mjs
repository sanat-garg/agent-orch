import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transientGit, retryGit } from '../taskrun.mjs';

const gitError = (stderr) => Object.assign(new Error(`Command failed: git\n${stderr}`), { stderr });
const LOCK = "error: cannot lock ref 'refs/remotes/origin/main': is at 1a2b3c but expected 4d5e6f";
const CONFLICT = 'CONFLICT (content): Merge conflict in server.mjs\nAutomatic merge failed; fix conflicts and then commit the result.';

test('transientGit matches lock races and network blips', () => {
  for (const t of [
    LOCK,
    " ! [remote rejected] main -> main (cannot lock ref 'refs/heads/main': is at abc but expected def)\nerror: failed to push some refs to 'github.com:o/r.git'",
    "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    'error: could not lock config file .git/config: File exists',
    "error: failed to lock ref 'refs/heads/x'",
    'fetch-pack: unexpected disconnect while reading sideband packet\nfatal: early EOF',
    'error: RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly',
    'fatal: read error: Connection reset by peer',
    "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
    'ssh: connect to host github.com port 22: Connection timed out',
    'fatal: the remote end hung up unexpectedly',
    "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503",
    "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 502",
    "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429",
  ]) assert.equal(transientGit(t), true, t);
});

test('transientGit rejects conflicts, auth, non-fast-forward and missing refs', () => {
  for (const t of [
    CONFLICT,
    "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
    'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
    " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'github.com:o/r.git'",
    "fatal: couldn't find remote ref agent-orch/task-9",
    "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
    '', undefined, null,
  ]) assert.equal(transientGit(t), false, String(t));
});

test('retryGit retries a lock error with growing delays, then returns the result', async () => {
  const delays = [];
  const seen = [];
  const out = await retryGit(async (attempt) => {
    seen.push(attempt);
    if (attempt < 2) throw gitError(LOCK);
    return 'fetched';
  }, { sleep: async (ms) => { delays.push(ms); } });
  assert.equal(out, 'fetched');
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(delays.length, 2);
  assert.ok(delays[0] >= 400 && delays[0] <= 600, `first delay ${delays[0]}`);
  assert.ok(delays[1] >= 800 && delays[1] <= 1200, `second delay ${delays[1]}`);
  assert.ok(delays[1] > delays[0]);
});

test('retryGit without jitter waits exactly backoffMs * 2^attempt; message is used when there is no stderr', async () => {
  const delays = [];
  let n = 0;
  await retryGit(async () => { if (n++ < 3) throw new Error('fatal: the remote end hung up unexpectedly'); }, {
    backoffMs: 10, jitter: false, sleep: async (ms) => { delays.push(ms); },
  });
  assert.deepEqual(delays, [10, 20, 40]);
});

test('retryGit rethrows a merge conflict at once without retrying', async () => {
  const err = gitError(CONFLICT);
  let calls = 0;
  let slept = 0;
  await assert.rejects(retryGit(async () => { calls++; throw err; }, { sleep: async () => { slept++; } }), (e) => e === err);
  assert.equal(calls, 1);
  assert.equal(slept, 0);
});

test('retryGit gives up after `attempts` and rethrows the last failure unchanged', async () => {
  const errs = [];
  const delays = [];
  await assert.rejects(
    retryGit(async (attempt) => { const e = gitError(`${LOCK} (try ${attempt})`); errs.push(e); throw e; }, {
      attempts: 3, sleep: async (ms) => { delays.push(ms); },
    }),
    (e) => e === errs.at(-1),
  );
  assert.equal(errs.length, 3);
  assert.equal(delays.length, 2);
});
