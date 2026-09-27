// Cluster e2e (BRIEF goal 11, #219): a controller (orchestrator + hub, test/fixtures/cluster-controller.mjs, its own
// CW_DATA_DIR) and a paired worker.mjs process on this machine with separate homes. A temp bare repo is the project's
// GitHub `origin` (url.insteadOf maps the GitHub URL onto it on both sides). Two tasks: the codex one is placed on the
// worker (only it has codex), runs there, pushes its branch, and the controller fetches and merges it; the Claude one
// runs on the controller. Both land on main in origin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseJsonl } from '../orchestrator.mjs';
import { isolatedPath } from './helpers/isolated-path.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/test-owner/demo.git';
let tmp, origin, controller, worker, logs = '';
const procs = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A home with a git identity and the GitHub URL mapped onto the bare repo, and a bin dir with only the given agent stubs.
function machine(name, stubs = {}) {
  const home = path.join(tmp, name, 'home'), bin = path.join(tmp, name, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  isolatedPath(bin);
  for (const [cli, fixture] of Object.entries(stubs)) fs.writeFileSync(path.join(bin, cli), `#!/bin/sh\nexec node ${path.join(ROOT, 'test/fixtures', fixture)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.gitconfig'), `[url "file://${origin}"]\n\tinsteadOf = ${REPO}\n[user]\n\tname = ${name}\n\temail = ${name}@test\n`);
  return { HOME: home, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off' };
}
function start(args, env) {
  const p = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', (d) => { logs += d; });
  procs.push(p);
  return p;
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cluster-')));
  origin = path.join(tmp, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = path.join(tmp, 'seed');
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' });
  fs.writeFileSync(path.join(seed, 'README.md'), '# demo\n');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
});

after(async () => {
  for (const p of procs) if (p.exitCode == null) p.kill('SIGTERM');
  await Promise.all(procs.map((p) => p.exitCode != null ? null : new Promise((r) => { const t = setTimeout(() => { p.kill('SIGKILL'); r(); }, 10000); p.on('exit', () => { clearTimeout(t); r(); }); })));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('a task placed on a paired worker is merged into main by the controller; another runs locally', { timeout: 150_000 }, async () => {
  const cenv = machine('controller'), wenv = machine('worker', { codex: 'worker-agent-stub.mjs' });
  const dataDir = path.join(tmp, 'controller', 'data'), project = path.join(tmp, 'controller', 'demo');
  fs.mkdirSync(dataDir);
  execFileSync('git', ['clone', '-q', REPO, project], { env: cenv, stdio: 'ignore' });
  assert.equal(git(project, 'config', '--get', 'remote.origin.url'), REPO);

  controller = start(['test/fixtures/cluster-controller.mjs', dataDir, project], { ...cenv, CW_DATA_DIR: dataDir });
  const lines = readline.createInterface({ input: controller.stdout })[Symbol.asyncIterator]();
  const next = async () => { for (;;) { const { value, done } = await lines.next(); if (done) throw new Error(`controller exited\n${logs}`); if (value.startsWith('{')) return JSON.parse(value); } };
  const { base, code } = await next();

  await promisify(execFile)(process.execPath, ['worker.mjs', 'pair', '--controller', base, '--code', code, '--name', 'test-worker'], { cwd: ROOT, env: wenv });
  worker = start(['worker.mjs', 'run'], wenv);
  worker.stdout.on('data', (d) => { logs += d; });

  const r = await next();
  assert.ok(!r.error, r.error);
  const why = `\n${r.events.join('\n')}\n${logs}`;
  assert.equal(r.remote.status, 'done', `remote task: ${r.remote.result}${why}`);
  assert.equal(r.local.status, 'done', `local task: ${r.local.result}${why}`);
  // Placement: codex only exists on the worker; Claude runs on the controller.
  assert.equal(r.remote.node_id, r.worker);
  assert.equal(r.remote.ran_agent, 'codex');
  assert.equal(r.local.node_id, 'controller');
  const remoteRun = r.runs.find((x) => x.task_id === r.remote.id);
  assert.equal(remoteRun.node_id, r.worker);
  assert.equal(remoteRun.outcome, 'ok');
  assert.equal(remoteRun.input_tokens, 100, 'usage from job.done is recorded');
  // The worker's phase timeline (job.phase) is stored on the run.
  assert.deepEqual(JSON.parse(remoteRun.phases).map((p) => p.phase), ['queued', 'cloning', 'running', 'checking', 'committing', 'pushing', 'done']);
  // The worker's events were mirrored into the controller's run log like a local run's.
  const entries = parseJsonl(remoteRun.log);
  assert.equal(entries[0].k, 'start');
  assert.equal(entries[0].node, r.worker);
  assert.ok(entries.some((e) => e.k === 'text' && /Working on/.test(e.text)), 'agent text mirrored');
  assert.ok(entries.some((e) => e.k === 'tool'), 'tool events mirrored');
  assert.ok(r.events.some((m) => /runs on test-worker/.test(m)));
  // Both changes are on main in origin, and the merged task branch was deleted there.
  assert.equal(git(origin, 'show', 'main:hello.txt'), 'hello from the stub agent');
  assert.equal(git(origin, 'show', 'main:local.txt'), 'written on the controller');
  assert.equal(git(origin, 'branch', '--list', `agent-orch/task-${r.remote.id}`), '');
  assert.match(git(origin, 'log', '--format=%s', 'main'), new RegExp(`agent-orch #${r.remote.id}: Add hello\\.txt`));
  assert.ok(r.remote.commit_sha);
  assert.equal(r.remote.worktree, null, 'the fetched worktree was removed after the merge');
  // The controller's usage log counts the remote run's tokens under codex.
  const usage = parseJsonl(fs.readFileSync(path.join(dataDir, 'metrics', 'usage.jsonl'), 'utf8'));
  assert.ok(usage.some((u) => u.agent === 'codex' && u.ref === r.remote.id), 'remote usage in usage.jsonl');
});
