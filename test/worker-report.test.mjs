// What the worker daemon (worker.mjs) reports, run as a real process against an in-test hub (cluster.mjs on a local
// HTTP/WS server) with a stub codex and a temp bare repo as the project's GitHub origin: job.phase frames in order with
// progress hints, health telemetry on every resources frame, structured job errors (a failed setup, a failed install),
// the log tail over the socket, and node.update: refused while a job runs; when idle, a git pull of its checkout
// (AGENT_ORCH_WORKER_SRC, a scratch repo here) that is rolled back if the new code doesn't load, else an exit for the
// service manager to restart it.
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
import { CLAIM_PATH, FEATURE_LIST, PHASES } from '../cluster-protocol.mjs';
import { tailLines } from '../worker.mjs';
import { parseBattery, parseThermal } from '../resources.mjs';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/test-owner/demo.git';
let tmp, home, bin, origin, baseSha, src, srcOrigin, srcSha, server, hub, base, port, worker, node, out = '';
const frames = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const env = () => ({ HOME: home, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off', AGENT_ORCH_WORKER_SRC: src, AGENT_ORCH_WORKER_NET_PROBE: `127.0.0.1:${port}` });
const got = (t, job) => frames.filter((f) => f.t === t && (job == null || f.job === job));
const until = (f, message, timeout = 20_000) => waitFor(f, { timeout, message: `${message}\n${out}` });
const start = (job, over = {}) => hub.send(node, {
  t: 'job.start', job, title: `Job ${job}`, prompt: 'Create hello.txt', agent: 'codex', repo: REPO, baseSha,
  branch: `agent-orch/task-${job}`, timeouts: { taskSec: 120, verifySec: 30, installSec: 60 }, ...over,
});
const phasesOf = (job) => got('job.phase', job);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wreport-'));
  home = path.join(tmp, 'home');
  bin = path.join(tmp, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  isolatedPath(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node ${path.join(ROOT, 'test/fixtures/worker-agent-stub.mjs')} "$@"\n`, { mode: 0o755 });
  // The project: a bare repo with one commit on main, seen by the worker's git under the GitHub URL.
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
  // The worker's own agent-orch checkout (a stand-in: node.update pulls this one, never the real repo).
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
  base = `http://127.0.0.1:${port}`;

  const { code } = hub.createPairing();
  await promisify(execFile)(process.execPath, ['worker.mjs', 'pair', '--controller', base, '--code', code, '--name', 'reporter'], { cwd: ROOT, env: env() });
  node = JSON.parse(fs.readFileSync(path.join(home, '.agent-orch-worker', 'config.json'), 'utf8')).node;
  worker = spawn(process.execPath, ['worker.mjs', 'run'], { cwd: ROOT, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', (d) => { out += d; });
  worker.stderr.on('data', (d) => { out += d; });
  await until(() => hub.node(node)?.inventory?.agents?.find((a) => a.id === 'codex')?.signedIn, 'worker online with codex');
});

after(async () => {
  if (worker && worker.exitCode == null) {
    worker.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(() => { worker.kill('SIGKILL'); r(); }, 10000); worker.on('exit', () => { clearTimeout(t); r(); }); });
  }
  hub?.close();
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('hello and telemetry: sha, features, CPU per core, disk, GitHub reachability, agents, uptimes and version', async () => {
  const hello = got('hello')[0];
  assert.equal(hello.sha, srcSha, "the worker's agent-orch sha");
  assert.deepEqual(hello.features, FEATURE_LIST);
  const r = await until(() => got('resources').find((f) => f.cpu && f.net && f.agents), 'a full telemetry frame');
  assert.equal(r.cpu.length, os.cpus().length);
  assert.ok(r.cpu.every((c) => c >= 0 && c <= 100));
  assert.ok(r.memTotal > 0 && r.memAvailable > 0 && r.swapTotal >= 0 && r.swapUsed >= 0);
  assert.equal(r.disk.path, path.join(home, '.agent-orch-worker'));
  assert.ok(r.disk.free > 0 && r.disk.total >= r.disk.free);
  assert.deepEqual([r.net.host, r.net.ok], ['127.0.0.1', true], 'the probe reached the controller stand-in');
  assert.ok(r.net.ms >= 0);
  assert.deepEqual(r.agents.find((a) => a.id === 'codex'), { id: 'codex', installed: true, version: '0.157.0', signedIn: true });
  assert.ok(r.uptime > 0 && r.procUptime >= 0);
  assert.equal(r.version, '1.0.0');
  assert.equal(r.sha, srcSha);
  assert.deepEqual(r.running, []);
  if (process.platform !== 'darwin') assert.equal(r.battery, undefined);
  assert.equal(hub.node(node).sha, srcSha);
});

test('a Mac reports its battery and thermal state (pmset readings)', () => {
  assert.deepEqual(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t64%; charging; 1:10 remaining present: true\n"), { pct: 64, charging: true, source: 'ac' });
  assert.deepEqual(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t85%; discharging; 5:23 remaining present: true\n"), { pct: 85, charging: false, source: 'battery' });
  assert.deepEqual(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n"), { pct: 100, charging: false, source: 'ac' });
  assert.equal(parseBattery("Now drawing from 'AC Power'\n"), null, 'no battery (a Mac mini)');
  assert.deepEqual(parseThermal('Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded\n'),
    { pressure: 'nominal', speedLimit: null, warning: null });
  assert.deepEqual(parseThermal('CPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= 76\n'), { pressure: 'throttled', speedLimit: 76, warning: null });
  assert.equal(parseThermal(''), null);
});

test('a job reports its phases in order, with progress hints while the agent runs', async () => {
  start(21, { doneWhen: '`test -s hello.txt` passes' });
  const [done] = await until(() => got('job.done', 21).length && got('job.done', 21), 'job.done 21');
  assert.equal(done.outcome, 'ok', done.text);
  const phases = phasesOf(21).filter((f) => !f.progress);
  assert.deepEqual(phases.map((f) => f.phase), ['queued', 'cloning', 'running', 'checking', 'committing', 'pushing', 'done']);
  assert.ok(phases.every((f, i) => PHASES.indexOf(f.phase) > (i ? PHASES.indexOf(phases[i - 1].phase) : -1)));
  assert.equal(phases[0].ms, undefined);
  assert.ok(phases.slice(1).every((f, i) => f.ms === f.at - phases[i].at), 'each frame carries the one before it');
  assert.equal(phases.at(-1).outcome, 'ok');
  const hint = phasesOf(21).find((f) => f.progress);
  assert.equal(hint.phase, 'running');
  assert.equal(hint.at, phases[2].at, 'hints ride the running phase');
  assert.deepEqual(hint.progress, { tools: 1, files: 1, last: 'Edit · add hello.txt' });
  assert.ok(frames.indexOf(hint) < frames.indexOf(phases[3]), 'the last hints go out before the next phase');
  assert.ok(frames.indexOf(phases.at(-1)) < frames.indexOf(done));
  // A second job of the same repo fetches the cached clone instead.
  start(22);
  await until(() => got('job.done', 22).length, 'job.done 22');
  assert.equal(phasesOf(22)[1].phase, 'fetching');
});

test('failed setups and installs are reported as structured job errors', async () => {
  start(23, { baseSha: 'f'.repeat(40) });
  const [done] = await until(() => got('job.done', 23).length && got('job.done', 23), 'job.done 23');
  assert.equal(done.outcome, 'setup_failed');
  const [err] = got('job.error', 23);
  assert.equal(err.kind, 'setup_failed');
  assert.ok(err.message && err.at > 0);
  assert.ok(err.stderr || err.stack, 'with a stderr tail or a stack');
  assert.deepEqual(phasesOf(23).map((f) => [f.phase, f.outcome ?? null]).at(-1), ['done', 'setup_failed']);

  start(24, { install: ['bash', '-c', 'echo "npm ERR! no such package" >&2; exit 3'] });
  await until(() => got('job.done', 24).length, 'job.done 24');
  const [ierr] = got('job.error', 24);
  assert.equal(ierr.kind, 'install_failed');
  assert.match(ierr.message, /sh -c .* failed: npm ERR! no such package/);
  assert.match(ierr.stderr, /npm ERR! no such package/);
  assert.deepEqual(phasesOf(24).map((f) => f.phase), ['queued', 'fetching', 'installing', 'done']);
});

test('the log tail comes back over the socket', async () => {
  const r = await hub.logsTail(node, 5);
  assert.equal(r.lines.length, 5, JSON.stringify(r));
  assert.ok(r.lines.every((l) => /^\d{4}-\d\d-\d\dT\S+ (info|warn|error) /.test(l)), r.lines.join('\n'));
  assert.ok((await hub.logsTail(node, 400)).lines.some((l) => l.includes('welcomed as')));
  // The tail helper itself: the rotated log fills in, lines are clipped, the oldest go first.
  const f = path.join(tmp, 'x.log');
  fs.writeFileSync(`${f}.1`, 'old 1\nold 2\n');
  fs.writeFileSync(f, `new 1\n${'y'.repeat(3000)}\nnew 3\n`);
  const t = tailLines(f, 4);
  assert.deepEqual([t[0], t[1], t[2].length, t[3]], ['old 2', 'new 1', 2001, 'new 3']);
  assert.deepEqual(tailLines(path.join(tmp, 'missing.log'), 3), []);
});

test('node.update is refused while a job runs; once idle it pulls, rolls back code that does not load, and exits to restart', { timeout: 90_000 }, async () => {
  start(25, { prompt: 'SLOW: create hello.txt' });
  await until(() => phasesOf(25).some((f) => f.phase === 'running'), 'job 25 running');
  // A newer agent-orch on its origin.
  const other = path.join(tmp, 'agent-orch-dev');
  execFileSync('git', ['clone', '-q', srcOrigin, other], { stdio: 'ignore' });
  fs.writeFileSync(path.join(other, 'worker.mjs'), 'export const version = 2;\n');
  git(other, 'add', '-A');
  git(other, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'v2');
  git(other, 'push', '-q', 'origin', 'HEAD:main');
  assert.ok(hub.send(node, { t: 'node.update', sha: git(other, 'rev-parse', 'HEAD') }));
  const [busy] = await until(() => got('node.error').length && got('node.error'), 'refused');
  assert.equal(busy.kind, 'update');
  assert.match(busy.message, /^busy: 1 job on this machine$/);
  assert.equal(git(src, 'rev-parse', 'HEAD'), srcSha, 'nothing pulled');
  assert.equal(worker.exitCode, null, 'still running');

  hub.send(node, { t: 'job.cancel', job: 25, reason: 'reassigned' });
  await until(() => out.includes('job 25 cancelled'), 'job 25 cancelled');
  // Idle now, but the new code doesn't load: the checkout goes back to what it ran, and the worker keeps running.
  fs.writeFileSync(path.join(other, 'worker.mjs'), 'export const version = ;\n');
  git(other, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'broken');
  git(other, 'push', '-q', 'origin', 'HEAD:main');
  assert.ok(hub.send(node, { t: 'node.update', sha: git(other, 'rev-parse', 'HEAD') }));
  const bad = await until(() => got('node.error')[1], 'the failed update reported');
  assert.equal(bad.kind, 'update');
  assert.match(bad.message, /^loading the new worker\.mjs failed: SyntaxError/);
  assert.match(bad.stderr, /SyntaxError/);
  assert.equal(git(src, 'rev-parse', 'HEAD'), srcSha, 'rolled back');
  assert.equal(worker.exitCode, null);
  // Fixed upstream: this time it pulls, and exits for the service manager to start the new code.
  fs.writeFileSync(path.join(other, 'worker.mjs'), 'export const version = 3;\n');
  git(other, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'v3');
  git(other, 'push', '-q', 'origin', 'HEAD:main');
  const fixedSha = git(other, 'rev-parse', 'HEAD');
  const exited = new Promise((r) => worker.once('exit', (code) => r(code)));
  assert.ok(hub.send(node, { t: 'node.update', sha: fixedSha }));
  assert.equal(await exited, 0, `exits for the service manager to restart it\n${out}`);
  assert.equal(git(src, 'rev-parse', 'HEAD'), fixedSha, 'pulled');
  assert.equal(got('node.error').length, 2, 'nothing else went wrong');
  assert.equal(got('bye').at(-1).reason, 'update');
  assert.match(out, new RegExp(`updated ${srcSha.slice(0, 8)} → ${fixedSha.slice(0, 8)}; restarting`));
});
