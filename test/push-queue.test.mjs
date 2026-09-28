// Task #427: every push of a branch goes through github.mjs pushBranch (one per repo+branch at a time, coalesced,
// lock races and concurrent-push rejections retried, never forced), and a worker's start never waits on a push race.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitHub, pushBranch, pushedBase, pushOptions } from '../github.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const commit = (dir, file, text = file) => {
  fs.writeFileSync(path.join(dir, file), `${text}\n`);
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', file);
  return git(dir, 'rev-parse', 'HEAD');
};
const hook = (bare, name, body) => {
  const f = path.join(bare, 'hooks', name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(f, 0o755);
};

// A project pushed once to a local bare repo standing in for GitHub; pushOptions' delays shrink to milliseconds.
function setup(t) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'push-queue-')));
  const dir = path.join(tmp, 'proj'), bare = path.join(tmp, 'origin.git');
  git(tmp, 'init', '-q', '--bare', bare);
  git(tmp, 'init', '-q', '-b', 'main', dir);
  git(dir, 'remote', 'add', 'origin', bare);
  commit(dir, 'README.md');
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  const saved = { ...pushOptions }, sleeps = [];
  pushOptions.delays = [5, 10, 15, 20];
  pushOptions.sleep = async (ms) => { sleeps.push(ms); await saved.sleep(ms); };
  t.after(() => { Object.assign(pushOptions, saved); fs.rmSync(tmp, { recursive: true, force: true }); });
  return { tmp, dir, bare, sleeps };
}

test('concurrent pushes of main are serialized, coalesced, and every commit lands', async (t) => {
  const { dir, bare } = setup(t);
  const log = path.join(bare, 'pushes.log'), flag = path.join(bare, 'inflight');
  // A slow receive that records any overlap with another push to this repo.
  hook(bare, 'pre-receive', `[ -e "${flag}" ] && echo overlap >> "${log}"; touch "${flag}"; echo push >> "${log}"; sleep 0.4; rm -f "${flag}"`);
  const a = commit(dir, 'a.txt');
  const first = pushBranch(dir, 'main');
  await new Promise((r) => setTimeout(r, 100)); // the first push is in flight
  commit(dir, 'b.txt');
  const second = pushBranch(dir, 'main'), third = pushBranch(dir); // a burst: one follow-up push at the latest tip
  const c = commit(dir, 'c.txt');
  const [r1, r2, r3] = await Promise.all([first, second, third]);
  assert.equal(r1.ok, true);
  assert.equal(r1.sha, a);
  assert.equal(r2, r3, 'queued pushes share one run');
  assert.deepEqual(r2, { ok: true, sha: c });
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(lines, ['push', 'push'], 'two pushes, never overlapping');
  assert.equal(git(bare, 'rev-parse', 'main'), c);
  for (const f of ['a.txt', 'b.txt', 'c.txt']) assert.equal(git(bare, 'show', `main:${f}`), f);
});

test('the chat sync (gh.push) and the orchestrator\'s push of main share one queue, from any checkout of the repo', async (t) => {
  const { tmp, dir, bare } = setup(t);
  const log = path.join(bare, 'pushes.log'), flag = path.join(bare, 'inflight');
  hook(bare, 'pre-receive', `[ -e "${flag}" ] && echo overlap >> "${log}"; touch "${flag}"; echo push >> "${log}"; sleep 0.3; rm -f "${flag}"`);
  const wt = path.join(tmp, 'wt');
  git(dir, 'worktree', 'add', '-q', '-b', 'side', wt);
  const sha = commit(dir, 'a.txt');
  const gh = createGitHub({ env: process.env, log: () => {} });
  const [r1, r2] = await Promise.all([gh.push(dir), pushBranch(wt, 'main')]);
  assert.deepEqual(r1, { ok: true, repo: null });
  assert.equal(r2.ok, true);
  assert.ok(!fs.readFileSync(log, 'utf8').includes('overlap'));
  assert.equal(git(bare, 'rev-parse', 'main'), sha);
});

test("a 'cannot lock ref' push is retried with backoff and lands", async (t) => {
  const { dir, bare, sleeps } = setup(t);
  // GitHub's error when another push moved main mid-push; the hook fails the first two pushes with it.
  const count = path.join(bare, 'count');
  hook(bare, 'pre-receive', `n=$(cat "${count}" 2>/dev/null || echo 0); echo $((n+1)) > "${count}"
[ "$n" -lt 2 ] && { echo "error: cannot lock ref 'refs/heads/main': is at 1111111111111111111111111111111111111111 but expected 2222222222222222222222222222222222222222" >&2; exit 1; }
exit 0`);
  const sha = commit(dir, 'a.txt');
  const r = await pushBranch(dir, 'main');
  assert.deepEqual(r, { ok: true, sha });
  assert.deepEqual(sleeps, [5, 10]);
  assert.equal(git(bare, 'rev-parse', 'main'), sha);
});

