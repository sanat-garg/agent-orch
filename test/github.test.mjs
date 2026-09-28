import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createGitHub, repoOf } from '../github.mjs';

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
    assert.deepEqual(await gh.commitAndPush(path.join(tmp, 'gone'), 'x'), { ok: false, error: 'folder is gone' });
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
