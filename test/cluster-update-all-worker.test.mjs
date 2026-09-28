// Update all (#458) on a real worker.mjs process against an in-test hub (cluster.mjs on a local HTTP/WS server), with a
// stub codex, a stub npm and a scratch agent-orch checkout (AGENT_ORCH_WORKER_SRC) whose origin has a newer commit.
// node.update {mode: 'now'} while a job runs: the job pauses (its WIP pushed), a checkout with local changes is refused and
// the job resumes at once; clean, it fetches and resets to the head's sha, updates the CLIs (clis: true), reports each
// step, saves the paused job and exits for its service to restart it. Started again it says hello with the job paused;
// once the head attaches and resumes it, the job finishes there.
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
import { isolatedPath } from './helpers/isolated-path.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/test-owner/demo.git';
let tmp, home, bin, origin, baseSha, src, srcOrigin, srcSha, server, hub, port, node, out = '';
const workers = [], frames = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const env = () => ({ HOME: home, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off', AGENT_ORCH_WORKER_SRC: src, AGENT_ORCH_WORKER_NET_PROBE: `127.0.0.1:${port}` });
const got = (t, job) => frames.filter((f) => f.t === t && (job == null || f.job === job));
const until = (f, message, timeout = 30_000) => waitFor(f, { timeout, message: `${message}\n${out}` });
const start = (job, over = {}) => hub.send(node, {
  t: 'job.start', job, title: `Job ${job}`, prompt: 'SLOW: create hello.txt', agent: 'codex', repo: REPO, baseSha,
  branch: `agent-orch/task-${job}`, timeouts: { taskSec: 120, verifySec: 30, installSec: 60 }, ...over,
});
function runWorker() {
  const w = spawn(process.execPath, ['worker.mjs', 'run'], { cwd: ROOT, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  w.stdout.on('data', (d) => { out += d; });
  w.stderr.on('data', (d) => { out += d; });
  workers.push(w);
  return w;
}
const commit = (dir, msg) => git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', msg);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-update-now-'));
  home = path.join(tmp, 'home');
  bin = path.join(tmp, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  isolatedPath(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node ${path.join(ROOT, 'test/fixtures/worker-agent-stub.mjs')} "$@"\n`, { mode: 0o755 });
  // npm: records its arguments (the Codex CLI update), never installs anything.
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$@" >> ${path.join(tmp, 'npm-args')}\n`, { mode: 0o755 });
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
  // The worker's own agent-orch checkout, a stand-in the update resets.
  srcOrigin = path.join(tmp, 'agent-orch.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', srcOrigin]);
  src = path.join(tmp, 'agent-orch-worker');
  execFileSync('git', ['clone', '-q', srcOrigin, src], { stdio: 'ignore' });
  fs.writeFileSync(path.join(src, 'worker.mjs'), 'export const version = 1;\n');
  git(src, 'add', '-A');
  git(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'v1');
  git(src, 'push', '-q', 'origin', 'HEAD:main');
  srcSha = git(src, 'rev-parse', 'HEAD');

  hub = createCluster({ dbFile: path.join(tmp, 'hub.db'), heartbeatMs: 300, health: { diskMinBytes: 0 } });
  hub.onMessage((n, msg) => frames.push({ node: n, ...msg }));
  server = http.createServer(async (req, res) => {
    if (req.url !== CLAIM_PATH || req.method !== 'POST') { res.writeHead(404); return res.end(); }
    let body = '';
    for await (const c of req) body += c;
    const r = hub.claim(JSON.parse(body));
    res.writeHead(r.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.status ? { error: r.error } : r));
  });
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const { code } = hub.createPairing();
  await promisify(execFile)(process.execPath, ['worker.mjs', 'pair', '--controller', `http://127.0.0.1:${port}`, '--code', code, '--name', 'updater'], { cwd: ROOT, env: env() });
  node = JSON.parse(fs.readFileSync(path.join(home, '.agent-orch-worker', 'config.json'), 'utf8')).node;
  runWorker();
  await until(() => hub.node(node)?.inventory?.agents?.find((a) => a.id === 'codex')?.signedIn, 'worker online with codex');
});

