// projectCommits / commitDetail: newest-first first-parent history with 'agent-orch #N:' tasks parsed, paging by
// limit + before, one commit's per-file stat and patch, and the failures: bad sha 400, unknown sha 404, empty repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectCommits, commitDetail } from '../commits.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-commits-')));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 'Tester');
  return repo;
}

test('projectCommits lists newest first and pages; commitDetail has counts and a patch', async () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'agent-orch #7: x', '-m', 'the body');
    fs.writeFileSync(path.join(repo, 'c.txt'), 'sea\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'third');
    const before = git(repo, 'status', '--porcelain'), head = git(repo, 'rev-parse', 'HEAD');

    const all = await projectCommits(repo);
    assert.equal(all.branch, 'main');
    assert.equal(all.more, false);
    assert.deepEqual(all.commits.map((c) => c.subject), ['third', 'agent-orch #7: x', 'init']);
    assert.deepEqual(all.commits.map((c) => c.task), [null, 7, null]);
    const t7 = all.commits[1];
    assert.match(t7.sha, /^[0-9a-f]{40}$/);
    assert.equal(t7.author, 'Tester');
    assert.ok(Math.abs(t7.at - Date.now()) < 60_000);
    assert.deepEqual([t7.add, t7.del, t7.files], [3, 1, 2]);

    const page = await projectCommits(repo, { branch: 'main', limit: 2 });
    assert.deepEqual(page.commits.map((c) => c.subject), ['third', 'agent-orch #7: x']);
    assert.equal(page.more, true);
    const rest = await projectCommits(repo, { branch: 'main', limit: 2, before: page.commits[1].sha });
    assert.deepEqual(rest.commits.map((c) => c.subject), ['init']);
    assert.equal(rest.more, false);
    assert.deepEqual((await projectCommits(repo, { before: rest.commits[0].sha })).commits, []);
    assert.equal((await projectCommits(repo, { limit: 999 })).commits.length, 3);

    const d = await commitDetail(repo, t7.sha.slice(0, 7));
    assert.equal(d.sha, t7.sha);
    assert.equal(d.subject, 'agent-orch #7: x');
    assert.equal(d.body, 'the body');
    assert.equal(d.task, 7);
    assert.equal(d.at, t7.at);
    assert.deepEqual(d.files, [
      { path: 'a.txt', add: 2, del: 1, binary: false },
      { path: 'b.txt', add: 1, del: 0, binary: false },
    ]);
    assert.match(d.patch, /^diff --git a\/a\.txt b\/a\.txt/);
    assert.match(d.patch, /^\+TWO$/m);
    assert.match(d.patch, /^\+bee$/m);
    assert.equal(d.truncated, false);

    const cut = await commitDetail(repo, t7.sha, { maxBytes: 120 });
    assert.equal(cut.truncated, true);
    assert.ok(cut.patch.length <= 120 && cut.patch.endsWith('\n'));

    // Read-only: no ref or working-tree change.
    assert.equal(git(repo, 'status', '--porcelain'), before);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('commitDetail rejects a bad sha with 400 and an unknown one with 404; an empty repo lists nothing', async () => {
  const repo = makeRepo();
  try {
    assert.deepEqual(await projectCommits(repo), { branch: 'main', commits: [], more: false });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
    await assert.rejects(commitDetail(repo, 'zz'), (e) => e.code === 400);
    await assert.rejects(commitDetail(repo, '--all'), (e) => e.code === 400);
    await assert.rejects(commitDetail(repo, 'deadbeefdeadbeef'), (e) => e.code === 404);
    await assert.rejects(projectCommits(repo, { before: 'zz' }), (e) => e.code === 400);
    await assert.rejects(projectCommits(repo, { before: 'deadbeef' }), (e) => e.code === 404);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
