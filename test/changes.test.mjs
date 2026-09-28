// taskChanges: a live task branch shows its commits plus the worktree's uncommitted edits; once squash-merged and the
// branch deleted, the squash commit's changes; an unknown task has none; a small maxBytes cuts the patch on a line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureWorktree, mergeBack, removeWorktree, repoInfo } from '../worktrees.mjs';
import { taskChanges } from '../changes.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A temp repo on branch main with a.txt and b.txt, inside its own parent dir (worktrees go to <parent>/.agent-orch-worktrees).
function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-changes-'))), repo = path.join(root, 'proj');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  return { root, repo };
}

test('taskChanges reads a live branch, then its squash commit, and caps the patch', async () => {
  const { root, repo } = makeRepo();
  try {
    const info = await repoInfo(repo);
    const wt = await ensureWorktree(info, 7);
    fs.writeFileSync(path.join(wt.dir, 'a.txt'), 'one\nTWO\nthree\n');
    git(wt.dir, 'commit', '-qam', 'wip');
    fs.writeFileSync(path.join(wt.dir, 'b.txt'), 'bee\nbuzz\n'); // uncommitted
    fs.writeFileSync(path.join(wt.dir, 'c.txt'), 'new\n'); // untracked
    // main moves on meanwhile: not part of the task's changes.
    fs.writeFileSync(path.join(repo, 'd.txt'), 'main\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'other work');
    const statusBefore = git(wt.dir, 'status', '--porcelain');

    const live = await taskChanges(info, 7);
    assert.equal(live.source, 'branch');
    assert.equal(live.commits.length, 1);
    assert.deepEqual(live.files, [
      { path: 'a.txt', add: 1, del: 1, binary: false },
      { path: 'b.txt', add: 1, del: 0, binary: false },
      { path: 'c.txt', add: 1, del: 0, binary: false },
    ]);
    assert.match(live.patch, /^-two\n\+TWO$/m);
    assert.match(live.patch, /^\+buzz$/m);
    assert.doesNotMatch(live.patch, /d\.txt/);
    assert.equal(live.truncated, false);
    assert.equal(git(wt.dir, 'status', '--porcelain'), statusBefore, "the worktree's index is untouched");

    const cut = await taskChanges(info, 7, { maxBytes: 50 });
    assert.equal(cut.truncated, true);
    assert.ok(Buffer.byteLength(cut.patch) <= 50);
    assert.ok(cut.patch === '' || cut.patch.endsWith('\n'));
    assert.ok(live.patch.startsWith(cut.patch));
    assert.equal(cut.files.length, 3, 'the file stat is never cut');

    assert.ok((await mergeBack(info, 7, 'agent-orch #7: thing')).sha);
    await removeWorktree(info, 7);
    assert.equal(git(repo, 'branch', '--list', 'agent-orch/*'), '');

    const merged = await taskChanges(info, 7);
    assert.equal(merged.source, 'commit');
    assert.deepEqual(merged.commits, [git(repo, 'rev-parse', 'HEAD')]);
    assert.deepEqual(merged.files, live.files);
    assert.match(merged.patch, /^\+buzz$/m);
    assert.equal(merged.truncated, false);
    const mergedCut = await taskChanges(info, 7, { maxBytes: 50 });
    assert.equal(mergedCut.truncated, true);
    assert.ok(Buffer.byteLength(mergedCut.patch) <= 50);

    // A subject that only mentions the id, or another id sharing its prefix, doesn't count.
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'agent-orch #70: other', '-m', 'agent-orch #7: in the body');
    assert.deepEqual((await taskChanges(info, 7)).commits, merged.commits);

    assert.deepEqual(await taskChanges(info, 999), { source: 'none', commits: [], files: [], patch: '', truncated: false });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('taskChanges rejects on a broken repo', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-changes-')));
  try {
    await assert.rejects(taskChanges({ top: root, branch: 'main' }, 1));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