after(async () => {
  for (const w of workers) {
    if (w.exitCode != null || w.signalCode) continue;
    w.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(() => { w.kill('SIGKILL'); r(); }, 10000); w.on('exit', () => { clearTimeout(t); r(); }); });
  }
  hub?.close();
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test("mode 'now': jobs pause, a dirty checkout fails and resumes them, a clean one updates, restarts and gets its job back", { timeout: 150_000 }, async () => {
  const phases = (job) => got('job.phase', job).map((f) => f.phase);
  const progress = () => got('update.progress').map((f) => f.stage);
  // A newer agent-orch on the checkout's origin.
  const dev = path.join(tmp, 'agent-orch-dev');
  execFileSync('git', ['clone', '-q', srcOrigin, dev], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dev, 'worker.mjs'), 'export const version = 2;\n');
  commit(dev, 'v2');
  git(dev, 'push', '-q', 'origin', 'HEAD:main');
  const target = git(dev, 'rev-parse', 'HEAD');

  // 1. A local change in the checkout: the job pauses, the update is refused with why, and the job goes on at once.
  start(41);
  await until(() => phases(41).includes('running'), 'job 41 running');
  fs.writeFileSync(path.join(src, 'worker.mjs'), 'export const version = 1; // local edit\n');
  assert.ok(hub.send(node, { t: 'node.update', mode: 'now', sha: target }));
  const [bad] = await until(() => got('node.error').length && got('node.error'), 'the refused update');
  assert.equal(bad.kind, 'update');
  assert.match(bad.message, /local changes \(worker\.mjs\): commit or discard them/);
  assert.deepEqual(progress(), ['pausing', 'pulling']);
  assert.match(out, /job 41 paused/, 'paused, its WIP pushed, before the checkout was looked at');
  assert.ok(got('job.wip', 41).length, 'its WIP was pushed on pause');
  await until(() => out.includes('job 41 resumed'), 'job 41 resumed after the failed update');
  await until(() => got('job.done', 41).length, 'job 41 finished');
  assert.equal(got('job.done', 41)[0].outcome, 'ok');
  assert.equal(git(src, 'rev-parse', 'HEAD'), srcSha, 'nothing changed');
  git(src, 'checkout', '--', 'worker.mjs');

  // 2. Clean: the running job pauses, the checkout is reset to the head's sha, the CLIs update, and it exits to restart.
  start(42);
  await until(() => phases(42).includes('running'), 'job 42 running');
  const first = workers[0], exited = new Promise((r) => first.once('exit', (code) => r(code)));
  assert.ok(hub.send(node, { t: 'node.update', mode: 'now', clis: true, sha: target }));
  assert.equal(await exited, 0, `exits for the service manager to restart it\n${out}`);
  assert.deepEqual(progress().slice(2), ['pausing', 'pulling', 'clis', 'restarting']);
  assert.equal(git(src, 'rev-parse', 'HEAD'), target, 'reset to the head\'s sha');
  assert.equal(got('bye').at(-1).reason, 'update');
  assert.ok(got('job.wip', 42).length, 'its WIP was pushed on pause');
  assert.equal(got('job.done', 42).length, 0, 'paused, not finished');
  assert.match(fs.readFileSync(path.join(tmp, 'npm-args'), 'utf8'), /^i -g @openai\/codex@latest$/m, 'the Codex CLI updated');
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.agent-orch-worker', 'update-paused.json'), 'utf8'));
  assert.deepEqual(saved.map((j) => j.spec.job), [42]);

  // 3. Its service starts the new code: hello lists the job paused; the head attaches and resumes it, and it finishes here.
  const hellos = got('hello').length;
  runWorker();
  const [hello] = await until(() => got('hello').length > hellos && got('hello').slice(hellos), 'hello after the restart');
  assert.equal(hello.sha, target);
  assert.deepEqual(hello.jobs.map((j) => [j.job, j.state]), [[42, 'paused']]);
  assert.ok(!fs.existsSync(path.join(home, '.agent-orch-worker', 'update-paused.json')), 'read once');
  const at = got('job.phase', 42).length;
  hub.send(node, { t: 'job.attach', job: 42, from: hello.jobs[0].next });
  hub.send(node, { t: 'job.resume', job: 42 });
  await until(() => got('job.done', 42).length, 'job 42 finished after the update');
  assert.equal(got('job.done', 42)[0].outcome, 'ok', got('job.done', 42)[0].text);
  assert.ok(got('job.phase', 42).slice(at).some((f) => f.phase === 'running'), 'it ran again');
});
