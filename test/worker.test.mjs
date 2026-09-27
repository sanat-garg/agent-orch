// Worker daemon e2e (worker.mjs): a fake hub (cluster.mjs on an in-test HTTP/WS server), a temp bare repo as the
// project's `origin` (git's url.insteadOf maps the GitHub URL onto it) and a stub `codex` CLI. Covers pairing,
// inventory, resources, and a job that edits a file, passes its check and pushes the branch with the change.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCluster } from '../cluster.mjs';
import { CLAIM_PATH } from '../cluster-protocol.mjs';
import { parseVmStat, parseSwapUsage } from '../resources.mjs';
import { cacheName, sleptFor } from '../worker.mjs';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/test-owner/demo.git';
let tmp, home, bin, origin, baseSha, server, cluster, base, worker, workerOut = '';
const frames = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const env = () => ({ HOME: home, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off' });
// The hub runs in this process, so worker CLI calls must not block the event loop.
const workerCli = async (...args) => (await promisify(execFile)(process.execPath, ['worker.mjs', ...args], { cwd: ROOT, env: env(), encoding: 'utf8' })).stdout;
const got = (t, job) => frames.filter((f) => f.t === t && (job == null || f.job === job));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-worker-'));
  home = path.join(tmp, 'home');
  bin = path.join(tmp, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  isolatedPath(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node ${path.join(ROOT, 'test/fixtures/worker-agent-stub.mjs')} "$@"\n`, { mode: 0o755 });
  // origin: a bare repo with one commit on main; the worker's git sees it under the GitHub URL.
  origin = path.join(tmp, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = path.join(tmp, 'seed');
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' });
  fs.writeFileSync(path.join(seed, 'README.md'), '# demo\n');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  baseSha = git(seed, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(home, '.gitconfig'), `[url "file://${origin}"]\n\tinsteadOf = ${REPO}\n[user]\n\tname = worker\n\temail = w@w\n`);

  cluster = createCluster({ dbFile: path.join(tmp, 'hub.db'), heartbeatMs: 300 });
  cluster.onMessage((node, msg) => frames.push({ node, ...msg }));
  server = http.createServer(async (req, res) => {
    if (req.url !== CLAIM_PATH || req.method !== 'POST') { res.writeHead(404); return res.end(); }
    let body = '';
    for await (const c of req) body += c;
    const r = cluster.claim(JSON.parse(body));
    res.writeHead(r.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.status ? { error: r.error } : r));
  });
  server.on('upgrade', (req, socket, head) => cluster.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (worker && worker.exitCode == null) {
    worker.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(() => { worker.kill('SIGKILL'); r(); }, 10000); worker.on('exit', () => { clearTimeout(t); r(); }); });
  }
  cluster?.close();
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('darwin memory readings parse vm_stat and vm.swapusage', () => {
  const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               1000.\nPages active:                             5000.\n' +
    'Pages inactive:                           2000.\nPages speculative:                         300.\nPages purgeable:                           200.\n';
  assert.equal(parseVmStat(vm), 3500 * 16384);
  assert.equal(parseVmStat('garbage'), null);
  assert.deepEqual(parseSwapUsage('total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)'), { swapTotal: 2048 * 1024 ** 2, swapFree: Math.round(1023.5 * 1024 ** 2) });
  assert.equal(cacheName('git@github.com:Owner/My.Repo.git'), 'Owner__My.Repo');
});

test('sleep detection: a clock tick far later than due is a sleep of that length', () => {
  assert.equal(sleptFor(5_100, 5_000), 0);
  assert.equal(sleptFor(20_000, 5_000), 0, 'a busy event loop is not a sleep');
  assert.equal(sleptFor(605_000, 5_000), 600_000);
});

test('pair stores the node token in config.json (0600)', async () => {
  const { code } = cluster.createPairing();
  const out = await workerCli('pair', '--controller', base, '--code', code.replace('-', '').toLowerCase(), '--name', 'test-mac');
  assert.match(out, /paired as test-mac/);
  const file = path.join(home, '.agent-orch-worker', 'config.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(cfg.token, /^aon_/);
  assert.equal(cfg.controller, base);
  assert.equal(cluster.node(cfg.node).name, 'test-mac');
  assert.doesNotMatch(await workerCli('status'), /aon_/);
});

test('run: connects, reports inventory and resources', async () => {
  worker = spawn(process.execPath, ['worker.mjs', 'run'], { cwd: ROOT, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', (d) => { workerOut += d; });
  worker.stderr.on('data', (d) => { workerOut += d; });
  const { node } = JSON.parse(fs.readFileSync(path.join(home, '.agent-orch-worker', 'config.json'), 'utf8'));
  const n = await waitFor(() => { const x = cluster.node(node); return x?.status === 'online' && x.inventory?.agents?.find((a) => a.id === 'codex')?.models?.length && x; },
    { timeout: 20000, message: `inventory with codex models\n${workerOut}` });
  const codex = n.inventory.agents.find((a) => a.id === 'codex'), claude = n.inventory.agents.find((a) => a.id === 'claude');
  assert.deepEqual([codex.installed, codex.signedIn, codex.version], [true, true, '0.157.0']);
  assert.deepEqual([claude.installed, claude.signedIn], [false, false]);
  assert.equal(n.inventory.os, process.platform);
  assert.ok(n.inventory.cores >= 1 && n.inventory.mem > 0);
  await waitFor(() => cluster.node(node).resources?.memAvailable > 0, { timeout: 5000 });
  assert.deepEqual(cluster.node(node).resources.running, []);
});

test('a job edits a file, passes its check and pushes its branch to origin', async () => {
  const { node } = JSON.parse(fs.readFileSync(path.join(home, '.agent-orch-worker', 'config.json'), 'utf8'));
  assert.ok(cluster.send(node, { t: 'job.offer', job: 7, agent: 'codex' }));
  await waitFor(() => got('job.accept', 7).length, { timeout: 5000 });
  assert.ok(cluster.send(node, {
    t: 'job.start', job: 7, title: 'Add hello.txt', prompt: 'Create hello.txt', agent: 'codex', repo: REPO, baseSha,
    branch: 'agent-orch/task-7', doneWhen: '`test -s hello.txt` passes', timeouts: { taskSec: 60, verifySec: 30, installSec: 60 },
  }));
  const [done] = await waitFor(() => got('job.done', 7).length && got('job.done', 7), { timeout: 30000, message: `job.done\n${workerOut}` });
  assert.equal(done.outcome, 'ok', done.text);
  assert.match(done.text, /hello\.txt added/);
  assert.equal(done.sessionId, '01a0d699-1efd-7d72-b9f4-000000000218');
  const events = got('job.event', 7).flatMap((f) => f.events);
  assert.ok(events.some((e) => e.k === 'tool' && e.name === 'Edit'), 'streamed the agent events');
  assert.equal(got('job.event', 7)[0].from, 0);
  const [check] = got('job.check', 7);
  assert.deepEqual([check.command, check.pass, check.code], ['test -s hello.txt', true, 0]);
  assert.ok(frames.indexOf(check) < frames.indexOf(done), 'check before done');
  assert.equal(got('job.wip', 7).at(-1).sha, done.sha);
  // The branch on origin holds the agent's change, on top of the base.
  assert.equal(git(origin, 'rev-parse', 'refs/heads/agent-orch/task-7'), done.sha);
  assert.equal(git(origin, 'show', `${done.sha}:hello.txt`), 'hello from the stub agent');
  assert.equal(git(origin, 'rev-parse', `${done.sha}^`), baseSha);
  assert.match(git(origin, 'log', '-1', '--format=%s', done.sha), /^agent-orch #7: Add hello.txt/);
  // The worktree is cleaned up; the cache clone stays.
  const wt = path.join(home, '.agent-orch-worker', 'worktrees');
  await waitFor(() => fs.readdirSync(wt).length === 0, { timeout: 5000 });
  assert.ok(fs.existsSync(path.join(home, '.agent-orch-worker', 'repos', 'test-owner__demo.git', 'HEAD')));
  assert.ok(fs.readFileSync(path.join(home, '.agent-orch-worker', 'logs', 'worker.log'), 'utf8').includes('job 7 done: ok'));
});

test('a job whose base commit does not exist ends as setup_failed', async () => {
  const { node } = JSON.parse(fs.readFileSync(path.join(home, '.agent-orch-worker', 'config.json'), 'utf8'));
  cluster.send(node, {
    t: 'job.start', job: 8, title: 'Broken', prompt: 'x', agent: 'codex', repo: REPO, baseSha: 'f'.repeat(40),
    branch: 'agent-orch/task-8', timeouts: { taskSec: 60 },
  });
  const [done] = await waitFor(() => got('job.done', 8).length && got('job.done', 8), { timeout: 20000, message: `job.done 8\n${workerOut}` });
  assert.equal(done.outcome, 'setup_failed');
  assert.match(done.text, /setup failed/);
});

test('pause pushes WIP and keeps the worktree, resume finishes the job, cancel drops it', async () => {
  const { node } = JSON.parse(fs.readFileSync(path.join(home, '.agent-orch-worker', 'config.json'), 'utf8'));
  const start = (job) => cluster.send(node, {
    t: 'job.start', job, title: `Slow ${job}`, prompt: 'SLOW: create hello.txt', agent: 'codex', repo: REPO, baseSha,
    branch: `agent-orch/task-${job}`, timeouts: { taskSec: 120 },
  });
  const edited = (job) => waitFor(() => got('job.event', job).flatMap((f) => f.events).some((e) => e.k === 'tool'), { timeout: 20000, message: `events ${job}\n${workerOut}` });
  const wt = (job) => path.join(home, '.agent-orch-worker', 'worktrees', `demo-task-${job}`);
  start(9);
  await edited(9);
  cluster.send(node, { t: 'job.pause', job: 9 });
  const [wip] = await waitFor(() => got('job.wip', 9).length && got('job.wip', 9), { timeout: 20000, message: `wip 9\n${workerOut}` });
  assert.equal(git(origin, 'show', `${wip.sha}:hello.txt`), 'hello from the stub agent');
  assert.equal(got('job.done', 9).length, 0);
  assert.ok(fs.existsSync(path.join(wt(9), 'hello.txt')), 'a paused job keeps its worktree');
  cluster.send(node, { t: 'job.resume', job: 9, prompt: 'now finish' });
  const [done] = await waitFor(() => got('job.done', 9).length && got('job.done', 9), { timeout: 20000, message: `done 9\n${workerOut}` });
  assert.equal(done.outcome, 'ok');
  assert.equal(git(origin, 'rev-parse', 'refs/heads/agent-orch/task-9'), done.sha);

  start(10);
  await edited(10);
  cluster.send(node, { t: 'job.cancel', job: 10, reason: 'reassigned' });
  await waitFor(() => !fs.existsSync(wt(10)), { timeout: 20000, message: `cancel 10\n${workerOut}` });
  assert.equal(got('job.done', 10).length, 0);
  assert.equal(got('job.wip', 10).length, 0, 'a reassigned job is not pushed');
});
