import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createGitHubUsers, CLIENT_ID, SCOPES } from '../github-users.mjs';

// test/fixtures/gh-stub.mjs stands in for `gh`; HOME is a temp dir whose global git config has its own GitHub helper
// (like the admin's `gh auth setup-git`), which a user's repo must not use.
const STUB = fileURLToPath(new URL('./fixtures/gh-stub.mjs', import.meta.url));
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-users-'));
  const bin = path.join(tmp, 'bin'), data = path.join(tmp, 'data');
  fs.mkdirSync(bin); fs.mkdirSync(data);
  fs.symlinkSync(STUB, path.join(bin, 'gh'));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1', GH_STUB_LOG: path.join(tmp, 'creates.log'), GH_STUB_REMOTE: path.join(tmp, 'src'), GH_TOKEN: 'admin-env-token' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString().trim();
  git(tmp, 'config', '--global', 'credential.https://github.com.helper', '!f() { echo username=admin; echo password=ADMIN; }; f');
  const changes = [];
  const users = createGitHubUsers({ dataDir: data, env, onChange: (uid) => changes.push(uid), ...arguments[0] });
  const done = () => fs.rmSync(tmp, { recursive: true, force: true });
  return { tmp, data, env, git, users, changes, done };
}
// What git would log in to GitHub with from `dir`.
const fill = (env, dir) => Object.fromEntries(execFileSync('git', ['credential', 'fill'], { cwd: dir, env, input: 'protocol=https\nhost=github.com\n\n' })
  .toString().trim().split('\n').map((l) => l.split('=')));

test("a user's token links their GitHub; their new repo is made in their account and pushes as them", async () => {
  const t = setup();
  try {
    assert.deepEqual(t.users.status('sam1'), { linked: false, login: null, linkedAt: null });
    assert.equal(t.users.gh('sam1'), null, 'no instance until linked');
    await assert.rejects(t.users.linkToken('sam1', 'bad_token_without_scopes_xx'), /missing required scope 'read:org'/);
    await assert.rejects(t.users.linkToken('sam1', 'nope'), /doesn't look like a GitHub token/);
    assert.equal(t.users.status('sam1').linked, false, 'a refused token links nothing');
    assert.equal(fs.existsSync(path.join(t.data, 'github-users', 'sam1')), false);

    const token = 'ghp_samgh_0123456789abcdef';
    assert.equal((await t.users.linkToken('sam1', token)).login, 'samgh');
    assert.deepEqual(t.changes, ['sam1']);
    assert.equal((fs.statSync(path.join(t.data, 'github-users', 'sam1')).mode & 0o777), 0o700);

    const dir = path.join(t.tmp, 'my-proj');
    fs.mkdirSync(dir);
    const repo = await t.users.gh('sam1').ensureRepo(dir);
    assert.deepEqual(repo, { full: 'samgh/my-proj', url: 'https://github.com/samgh/my-proj' });
    const created = JSON.parse(fs.readFileSync(t.env.GH_STUB_LOG, 'utf8').trim());
    assert.equal(created.at(-1), path.join(t.data, 'github-users', 'sam1'), "gh ran with the user's own config");
    assert.equal(await t.users.boundUser(dir), 'sam1');
    // git (any push or fetch in that folder, its task worktrees included) gets the user's token, not the global helper's.
    assert.deepEqual([fill(t.env, dir).username, fill(t.env, dir).password], ['samgh', token]);
    t.git(dir, 'worktree', 'add', '-q', '-b', 'agent-orch/task-1', path.join(t.tmp, 'wt'));
    assert.equal(fill(t.env, path.join(t.tmp, 'wt')).password, token);

    // Unbinding hands the folder back to the global (admin's) helper; unlinking forgets the token.
    assert.equal(await t.users.unbind(dir), true);
    assert.equal(fill(t.env, dir).password, 'ADMIN');
    assert.equal(await t.users.boundUser(dir), null);
    t.users.unlink('sam1');
    assert.equal(t.users.status('sam1').linked, false);
    assert.equal(t.users.gh('sam1'), null);
    assert.equal(fs.existsSync(path.join(t.data, 'github-users', 'sam1')), false);
  } finally { t.done(); }
});

test("GitHub's device sign-in: the code is shown, approval links the account; a denial is reported", async () => {
  const calls = [];
  let answers = [];
  const fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push([url, body]);
    if (url.endsWith('/login/device/code')) return { json: async () => ({ device_code: `dev-${calls.length}`, user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }) };
    return { json: async () => answers.shift() || { error: 'authorization_pending' } };
  };
  let tick = () => {};
  const sleep = () => new Promise((r) => { tick = r; });
  const t = setup({ fetch, sleep });
  const step = async () => { tick(); for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  try {
    const s = await t.users.startDevice('sam1');
    assert.deepEqual([s.linked, s.pending.code, s.pending.url, s.pending.error], [false, 'ABCD-1234', 'https://github.com/login/device', null]);
    assert.deepEqual(calls[0][1], { client_id: CLIENT_ID, scope: SCOPES });
    assert.match(SCOPES, /\brepo\b.*\bworkflow\b/);
    await step(); // not approved yet: still waiting
    assert.equal(t.users.status('sam1').pending.code, 'ABCD-1234');
    assert.equal(calls[1][1].grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
    answers = [{ access_token: 'gho_samgh_fromdeviceflow0001' }];
    await step();
    for (let i = 0; i < 50 && !t.users.status('sam1').linked; i++) await new Promise((r) => setTimeout(r, 20));
    const linked = t.users.status('sam1');
    assert.deepEqual([linked.linked, linked.login, linked.pending], [true, 'samgh', undefined]);
    assert.deepEqual(t.changes, ['sam1', 'sam1'], 'linked, then the sign-in ended');

    // Another user says no on GitHub: the error shows until they start again or cancel.
    await t.users.startDevice('kim2');
    answers = [{ error: 'access_denied' }];
    await step();
    assert.equal(t.users.status('kim2').pending.error, 'The sign-in was cancelled on GitHub');
    t.users.cancelDevice('kim2');
    assert.equal(t.users.status('kim2').pending, undefined);
    assert.throws(() => t.users.unlink('../x'), /Bad user id/);
  } finally { t.done(); }
});

test("a user's import clones with their helper set from the start, so it pushes as them", async () => {
  const t = setup();
  try {
    await t.users.linkToken('sam1', 'ghp_samgh_0123456789abcdef');
    const src = path.join(t.tmp, 'src');
    t.git(t.tmp, 'init', '-q', '-b', 'main', src);
    t.git(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
    const dir = path.join(t.tmp, 'imported');
    assert.deepEqual(await t.users.gh('sam1').clone('samgh/private-thing', dir), { full: 'samgh/private-thing', url: 'https://github.com/samgh/private-thing' });
    assert.equal(t.git(dir, 'log', '--format=%s'), 'one');
    assert.equal(await t.users.boundUser(dir), 'sam1');
    assert.equal(fill(t.env, dir).password, 'ghp_samgh_0123456789abcdef');
  } finally { t.done(); }
});
