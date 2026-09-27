// Worker reports on the controller (orchestrator.mjs remote jobs + cluster.mjs), with a fake worker speaking the wire
// protocol to a real controller (test/fixtures/cluster-failover-controller.mjs, its own CW_DATA_DIR): a job's phase
// timeline and progress hints are stored on its run and shown by the task detail, structured job errors are kept and
// logged, and a worker where 3 tasks failed that no other machine failed is drained automatically with a notice.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, WS_PATH, CLAIM_PATH, FEATURE_LIST, createSender } from '../cluster-protocol.mjs';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/test-owner/demo.git';
let tmp, origin, clone, ctl, w, logs = '';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The controller process and its command channel (one JSON line per command and per answer).
function startController(dataDir, project, env) {
  const p = spawn(process.execPath, ['test/fixtures/cluster-failover-controller.mjs', dataDir, project, '60000'], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  p.stderr.on('data', (d) => { logs += d; });
  const lines = readline.createInterface({ input: p.stdout })[Symbol.asyncIterator]();
  const next = async () => { for (;;) { const { value, done } = await lines.next(); if (done) throw new Error(`controller exited\n${logs}`); if (value.startsWith('{')) return JSON.parse(value); } };
  let chain = Promise.resolve();
  const cmd = (c) => (chain = chain.then(() => { p.stdin.write(`${JSON.stringify(c)}\n`); return next(); }));
  return { p, cmd, ready: next() };
}
const get = (id) => ctl.cmd({ cmd: 'get', id });
const nodeView = async () => (await ctl.cmd({ cmd: 'nodes' })).nodes.find((n) => n.id === w.node);
const until = (f, message, timeout = 20_000) => waitFor(f, { timeout, interval: 100, message: `${message}\n${logs}` });

// The worker side of a task: what each scripted job sends back, by the task's prompt.
function pushBranch(id, baseSha) {
  git(clone, 'fetch', '-q', 'origin');
  git(clone, 'checkout', '-q', '-B', `agent-orch/task-${id}`, baseSha);
  fs.writeFileSync(path.join(clone, 'phases.txt'), 'written by the fake worker\n');
  git(clone, 'add', '-A');
  git(clone, '-c', 'user.name=w', '-c', 'user.email=w@w', 'commit', '-q', '-m', `agent-orch #${id}: phases`);
  git(clone, 'push', '-q', '-f', 'origin', `HEAD:refs/heads/agent-orch/task-${id}`);
  return git(clone, 'rev-parse', 'HEAD');
}
const T0 = Date.now() - 60_000;
function play(start) {
  const id = start.job, send = w.send;
  const phase = (p, at, ms, extra = {}) => send('job.phase', { job: id, phase: p, at: T0 + at, ...(ms != null ? { ms } : {}), ...extra });
  if (start.prompt.includes('PHASES')) {
    phase('queued', 0);
    phase('fetching', 100, 100);
    phase('installing', 400, 300);
    phase('running', 1000, 600);
    send('job.event', { job: id, from: 0, events: [{ k: 'text', text: 'Working on it' }, { k: 'tool', name: 'Bash', id: 't1', input: { command: 'npm test' } }] });
    phase('running', 1000, null, { progress: { tools: 1, files: 0, last: 'Bash · npm test' } });
    phase('running', 1000, null, { progress: { tools: 2, files: 1, last: 'Edit · phases.txt' } });
    phase('fetching', 100, 100); // a replay after a reconnect: already stored
    phase('checking', 3000, 2000);
    send('job.check', { job: id, command: 'test -s phases.txt', output: '', pass: true, code: 0 });
    phase('committing', 3500, 500);
    const sha = pushBranch(id, start.baseSha);
    phase('pushing', 3600, 100);
    send('job.wip', { job: id, sha, branch: `agent-orch/task-${id}` });
    phase('done', 4000, 400, { outcome: 'ok' });
    send('job.done', { job: id, outcome: 'ok', text: 'AGENT-ORCH-STATUS: done — phases.txt added', usage: { input_tokens: 5, output_tokens: 1 }, sha, sessionId: 's-1' });
  } else if (start.prompt.includes('FAIL')) {
    phase('queued', 0);
    phase('fetching', 10, 10);
    phase('running', 20, 10);
    const err = { job: id, kind: 'agent_crash', message: 'codex exited with an error', stderr: 'thread main panicked: out of cheese\n', at: T0 + 30 };
    send('job.error', err);
    send('job.error', err); // replayed: kept once
    send('job.error', { ...err, at: T0 + 35 }); // the same failure again: counted
    send('job.error', err); // a late replay of the first: still once
    phase('done', 40, 20, { outcome: 'error' });
    send('job.done', { job: id, outcome: 'error', text: 'codex exited with an error' });
  }
}

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-reports-')));
  origin = path.join(tmp, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  clone = path.join(tmp, 'clone');
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' });
  fs.writeFileSync(path.join(clone, 'README.md'), '# demo\n');
  git(clone, 'add', '-A');
  git(clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(clone, 'push', '-q', 'origin', 'HEAD:main');
  // The controller has no codex: codex tasks can only run on the (fake) worker.
  const home = path.join(tmp, 'controller', 'home'), bin = path.join(tmp, 'controller', 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  isolatedPath(bin);
  fs.writeFileSync(path.join(home, '.gitconfig'), `[url "file://${origin}"]\n\tinsteadOf = ${REPO}\n[user]\n\tname = controller\n\temail = c@test\n`);
  const env = { HOME: home, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off' };
  const dataDir = path.join(tmp, 'controller', 'data'), project = path.join(tmp, 'controller', 'demo');
  fs.mkdirSync(dataDir);
  execFileSync('git', ['clone', '-q', REPO, project], { env, stdio: 'ignore' });
  ctl = startController(dataDir, project, { ...env, CW_DATA_DIR: dataDir });
  const { port } = await ctl.ready;
  const base = `http://127.0.0.1:${port}`;

  // Pair the fake worker, dial in, say hello with every feature, and act like a worker with codex signed in.
  const { code } = await ctl.cmd({ cmd: 'pair' });
  const r = await fetch(base + CLAIM_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'fake-worker', os: 'linux', arch: 'arm64' }) });
  const { node, token } = await r.json();
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${token}` } });
  const frames = [], sender = createSender('w');
  const send = (t, f = {}) => { if (ws.readyState === WebSocket.OPEN) ws.send(sender(t, f)); };
  w = { node, ws, frames, send, got: (t, job) => frames.filter((f) => f.t === t && (job == null || f.job === job)) };
  ws.on('message', (d) => {
    const f = JSON.parse(d);
    frames.push(f);
    if (f.t === 'heartbeat') send('heartbeat');
    if (f.t === 'job.offer') send('job.accept', { job: f.job });
    if (f.t === 'job.start') play(f);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  send('hello', { node, protocol: PROTOCOL_VERSION, version: '1.0.0', jobs: [], features: FEATURE_LIST });
  await until(() => frames.find((f) => f.t === 'welcome'), 'welcome');
  assert.deepEqual(frames.find((f) => f.t === 'welcome').features, FEATURE_LIST, 'the controller reads every newer frame type');
  send('inventory', { node, name: 'fake-worker', os: 'linux', arch: 'arm64', cores: 4, mem: 16e9, versions: { agentOrch: '1.0.0' },
    agents: [{ id: 'codex', installed: true, signedIn: true, version: '0.157.0', account: 'me@test', models: [{ id: 'gpt-5.5-codex' }] }] });
  send('resources', { memAvailable: 8e9, load: [0.1, 0.1, 0.1], running: [], swapUsedPct: 0 });
  await until(async () => (await nodeView())?.status === 'online', 'worker online');
});

after(async () => {
  w?.ws.terminate();
  if (ctl?.p.exitCode == null) {
    ctl.p.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(() => { ctl.p.kill('SIGKILL'); r(); }, 10000); ctl.p.on('exit', () => { clearTimeout(t); r(); }); });
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('a remote job’s phase timeline and progress hints are stored on its run and shown in the task detail', { timeout: 60_000 }, async () => {
  const { id } = await ctl.cmd({ cmd: 'task', title: 'Phases', prompt: 'PHASES: create phases.txt', agent: 'codex', files: ['phases.txt'], doneWhen: '`test -s phases.txt` passes' });
  const r = await until(async () => { const x = await get(id); return ['done', 'failed'].includes(x.task.status) && x; }, `#${id} finished`, 30_000);
  assert.equal(r.task.status, 'done', `${r.task.result}\n${r.events.join('\n')}`);
  assert.equal(r.task.node_id, w.node);
  assert.equal(r.runs.length, 1);
  const phases = JSON.parse(r.runs[0].phases);
  assert.deepEqual(phases.map((p) => p.phase), ['queued', 'fetching', 'installing', 'running', 'checking', 'committing', 'pushing', 'done'], 'in order, the replay not repeated');
  assert.deepEqual(phases.map((p) => p.ms ?? null), [100, 300, 600, 2000, 500, 100, 400, null], "each phase's duration, as the worker measured it");
  assert.deepEqual(phases.map((p) => p.w - T0), [0, 100, 400, 1000, 3000, 3500, 3600, 4000]);
  assert.ok(phases.every((p) => Math.abs(p.at - p.w) < 5000), 'stamped on the controller clock');
  assert.deepEqual(phases[3].progress, { tools: 2, files: 1, last: 'Edit · phases.txt' }, 'the latest hints on the running phase');
  assert.equal(phases.at(-1).outcome, 'ok');
  assert.equal(JSON.parse(r.runs[0].errors || '[]').length, 0);
  // The task drawer's data: the same timeline without the worker's own timestamps.
  const d = await ctl.cmd({ cmd: 'detail', id });
  const run = d.runs[0];
  assert.equal(run.node, w.node);
  assert.deepEqual(run.phases.map((p) => p.phase), phases.map((p) => p.phase));
  assert.ok(run.phases.every((p) => p.w === undefined));
  assert.deepEqual(run.errors, []);
  assert.equal(git(origin, 'show', 'main:phases.txt'), 'written by the fake worker', 'merged as usual');
});

