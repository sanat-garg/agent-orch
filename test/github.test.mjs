import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createGitHub, repoOf, parseRepoSpec } from '../github.mjs';

// test/fixtures/gh-stub.mjs stands in for `gh`, linked into a temp bin dir on PATH.
const STUB = fileURLToPath(new URL('./fixtures/gh-stub.mjs', import.meta.url));

test('concurrent ensureRepo calls for one dir create a single repo (AUDIT #12)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-test-'));
  const bin = path.join(tmp, 'bin'), dir = path.join(tmp, 'my-proj'), log = path.join(tmp, 'creates.log');
  fs.mkdirSync(bin); fs.mkdirSync(dir);
  fs.symlinkSync(STUB, path.join(bin, 'gh'));
  const gh = createGitHub({ env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_STUB_LOG: log }, log: () => {} });
  try {
    const [a, b] = await Promise.all([gh.ensureRepo(dir), gh.ensureRepo(dir)]);
    const creates = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(creates.length, 1);
    assert.equal(JSON.parse(creates[0])[2], 'my-proj');
    assert.deepEqual(a, { full: 'tester/my-proj', url: 'https://github.com/tester/my-proj' });
    assert.deepEqual(b, a);
    // Once settled, a later call finds the existing origin instead of creating again.
    assert.deepEqual(await gh.ensureRepo(dir), a);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('repoOf reads ssh, https and ssh:// GitHub urls and rejects other hosts', () => {
  const want = { full: 'o/r', url: 'https://github.com/o/r' };
  for (const u of ['git@github.com:o/r.git', 'git@github.com:o/r', 'https://github.com/o/r.git', 'https://github.com/o/r',
    'https://token@github.com/o/r.git', 'ssh://git@github.com/o/r', 'ssh://git@github.com/o/r.git']) assert.deepEqual(repoOf(u), want, u);
  for (const u of ['https://gitlab.com/o/r.git', 'git@gitlab.com:o/r.git', 'https://notgithub.com/o/r', '/tmp/bare.git', '', 'https://github.com/o'])
    assert.equal(repoOf(u), null, u);
});

test('parseRepoSpec (Import from GitHub) takes owner/name, GitHub urls and pages, and other git urls; rejects the rest', () => {
  for (const t of ['o/r', 'o/r.git', 'https://github.com/o/r', 'github.com/o/r/', 'www.github.com/o/r/tree/main/src',
    'https://github.com/o/r/pulls', 'git@github.com:o/r.git', ' https://github.com/o/r.git ']) assert.deepEqual(parseRepoSpec(t), { full: 'o/r' }, t);
  assert.deepEqual(parseRepoSpec('https://gitlab.com/x/y.git'), { url: 'https://gitlab.com/x/y.git', full: null });
  for (const t of ['', 'hello', 'o/..', '--upload-pack=touch /tmp/x', 'o/r; rm -rf ~', 'file:///etc', '/tmp/bare.git', 'http://example.com/a b'])
    assert.equal(parseRepoSpec(t), null, t);
});

// A project whose origin is a local bare repo, with a PATH that has git but no gh.
function localRemote() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-test-'));
  const bin = path.join(tmp, 'bin'), dir = path.join(tmp, 'proj'), bare = path.join(tmp, 'bare.git');
  fs.mkdirSync(bin); fs.mkdirSync(dir);
  fs.symlinkSync(execFileSync('which', ['git']).toString().trim(), path.join(bin, 'git'));
  const env = { ...process.env, PATH: bin, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString().trim();
  git(tmp, 'init', '-q', '--bare', bare);
  git(tmp, 'init', '-q', '-b', 'main', dir);
  git(dir, 'remote', 'add', 'origin', bare);
  const gh = createGitHub({ env, log: () => {} });
  return { tmp, dir, bare, env, git, gh };
}

test('push() to an existing non-GitHub origin works without gh on PATH', async () => {
  const { tmp, dir, bare, git, gh } = localRemote();
  try {
    const r = await gh.push(dir);
    assert.deepEqual(r, { ok: true, repo: null });
    assert.equal(git(bare, 'rev-parse', 'main'), git(dir, 'rev-parse', 'HEAD'));
    assert.equal(await gh.unpushed(dir), 0);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
    git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a');
    assert.equal(await gh.unpushed(dir), 1);
    assert.equal((await gh.commitAndPush(dir, 'nothing new')).ok, true);
    assert.equal(await gh.unpushed(dir), 0);
    assert.equal(git(bare, 'rev-parse', 'main'), git(dir, 'rev-parse', 'HEAD'));
    assert.equal(gh.status().linked, false); // never asked gh
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('commitAndPush() on a folder that no longer exists reports it', async () => {
  const { tmp, gh } = localRemote();
  try {
    assert.deepEqual(await gh.commitAndPush(path.join(tmp, 'gone'), 'x'), { ok: false, error: 'folder is gone', committed: null });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a failed push returns git\'s last stderr line, not a stack', async () => {
  const { tmp, dir, git, gh } = localRemote();
  try {
    git(dir, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));
    const r = await gh.push(dir);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0 && !r.error.includes('\n'), r.error);
    assert.doesNotMatch(r.error, /^Error:|\bat .*\(|Command failed/);
    let stderr = '';
    try { git(dir, 'push', 'origin', 'HEAD'); } catch (e) { stderr = e.stderr.toString(); }
    assert.equal(r.error, stderr.trim().split('\n').filter(Boolean).pop());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pull() fast-forwards to origin, merges when both sides moved, and changes nothing on a conflict', async () => {
  const { tmp, dir, bare, git, gh } = localRemote();
  const commit = (cwd, file, text) => { fs.writeFileSync(path.join(cwd, file), text); git(cwd, 'add', '-A'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', file); };
  try {
    assert.equal((await gh.push(dir)).ok, true); // its first commit (with the .gitignore it writes)
    commit(dir, 'a.txt', 'one\n');
    assert.equal((await gh.push(dir)).ok, true);
    assert.deepEqual(await gh.pull(dir), { ok: true, pulled: 0 }); // up to date
    // Another machine pushes two commits: a fast-forward, reported before it starts.
    const other = path.join(tmp, 'other');
    git(tmp, 'clone', '-q', '-b', 'main', bare, other);
    commit(other, 'b.txt', 'b\n'); commit(other, 'c.txt', 'c\n');
    git(other, 'push', '-q', 'origin', 'main');
    const behind = [];
    let r = await gh.pull(dir, { onBehind: (n) => behind.push(n) });
    assert.equal(r.ok, true); assert.equal(r.pulled, 2); assert.equal(r.merged, false);
    assert.deepEqual(behind, [2]);
    assert.equal(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'c\n');
    // Both sides moved, different files: a merge commit (shas kept, never rebased).
    assert.equal((await gh.push(dir)).ok, true);
    git(other, 'pull', '-q', '--no-rebase', 'origin', 'main');
    commit(other, 'd.txt', 'd\n'); git(other, 'push', '-q', 'origin', 'main');
    commit(dir, 'e.txt', 'e\n');
    fs.writeFileSync(path.join(dir, 'wip.txt'), 'unsaved\n'); // uncommitted work is saved first
    const mine = git(dir, 'rev-parse', 'HEAD');
    r = await gh.pull(dir);
    assert.equal(r.ok, true); assert.equal(r.pulled, 1); assert.equal(r.merged, true);
    assert.equal(fs.readFileSync(path.join(dir, 'wip.txt'), 'utf8'), 'unsaved\n');
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.equal(git(dir, 'merge-base', '--is-ancestor', mine, 'HEAD'), '');
    assert.ok(fs.existsSync(path.join(dir, 'd.txt')));
    // Same lines on both sides: nothing changes and the conflict is named.
    assert.equal((await gh.push(dir)).ok, true);
    git(other, 'pull', '-q', '--no-rebase', 'origin', 'main');
    commit(other, 'a.txt', 'theirs\n'); git(other, 'push', '-q', 'origin', 'main');
    commit(dir, 'a.txt', 'ours\n');
    const before = git(dir, 'rev-parse', 'HEAD');
    r = await gh.pull(dir);
    assert.equal(r.ok, false); assert.equal(r.conflict, true);
    assert.match(r.error, /same lines in a\.txt/);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), before);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'ours\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pull() with no origin, or an origin without the branch yet, has nothing to pull', async () => {
  const { tmp, dir, git, gh } = localRemote();
  try {
    assert.deepEqual(await gh.pull(dir), { ok: true, pulled: 0 }); // never pushed: origin has no main
    git(dir, 'remote', 'remove', 'origin');
    assert.deepEqual(await gh.pull(dir), { ok: true, pulled: 0 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
