// The head's git endpoint for workers (cluster-git.mjs, #345): a paired worker clones a project with its node token as
// an http.extraHeader, a bad token gets 401, and a push lands only on the branch of a task the head has on that node now:
// main and another task's branch are refused before git sees the pack.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCluster } from '../cluster.mjs';
import { createClusterGit, pushedRefs } from '../cluster-git.mjs';
import { GIT_PATH, gitPath } from '../cluster-protocol.mjs';

let tmp, project, cluster, server, base, node, other;
const assigned = new Map(); // node id -> task ids the "orchestrator" has running there
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// git as a worker runs it: the token only as an extraHeader for this one URL, nothing global.
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
const auth = (url, token) => ['-c', `http.${url}.extraHeader=Authorization: Bearer ${token}`];
const workerGit = (cwd, url, token, ...args) => promisify(execFile)('git', [...auth(url, token), ...args], { cwd, env, encoding: 'utf8' });

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cluster-git-')));
  env.HOME = tmp;
  project = path.join(tmp, 'demo');
  fs.mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'README.md'), '# demo\n');
  git(project, 'add', '-A');
  git(project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(project, 'branch', 'agent-orch/task-8');
  cluster = createCluster({ dbFile: path.join(tmp, 'hub.db'), heartbeatMs: 300 });
  const pairWith = (name) => cluster.claim({ code: cluster.createPairing().code, name, os: 'linux', arch: 'arm64' });
  node = pairWith('worker-a');
  other = pairWith('worker-b');
  assigned.set(node.node, [7]);
  assigned.set(other.node, [8]);
  const endpoint = createClusterGit({ node: cluster.tokenNode, repo: (pid) => (pid === 1 ? project : null), pushable: (id, pid) => (pid === 1 ? assigned.get(id) || [] : []) });
  server = http.createServer((req, res) => (req.url.startsWith(`${GIT_PATH}/`) ? endpoint.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  cluster?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('pushedRefs reads the command list of a receive-pack request', () => {
  const pkt = (s) => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
  const z = '0'.repeat(40), a = 'a'.repeat(40);
  const body = Buffer.from(pkt(`${z} ${a} refs/heads/agent-orch/task-7\0report-status side-band-64k\n`) + pkt(`${a} ${z} refs/heads/main\n`) + '0000PACK...');
  assert.deepEqual(pushedRefs(body), ['refs/heads/agent-orch/task-7', 'refs/heads/main']);
  assert.equal(pushedRefs(Buffer.from('zzzz')), null);
  assert.equal(pushedRefs(Buffer.from(pkt(`${a} ${z} refs/heads/main\n`))), null, 'no flush: unreadable');
});

test('a paired worker clones a project blob-less through the head with its node token', async () => {
  const url = base + gitPath(1), dir = path.join(tmp, 'cache-a.git');
  await workerGit(tmp, url, node.token, 'clone', '--bare', '--filter=blob:none', '-q', url, dir);
  assert.equal(git(dir, 'rev-parse', 'main'), git(project, 'rev-parse', 'main'));
  assert.equal(git(dir, 'config', 'remote.origin.partialclonefilter'), 'blob:none', 'the head serves filtered clones');
  // A worktree of the blob-less cache fetches README's blob lazily, through the same header.
  const wt = path.join(tmp, 'wt-a');
  await workerGit(dir, url, node.token, 'worktree', 'add', '-q', wt, 'main');
  assert.equal(fs.readFileSync(path.join(wt, 'README.md'), 'utf8'), '# demo\n');
});

test('a bad or missing token gets 401, an unknown project 404, dumb HTTP 404', async () => {
  const url = base + gitPath(1);
  const r = await fetch(`${url}/info/refs?service=git-upload-pack`, { headers: { authorization: 'Bearer aon_wrong' } });
  assert.equal(r.status, 401);
  assert.equal((await fetch(`${url}/info/refs?service=git-upload-pack`)).status, 401);
  await assert.rejects(workerGit(tmp, url, 'aon_wrong', 'ls-remote', url), (e) => /401|Authentication failed|could not read Username/i.test(e.stderr));
  const h = { authorization: `Bearer ${node.token}` };
  assert.equal((await fetch(`${base}${gitPath(2)}/info/refs?service=git-upload-pack`, { headers: h })).status, 404);
  assert.equal((await fetch(`${url}/HEAD`, { headers: h })).status, 404);
  assert.equal((await fetch(`${url}/info/refs`, { headers: h })).status, 404);
});

test("a worker pushes only its own running task's branch", async () => {
  const url = base + gitPath(1), wt = path.join(tmp, 'push');
  await workerGit(tmp, url, node.token, 'clone', '-q', url, wt);
  fs.writeFileSync(path.join(wt, 'work.txt'), 'task 7\n');
  git(wt, 'add', '-A');
  git(wt, '-c', 'user.name=w', '-c', 'user.email=w@w', 'commit', '-q', '-m', 'task 7');
  const sha = git(wt, 'rev-parse', 'HEAD'), main = git(project, 'rev-parse', 'main');

  await workerGit(wt, url, node.token, 'push', '-q', 'origin', 'HEAD:refs/heads/agent-orch/task-7');
  assert.equal(git(project, 'rev-parse', 'agent-orch/task-7'), sha, 'its task branch landed in the head repo');

  const refused = (e) => e.code !== 0 && /403/.test(e.stderr);
  await assert.rejects(workerGit(wt, url, node.token, 'push', '-q', 'origin', 'HEAD:refs/heads/main'), refused);
  assert.equal(git(project, 'rev-parse', 'main'), main, 'main unchanged');
  const eight = git(project, 'rev-parse', 'agent-orch/task-8');
  await assert.rejects(workerGit(wt, url, node.token, 'push', '-q', '-f', 'origin', 'HEAD:refs/heads/agent-orch/task-8'), refused);
  assert.equal(git(project, 'rev-parse', 'agent-orch/task-8'), eight, "another node's task branch unchanged");
  // A push naming its own branch and main together is refused whole.
  await assert.rejects(workerGit(wt, url, node.token, 'push', '-q', 'origin', 'HEAD:refs/heads/agent-orch/task-7', 'HEAD:refs/heads/main'), refused);
  assert.equal(git(project, 'rev-parse', 'main'), main);
  // Once the head no longer has task 7 on this node, its branch is closed too.
  assigned.set(node.node, []);
  fs.writeFileSync(path.join(wt, 'work.txt'), 'late\n');
  git(wt, '-c', 'user.name=w', '-c', 'user.email=w@w', 'commit', '-q', '-am', 'late');
  await assert.rejects(workerGit(wt, url, node.token, 'push', '-q', 'origin', 'HEAD:refs/heads/agent-orch/task-7'), refused);
  assert.equal(git(project, 'rev-parse', 'agent-orch/task-7'), sha);
  // A disabled node may not fetch either.
  cluster.update(other.node, { enabled: false });
  assert.equal((await fetch(`${url}/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${other.token}` } })).status, 403);
});
