// Cluster failure handling (CLUSTER.md, Failure modes; #220): a controller (test/fixtures/cluster-failover-controller.mjs,
// its own CW_DATA_DIR, 4 s grace) and a paired worker.mjs process that reaches it through a TCP proxy in this test, so
// the test can cut the network and restart the controller behind a stable address. A temp bare repo is the GitHub
// `origin` on both sides. The stub codex streams "tick <i>" messages, so the run log shows lost or duplicated events.
//   1. a disconnect shorter than the grace period: the job keeps running and the stream resumes without duplicates;
//   2. a controller restart (SIGKILL): the task is re-adopted and its run log continues;
//   3. a disconnect past the grace period: the task moves to the controller and continues from the pushed WIP sha with
//      a handoff prompt; the worker, back later, is told to discard its copy;
//   4. draining the worker: its job finishes, and new work goes elsewhere.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseJsonl } from '../orchestrator.mjs';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/test-owner/demo.git';
const GRACE_MS = 4000;
let tmp, origin, cenv, wenv, dataDir, project, ctl, worker, proxy, nodeId, logs = '';
const procs = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A home with a git identity and the GitHub URL mapped onto the bare repo, and a bin dir with a stub codex.
function machine(name, codexEnv = '') {
  const home = path.join(tmp, name, 'home'), bin = path.join(tmp, name, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  isolatedPath(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\n${codexEnv}exec node ${path.join(ROOT, 'test/fixtures/worker-agent-stub.mjs')} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.gitconfig'), `[url "file://${origin}"]\n\tinsteadOf = ${REPO}\n[user]\n\tname = ${name}\n\temail = ${name}@test\n`);
  return { HOME: home, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off' };
}
function start(args, env) {
  const p = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  p.stderr.on('data', (d) => { logs += d; });
  procs.push(p);
  return p;
}

// A TCP proxy worker → controller: block() cuts every connection and refuses new ones until unblock().
function createProxy() {
  const socks = new Set();
  let target = 0, blocked = false;
  const server = net.createServer((c) => {
    if (blocked || !target) return c.destroy();
    const u = net.connect(target, '127.0.0.1');
    socks.add(c); socks.add(u);
    c.pipe(u); u.pipe(c);
    const drop = () => { c.destroy(); u.destroy(); socks.delete(c); socks.delete(u); };
    c.on('error', drop); u.on('error', drop); c.on('close', drop); u.on('close', drop);
  });
  return {
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    to: (port) => { target = port; },
    block: () => { blocked = true; for (const s of socks) s.destroy(); socks.clear(); },
    unblock: () => { blocked = false; },
    close: () => { for (const s of socks) s.destroy(); server.close(); },
  };
}

// The controller process and its command channel.
async function startController() {
  const p = start(['test/fixtures/cluster-failover-controller.mjs', dataDir, project, String(GRACE_MS)], { ...cenv, CW_DATA_DIR: dataDir });
  const lines = readline.createInterface({ input: p.stdout })[Symbol.asyncIterator]();
  const next = async () => { for (;;) { const { value, done } = await lines.next(); if (done) throw new Error(`controller exited\n${logs}`); if (value.startsWith('{')) return JSON.parse(value); } };
  let chain = Promise.resolve();
  const cmd = (c) => (chain = chain.then(() => { p.stdin.write(`${JSON.stringify(c)}\n`); return next(); }));
  const { port } = await next();
  proxy.to(port);
  return { p, cmd };
}
const get = (id) => ctl.cmd({ cmd: 'get', id });
const ticksIn = (run) => parseJsonl(run.log).filter((e) => e.k === 'text' && /^tick \d+$/.test(e.text)).map((e) => Number(e.text.slice(5)));
async function finished(id) {
  let r;
  try { return await waitFor(async () => { r = await get(id); return ['done', 'failed', 'cancelled', 'needs_integration'].includes(r.task.status) && r; }, { timeout: 60_000, interval: 300 }); }
  catch { throw new Error(`task #${id} did not finish: ${JSON.stringify(r?.task)}\n${r?.events.join('\n')}\n${logs}`); }
}
const until = (f, message, timeout = 20_000) => waitFor(f, { timeout, interval: 200, message: `${message}\n${logs}` });

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-failover-')));
  origin = path.join(tmp, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = path.join(tmp, 'seed');
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' });
  fs.writeFileSync(path.join(seed, 'README.md'), '# demo\n');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');

  cenv = machine('controller', 'STUB_RECORD=1 ');
  wenv = { ...machine('worker'), AGENT_ORCH_WORKER_BACKOFF_MAX_MS: '300' };
  dataDir = path.join(tmp, 'controller', 'data');
  project = path.join(tmp, 'controller', 'demo');
  fs.mkdirSync(dataDir);
  execFileSync('git', ['clone', '-q', REPO, project], { env: cenv, stdio: 'ignore' });

  proxy = createProxy();
  const base = `http://127.0.0.1:${await proxy.listen()}`;
  ctl = await startController();
  const { code } = await ctl.cmd({ cmd: 'pair' });
  await promisify(execFile)(process.execPath, ['worker.mjs', 'pair', '--controller', base, '--code', code, '--name', 'test-worker'], { cwd: ROOT, env: wenv });
  nodeId = JSON.parse(fs.readFileSync(path.join(wenv.HOME, '.agent-orch-worker', 'config.json'), 'utf8')).node;
  worker = start(['worker.mjs', 'run'], wenv);
  worker.stdout.on('data', (d) => { logs += d; });
  await until(async () => (await ctl.cmd({ cmd: 'nodes' })).nodes.find((n) => n.id === nodeId && n.status === 'online' && n.inventory?.agents?.some((a) => a.id === 'codex' && a.signedIn)), 'worker online');
});

after(async () => {
  proxy?.close();
  for (const p of procs) if (p.exitCode == null) p.kill('SIGTERM');
  await Promise.all(procs.map((p) => p.exitCode != null ? null : new Promise((r) => { const t = setTimeout(() => { p.kill('SIGKILL'); r(); }, 10000); p.on('exit', () => { clearTimeout(t); r(); }); })));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// A remote codex task that streams `ticks` messages; resolves once the controller has logged `seen` of them.
async function remoteTask(title, ticks, seen, file) {
  const { id } = await ctl.cmd({ cmd: 'task', title, prompt: `Create ${file}. WRITE:${file} TICKS:${ticks}`, agent: 'codex', files: [file], doneWhen: `\`test -s ${file}\` passes` });
  await until(async () => { const r = await get(id); return r.task.node_id === nodeId && r.runs.length && ticksIn(r.runs.at(-1)).length >= seen; }, `#${id} streaming on the worker`);
  return id;
}

test('a disconnect within the grace period: the job keeps running and its stream resumes without duplicates', { timeout: 90_000 }, async () => {
  const id = await remoteTask('Reconnect', 24, 3, 'a.txt');
  proxy.block();
  await until(async () => (await get(id)).task.view?.waiting_for === 'test-worker', 'waiting for test-worker');
  await sleep(1500); // ticks keep coming on the worker meanwhile
  proxy.unblock();
  const r = await finished(id);
  assert.equal(r.task.status, 'done', `${r.task.result}\n${r.events.join('\n')}\n${logs}`);
  assert.equal(r.task.node_id, nodeId);
  assert.equal(r.runs.length, 1, 'the same run continued');
  assert.deepEqual(ticksIn(r.runs[0]), [...Array(24).keys()], 'every tick exactly once, in order');
  assert.ok(r.events.some((m) => m === `#${id} waiting for test-worker`));
  assert.ok(r.events.some((m) => m.includes(`#${id}: test-worker is back`)));
  assert.equal(r.task.last_error, null);
});

test('a controller restart re-adopts the remote job and continues its run log', { timeout: 90_000 }, async () => {
  const id = await remoteTask('Restart', 24, 3, 'b.txt');
  ctl.p.kill('SIGKILL');
  await new Promise((r) => ctl.p.exitCode != null ? r() : ctl.p.on('exit', r));
  await sleep(1000); // ticks keep coming on the worker, buffered
  ctl = await startController();
  const r = await finished(id);
  assert.equal(r.task.status, 'done', `${r.task.result}\n${r.events.join('\n')}\n${logs}`);
  assert.equal(r.task.node_id, nodeId);
  assert.equal(r.runs.length, 1, 'the run was re-adopted, not restarted');
  assert.equal(r.runs[0].outcome, 'ok');
  assert.deepEqual(ticksIn(r.runs[0]), [...Array(24).keys()], 'every tick exactly once, in order');
  assert.ok(r.events.some((m) => m.startsWith(`#${id} re-adopted after a restart`)));
  assert.ok(!r.events.some((m) => /requeued \d+ interrupted/.test(m)), 'nothing was requeued');
});

test('past the grace period the task continues on another node from the pushed WIP sha with a handoff prompt', { timeout: 90_000 }, async () => {
  const id = await remoteTask('Reassign', 80, 3, 'c.txt');
  const wip = await until(async () => (await get(id)).task.wip_sha, 'a WIP push');
  proxy.block();
  const r = await finished(id);
  assert.equal(r.task.status, 'done', `${r.task.result}\n${r.events.join('\n')}\n${logs}`);
  assert.equal(r.task.node_id, 'controller', 'moved to the controller (the only other node)');
  assert.equal(r.runs.length, 2);
  assert.equal(r.runs[0].outcome, 'aborted');
  assert.ok(r.events.some((m) => m.includes(`#${id}: node test-worker disappeared; it moves to another machine`)));
  // The new run started on the task branch at the WIP sha, told what the lost run had done.
  const handoff = JSON.parse(git(origin, 'show', 'main:handoff.json'));
  assert.equal(handoff.head, wip);
  assert.match(handoff.prompt, /A previous session on the machine test-worker was interrupted/);
  assert.match(handoff.prompt, new RegExp(`Its work up to ${wip.slice(0, 12)}`));
  assert.match(handoff.prompt, /# Task #\d+: Reassign\n\nCreate c\.txt\. WRITE:c\.txt TICKS:80/, 'the original prompt');
  assert.match(handoff.prompt, /## Done when\n`test -s c\.txt` passes/);
  assert.match(handoff.prompt, /c\.txt \| 1 \+/, 'the diff stat');
  assert.match(handoff.prompt, /> tick \d+/, "the previous agent's last messages");
  assert.match(handoff.prompt, /## Its last tool calls/);
  assert.equal(git(origin, 'show', 'main:c.txt'), 'hello from the stub agent', 'the WIP work was merged');
  // The worker comes back: it is told to discard its copy, which never pushes over the moved task.
  proxy.unblock();
  await until(() => logs.includes(`job ${id} cancelled (reassigned)`), 'the worker discards the reassigned job');
  assert.equal(git(origin, 'branch', '--list', `agent-orch/task-${id}`), '', 'the old worker did not push the branch again');
});

test('a draining node finishes its job and takes no new ones', { timeout: 90_000 }, async () => {
  proxy.unblock(); // (already, unless the test before failed)
  await until(async () => (await ctl.cmd({ cmd: 'nodes' })).nodes.find((n) => n.id === nodeId && n.status === 'online'), 'worker back online');
  const id = await remoteTask('Drain', 12, 2, 'd.txt');
  const { node } = await ctl.cmd({ cmd: 'node', id: nodeId, body: { draining: true } });
  assert.equal(node.status, 'draining');
  const { id: next } = await ctl.cmd({ cmd: 'task', title: 'After drain', prompt: 'Create e.txt', agent: 'codex', files: ['e.txt'] });
  const r = await finished(id);
  assert.equal(r.task.status, 'done', `${r.task.result}\n${logs}`);
  assert.equal(r.task.node_id, nodeId, 'the running job finished on the draining node');
  assert.deepEqual(ticksIn(r.runs[0]), [...Array(12).keys()]);
  const n = await finished(next);
  assert.equal(n.task.status, 'done', `${n.task.result}\n${logs}`);
  assert.equal(n.task.node_id, 'controller', 'new work went elsewhere');
  assert.ok(n.runs.every((x) => x.node_id === 'controller'));
});