test('a diverged origin raises the alert and is never forced', async (t) => {
  const { tmp, dir, bare, sleeps } = setup(t);
  const other = path.join(tmp, 'other');
  git(tmp, 'clone', '-q', bare, other);
  const theirs = commit(other, 'theirs.txt');
  git(other, 'push', '-q', 'origin', 'main');
  commit(dir, 'ours.txt');
  const alerts = [];
  let clock = 1e6;
  const gh = createGitHub({ env: process.env, log: () => {}, alert: (d, e) => alerts.push([d, e]), now: () => clock });
  const r = await gh.push(dir);
  assert.equal(r.ok, false);
  assert.equal(r.diverged, true);
  assert.equal(r.warn, true, 'a divergence is shown at once');
  assert.match(r.error, /has commits this machine doesn't/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0][0], dir);
  assert.equal(git(bare, 'rev-parse', 'main'), theirs, 'origin keeps its commits');
  assert.equal(sleeps.length, 0, 'no retries once diverged');
  clock += 60_000;
  assert.equal((await gh.push(dir)).diverged, true);
  assert.equal(alerts.length, 1, 'alerted once per divergence');
});

test('a failing push warns only after 10 min of failing', async (t) => {
  const { tmp, dir } = setup(t);
  git(dir, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));
  let clock = 1e6;
  const gh = createGitHub({ env: process.env, log: () => {}, now: () => clock });
  const r = await gh.push(dir);
  assert.equal(r.ok, false);
  assert.equal(r.warn, false);
  clock += 9 * 60_000;
  assert.equal((await gh.push(dir)).warn, false);
  clock += 2 * 60_000;
  assert.equal((await gh.push(dir)).warn, true);
  git(dir, 'remote', 'set-url', 'origin', path.join(tmp, 'origin.git'));
  assert.deepEqual(await gh.push(dir), { ok: true, repo: null });
  git(dir, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));
  assert.equal((await gh.push(dir)).warn, false, 'a success resets the clock');
});

test('task branches get their own queue, retry, and (the local branch being the latest work) a forced update', async (t) => {
  const { dir, bare, sleeps } = setup(t);
  git(dir, 'switch', '-q', '-c', 'agent-orch/task-7');
  commit(dir, 'old.txt');
  git(dir, 'push', '-q', 'origin', 'agent-orch/task-7');
  git(dir, 'reset', '-q', '--hard', 'main');
  const sha = commit(dir, 'new.txt');
  git(dir, 'switch', '-q', 'main');
  const lock = path.join(bare, 'refs', 'heads', 'agent-orch', 'task-7.lock');
  fs.writeFileSync(lock, ''); // a real ref lock, held until the first retry's wait
  const sleep = pushOptions.sleep;
  pushOptions.sleep = (ms) => { fs.rmSync(lock, { force: true }); return sleep(ms); };
  assert.deepEqual(await pushBranch(dir, 'agent-orch/task-7', { force: true }), { ok: true, sha });
  assert.deepEqual(sleeps, [5], 'the lock was retried once');
  assert.equal(git(bare, 'rev-parse', 'agent-orch/task-7'), sha);
});

test('a worker\'s start never waits on a failing push: it starts from the last main on origin', async (t) => {
  const { dir, bare } = setup(t);
  const pushedSha = git(dir, 'rev-parse', 'HEAD');
  pushOptions.delays = [200, 200, 200, 200];
  hook(bare, 'pre-receive', `echo "error: cannot lock ref 'refs/heads/main': is at 1111111 but expected 2222222" >&2; exit 1`);
  const sha = commit(dir, 'a.txt');
  const results = [];
  const started = Date.now();
  const base = await pushedBase(dir, 'main', sha, { waitMs: 100, onResult: (r) => results.push(r) });
  assert.ok(Date.now() - started < 2000, 'returned without waiting out the retries');
  assert.equal(base, pushedSha, 'starts from what origin has');
  assert.equal(results.length, 0, 'the push is still retrying in the background');
  const r = await pushBranch(dir, 'main'); // queued behind the background push, which gives up first
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot lock ref/);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  // Once origin has it, the tip itself is the base; with nothing usable on origin, null (the task requeues).
  fs.rmSync(path.join(bare, 'hooks', 'pre-receive'));
  assert.equal(await pushedBase(dir, 'main', sha, { waitMs: 5000 }), sha);
  assert.equal(git(bare, 'rev-parse', 'main'), sha);
});