test('job errors are kept on the run; 3 failed tasks no other machine failed drain the worker, with a notice', { timeout: 90_000 }, async () => {
  const task = async (title) => (await ctl.cmd({ cmd: 'task', title, prompt: `FAIL ${title}`, agent: 'codex', files: [`${title}.txt`] })).id;
  const failedRun = (id) => until(async () => { const x = await get(id); const run = x.runs.find((y) => y.node_id === w.node && y.finished_at); return run && { ...x, run }; }, `#${id} failed on the worker`);
  // #1 also failed on the controller: the task is at fault, not the worker.
  const t1 = await task('f1');
  await ctl.cmd({ cmd: 'sql', sql: "INSERT INTO runs(task_id,purpose,agent,node_id,started_at,finished_at,outcome) VALUES(?, 'work', 'codex', 'controller', ?, ?, 'error')", params: [t1, Date.now() / 1000 - 60, Date.now() / 1000 - 30] });
  const r1 = await failedRun(t1);
  assert.equal(r1.run.outcome, 'error');
  const errors = JSON.parse(r1.run.errors);
  assert.equal(errors.length, 1, 'a repeat counts up; replays count once');
  assert.deepEqual([errors[0].kind, errors[0].message, errors[0].count], ['agent_crash', 'codex exited with an error', 2]);
  assert.match(errors[0].stderr, /out of cheese/);
  assert.ok(r1.events.includes(`#${t1} on fake-worker: agent_crash: codex exited with an error`), r1.events.join('\n'));
  assert.deepEqual(JSON.parse(r1.run.phases).map((p) => [p.phase, p.outcome ?? null]).at(-1), ['done', 'error']);
  const t2 = await task('f2');
  await failedRun(t2);
  const t3 = await task('f3');
  await failedRun(t3);
  await sleep(300);
  assert.equal((await nodeView()).draining, false, 'two unreproduced failures are not enough');
  const t4 = await task('f4');
  await failedRun(t4);
  const n = await until(async () => { const x = await nodeView(); return x.draining && x; }, 'auto-drained');
  assert.equal(n.drainReason, `3 tasks failed there in 30 min (#${t2}, #${t3}, #${t4}) and no other machine failed them`);
  const { events } = await get(t4);
  assert.ok(events.some((m) => m.startsWith('fake-worker was drained automatically: 3 tasks failed there')), events.join('\n'));
  // Nothing new is offered to it (with no other codex machine, routing moves a codex task to Claude on the controller).
  const t5 = await task('f5');
  await until(async () => (await get(t5)).runs.length, `#${t5} ran elsewhere`);
  await sleep(500);
  assert.equal(w.got('job.offer', t5).length, 0);
  // The owner undrains it: new work goes there again, and the failures before that no longer count.
  await ctl.cmd({ cmd: 'node', id: w.node, body: { draining: false } });
  const t6 = await task('f6');
  assert.equal((await failedRun(t6)).run.outcome, 'error');
  await sleep(300);
  assert.equal((await nodeView()).draining, false);
});
