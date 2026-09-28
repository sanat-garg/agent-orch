// Cluster e2e through the head's git endpoint (#345; cluster-git.mjs, feature 'git'). Without GitHub: the controller's
// project has no remote at all and the worker no GitHub access; a paired worker.mjs clones the project through the head,
// runs a codex task, pushes its branch back through the head, and the controller merges it into main locally. Fallback:
// with the head's endpoint down, the worker clones from and pushes to GitHub (a temp bare repo behind url.insteadOf) as
// before, and the controller fetches the branch from origin and merges it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isolatedPath } from './helpers/isolated-path.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/test-owner/demo.git';
let tmp, logs = '';
const procs = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A home with a git identity (plus the GitHub URL mapped onto `origin` when given) and a bin dir with only the given
// agent stubs, under tmp/<run>/<name>.
function machine(dir, name, { stubs = {}, origin = null } = {}) {
  const home = path.join(dir, name, 'home'), bin = path.join(dir, name, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  isolatedPath(bin);
  for (const [cli, fixture] of Object.entries(stubs)) fs.writeFileSync(path.join(bin, cli), `#!/bin/sh\nexec node ${path.join(ROOT, 'test/fixtures', fixture)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.gitconfig'), `${origin ? `[url "file://${origin}"]\n\tinsteadOf = ${REPO}\n` : ''}[user]\n\tname = ${name}\n\temail = ${name}@test\n`);
  // No power readings: a Mac running this on battery would otherwise hold new jobs back (power.mjs intake).
  fs.writeFileSync(path.join(dir, name, 'power.json'), '{}');
  return { HOME: home, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off', GIT_CONFIG_NOSYSTEM: '1', AGENT_ORCH_WORKER_POWER: path.join(dir, name, 'power.json') };
}
function start(args, env) {
  const p = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', (d) => { logs += d; });
  procs.push(p);
  return p;
}
function seed(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
}
// The controller fixture (a codex task for the worker, a Claude one here) and a paired worker; resolves the fixture's rows.
async function runCluster(cenv, wenv, dataDir, project) {
  fs.mkdirSync(dataDir, { recursive: true });
  const controller = start(['test/fixtures/cluster-controller.mjs', dataDir, project], { ...cenv, CW_DATA_DIR: dataDir });
  const lines = readline.createInterface({ input: controller.stdout })[Symbol.asyncIterator]();
  const next = async () => { for (;;) { const { value, done } = await lines.next(); if (done) throw new Error(`controller exited\n${logs}`); if (value.startsWith('{')) return JSON.parse(value); } };
  const { base, code } = await next();
  await promisify(execFile)(process.execPath, ['worker.mjs', 'pair', '--controller', base, '--code', code, '--name', 'git-worker'], { cwd: ROOT, env: wenv });
  const worker = start(['worker.mjs', 'run'], wenv);
  worker.stdout.on('data', (d) => { logs += d; });
  const r = await next();
  worker.kill('SIGTERM');
  assert.ok(!r.error, `${r.error}\n${logs}`);
  const why = `\n${r.events.join('\n')}\n${logs}`;
  assert.equal(r.remote.status, 'done', `remote task: ${r.remote.result}${why}`);
  assert.equal(r.remote.node_id, r.worker, 'placed on the worker');
  assert.equal(r.local.status, 'done', `local task: ${r.local.result}${why}`);
  assert.equal(r.runs.find((x) => x.task_id === r.remote.id).outcome, 'ok');
  // The worker's commit is on the controller's main, merged here; the task branch is gone.
  assert.equal(git(project, 'show', 'main:hello.txt'), 'hello from the stub agent');
  assert.equal(git(project, 'show', 'main:local.txt'), 'written on the controller');
  assert.match(git(project, 'log', '--format=%s', 'main'), new RegExp(`agent-orch #${r.remote.id}: Add hello\\.txt`));
  assert.equal(git(project, 'branch', '--list', `agent-orch/task-${r.remote.id}`), '');
  return { ...r, base, why };
}

before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cluster-git-e2e-'))); });
after(async () => {
  for (const p of procs) if (p.exitCode == null) p.kill('SIGTERM');
  await Promise.all(procs.map((p) => p.exitCode != null ? null : new Promise((r) => { const t = setTimeout(() => { p.kill('SIGKILL'); r(); }, 10000); p.on('exit', () => { clearTimeout(t); r(); }); })));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('a worker clones and pushes through the head, and the head merges, with no GitHub remote', { timeout: 150_000 }, async () => {
  const dir = path.join(tmp, 'head');
  const cenv = machine(dir, 'controller'), wenv = machine(dir, 'worker', { stubs: { codex: 'worker-agent-stub.mjs' } });
  const project = path.join(dir, 'controller', 'demo');
  seed(project);
  assert.equal(git(project, 'remote'), '', 'no remote at all');
  const r = await runCluster(cenv, wenv, path.join(dir, 'controller', 'data'), project);
  const run = r.runs.find((x) => x.task_id === r.remote.id);
  assert.deepEqual(JSON.parse(run.errors || '[]'), [], `no job errors${r.why}`);

  // The worker's cache came from the head; the token sits only in that cache's 0600 include file, never in its config.
  const repos = path.join(wenv.HOME, '.agent-orch-worker', 'repos');
  const [cache] = fs.readdirSync(repos).filter((d) => d.startsWith('head-'));
  assert.ok(cache, `a head cache in ${fs.readdirSync(repos)}`);
  assert.equal(git(path.join(repos, cache), 'config', '--get', 'remote.origin.url'), `${r.base}/api/cluster/git/${r.remote.project_id}.git`);
  const token = JSON.parse(fs.readFileSync(path.join(wenv.HOME, '.agent-orch-worker', 'config.json'), 'utf8')).token;
  assert.ok(!fs.readFileSync(path.join(repos, cache, 'config'), 'utf8').includes(token));
  assert.equal(fs.statSync(path.join(repos, cache, 'agent-orch-auth.config')).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(wenv.HOME, '.gitconfig'), 'utf8').includes(token), 'nothing global');
  assert.ok(!logs.includes(token), 'the token is in no log');
});

test("with the head's git endpoint down, a worker with GitHub access uses GitHub as before", { timeout: 150_000 }, async () => {
  const dir = path.join(tmp, 'fallback'), origin = path.join(dir, 'origin.git');
  const s = path.join(dir, 'seed');
  seed(s);
  git(dir, 'clone', '-q', '--bare', s, origin);
  const cenv = { ...machine(dir, 'controller', { origin }), CW_TEST_HEAD_GIT_DOWN: '1' }, wenv = machine(dir, 'worker', { stubs: { codex: 'worker-agent-stub.mjs' }, origin });
  const project = path.join(dir, 'controller', 'demo');
  execFileSync('git', ['clone', '-q', REPO, project], { env: cenv, stdio: 'ignore' });
  const r = await runCluster(cenv, wenv, path.join(dir, 'controller', 'data'), project);
  assert.match(logs, /the head's git endpoint failed \(.*502.*\); using https:\/\/github\.com\/test-owner\/demo\.git/);
  assert.ok(fs.existsSync(path.join(wenv.HOME, '.agent-orch-worker', 'repos', 'test-owner__demo.git', 'HEAD')), 'the GitHub cache');
  assert.equal(git(origin, 'branch', '--list', `agent-orch/task-${r.remote.id}`), '', 'the pushed branch was deleted on origin after the merge');
});
