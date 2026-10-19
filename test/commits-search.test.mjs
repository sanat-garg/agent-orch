// projectCommits q: a case-insensitive, literal (--fixed-strings) message search that keeps the first-parent paging and
// response shape; regex characters match themselves, a miss is { commits: [], more: false }, and blank/non-string q is ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectCommits } from '../commits.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-commits-')));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 'Tester');
  return repo;
}
function commit(repo, n, subject, ...more) {
  fs.writeFileSync(path.join(repo, `f${n}.txt`), `${n}\n`);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', subject, ...more);
}
const subjects = (r) => r.commits.map((c) => c.subject);

test('q filters commit messages case-insensitively, literally, with paging; no match is an empty page', async () => {
  const repo = makeRepo();
  try {
    commit(repo, 1, 'init');
    commit(repo, 2, 'Fix login bug');
    commit(repo, 3, 'agent-orch #7: a.b in the subject');
    commit(repo, 4, 'axb is no dot match');
    commit(repo, 5, 'open [x bracket');
    commit(repo, 6, 'LOGIN page polish', '-m', 'the body mentions a.b too');
    commit(repo, 7, 'third');

    // Case-insensitive, newest first, same row shape as the unfiltered list.
    const login = await projectCommits(repo, { q: 'login' });
    assert.equal(login.branch, 'main');
    assert.equal(login.more, false);
    assert.deepEqual(subjects(login), ['LOGIN page polish', 'Fix login bug']);
    assert.deepEqual(Object.keys(login.commits[0]).sort(), ['add', 'at', 'author', 'del', 'files', 'sha', 'subject', 'task']);
    assert.deepEqual([login.commits[0].add, login.commits[0].files], [1, 1]);

    // Regex characters are literal: 'a.b' does not match 'axb', '[x' is not a broken class; the body counts too.
    const dot = await projectCommits(repo, { q: 'a.b' });
    assert.deepEqual(subjects(dot), ['LOGIN page polish', 'agent-orch #7: a.b in the subject']);
    assert.equal(dot.commits[1].task, 7);
    assert.deepEqual(subjects(await projectCommits(repo, { q: '[x' })), ['open [x bracket']);
    assert.deepEqual(subjects(await projectCommits(repo, { q: '  Login ' })), ['LOGIN page polish', 'Fix login bug']); // trimmed

    // Paging keeps the filter: limit 1 → more, then `before` the last shown sha continues the same search.
    const page = await projectCommits(repo, { q: 'login', limit: 1 });
    assert.deepEqual(subjects(page), ['LOGIN page polish']);
    assert.equal(page.more, true);
    const rest = await projectCommits(repo, { q: 'login', limit: 1, before: page.commits[0].sha });
    assert.deepEqual(subjects(rest), ['Fix login bug']);
    assert.equal(rest.more, false);

    // No match: an empty page, not an error. Blank or non-string q is the full list.
    assert.deepEqual(await projectCommits(repo, { q: 'nothing like this' }), { branch: 'main', commits: [], more: false });
    assert.equal((await projectCommits(repo, { q: '   ' })).commits.length, 7);
    assert.equal((await projectCommits(repo, { q: 42 })).commits.length, 7);
    assert.equal((await projectCommits(repo, { q: 'x'.repeat(300) })).commits.length, 0); // capped at 200 chars, still literal
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
