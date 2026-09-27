// A MacBook worker end to end: worker.mjs against an in-process hub (cluster.mjs), a stub codex, and the Mac's power
// readings and caffeinate replaced by fixtures (AGENT_ORCH_WORKER_POWER, AGENT_ORCH_WORKER_CAFFEINATE), so it runs here.
// Two machines pair with one multi-use code under their own names; the worker gets its policy in welcome, keeps the
// machine awake (caffeinate -i -w <its pid>) only while a job runs on AC power, and declines new jobs on low battery or
// when hot until the power comes back or the owner relaxes its policy.
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
const REPO = 'https://github.com/test-owner/macdemo.git';
const BATT = (pct, source) => `Now drawing from '${source === 'ac' ? 'AC Power' : 'Battery Power'}'\n -InternalBattery-0 (id=4653155)\t${pct}%; ` +
  `${source === 'ac' ? 'charging' : 'discharging'}; 2:00 remaining present: true\n`;
let tmp, home, bin, baseSha, server, hub, base, worker, workerOut = '', powerFile, caffLog, node;
const frames = [];
const got = (t, job) => frames.filter((f) => f.t === t && (job == null || f.job === job));
const env = (h = home) => ({ HOME: h, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off', AGENT_ORCH_WORKER_NET_PROBE: 'off',
  AGENT_ORCH_WORKER_POWER: powerFile, AGENT_ORCH_WORKER_CAFFEINATE: path.join(bin, 'caffeinate'), CAFFEINATE_LOG: caffLog });
const workerCli = async (h, ...args) => (await promisify(execFile)(process.execPath, ['worker.mjs', ...args], { cwd: ROOT, env: env(h), encoding: 'utf8' })).stdout;
const power = (pct, source, pressure = 0) => fs.writeFileSync(powerFile, JSON.stringify({
  batt: BATT(pct, source), therm: 'Note: No thermal warning level has been recorded\n', pressure: `com.apple.system.thermalpressurelevel ${pressure}\n` }));
const caffeinate = () => (fs.existsSync(caffLog) ? fs.readFileSync(caffLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const view = () => hub.node(node);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-macos-worker-'));
  home = path.join(tmp, 'home');
  bin = path.join(tmp, 'bin');
  powerFile = path.join(tmp, 'power.json');
  caffLog = path.join(tmp, 'caffeinate.log');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  isolatedPath(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node ${path.join(ROOT, 'test/fixtures/worker-agent-stub.mjs')} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'caffeinate'), `#!/bin/sh\nexec node ${path.join(ROOT, 'test/fixtures/caffeinate-stub.mjs')} "$@"\n`, { mode: 0o755 });
  power(80, 'ac');
  const origin = path.join(tmp, 'origin.git'), seed = path.join(tmp, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' });
  fs.writeFileSync(path.join(seed, 'README.md'), '# mac demo\n');
  execFileSync('git', ['add', '-A'], { cwd: seed });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: seed });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: seed });
  baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: seed, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(home, '.gitconfig'), `[url "file://${origin}"]\n\tinsteadOf = ${REPO}\n[user]\n\tname = worker\n\temail = w@w\n`);

  hub = createCluster({ dbFile: path.join(tmp, 'hub.db'), heartbeatMs: 300 });
  hub.onMessage((id, msg) => frames.push({ node: id, ...msg }));
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
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (worker && worker.exitCode == null) {
    worker.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(() => { worker.kill('SIGKILL'); r(); }, 10000); worker.on('exit', () => { clearTimeout(t); r(); }); });
  }
  for (const c of caffeinate()) if (c.event === 'start' && alive(c.pid)) process.kill(c.pid, 'SIGKILL');
  hub?.close();
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('two machines pair with one multi-use code, each under its own name', async () => {
  const { code } = hub.createPairing({ uses: 2 });
  const second = path.join(tmp, 'home-2');
  fs.mkdirSync(second);
  // Named after its host (a Mac: 'MacBook Pro (<local host name>)'); the hub's own node has this host's name already.
  const host = os.hostname().split('.')[0], name = host.toLowerCase() === hub.node('controller').name.toLowerCase() ? `${host} 2` : host;
  assert.match(await workerCli(home, 'pair', '--controller', base, '--code', code), new RegExp(`paired as ${name} \\(`));
  assert.match(await workerCli(second, 'pair', '--controller', base, '--code', code, '--name', 'MacBook Air (spare)'), /paired as MacBook Air \(spare\)/);
  const p = hub.pairing(code);
  assert.deepEqual([p.state, p.used, p.nodes.map((n) => n.name)], ['paired', 2, [name, 'MacBook Air (spare)']]);
  node = JSON.parse(fs.readFileSync(path.join(home, '.agent-orch-worker', 'config.json'), 'utf8')).node;
  assert.equal(node, p.nodes[0].id);
  await assert.rejects(workerCli(path.join(tmp, 'home-3'), 'pair', '--controller', base, '--code', code), /already used by 2 machines/);
});

test('run: the policy arrives in welcome; idle on AC power it takes jobs and lets the machine sleep', async () => {
  worker = spawn(process.execPath, ['worker.mjs', 'run'], { cwd: ROOT, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', (d) => { workerOut += d; });
  worker.stderr.on('data', (d) => { workerOut += d; });
  await waitFor(() => view()?.status === 'online' && view().resources?.intake?.ok === true, { timeout: 20000, message: `online with intake\n${workerOut}` });
  assert.equal(view().resources.awake, false);
  assert.deepEqual(view().resources.battery, { pct: 80, charging: true, source: 'ac' });
  assert.match(workerOut, /policy: new jobs on AC power or above 50% battery, none at heavy thermal pressure; awake while jobs run: on AC power/);
  assert.deepEqual(caffeinate(), [], 'no caffeinate while idle');
});

test('caffeinate -i -w <worker pid> runs only while a job runs on AC power', async () => {
  hub.send(node, { t: 'job.offer', job: 31, agent: 'codex' });
  await waitFor(() => got('job.accept', 31).length, { timeout: 10000, message: `accept 31\n${workerOut}` });
  hub.send(node, { t: 'job.start', job: 31, title: 'Slow', prompt: 'SLOW: create hello.txt', agent: 'codex', repo: REPO, baseSha,
    branch: 'agent-orch/task-31', timeouts: { taskSec: 120 } });
  const [start] = await waitFor(() => caffeinate().filter((c) => c.event === 'start').length && caffeinate(), { timeout: 10000, message: `caffeinate\n${workerOut}` });
  assert.deepEqual(start.args, ['-i', '-w', String(worker.pid)]);
  await waitFor(() => view().resources?.awake === true, { timeout: 5000, message: 'awake reported' });
  // Unplugged: the default policy lets it sleep on battery; plugged back in, it is held awake again.
  power(80, 'battery');
  await waitFor(() => caffeinate().some((c) => c.event === 'stop' && c.pid === start.pid), { timeout: 10000, message: 'stop on battery' });
  assert.equal(got('job.done', 31).length, 0, 'the job goes on');
  power(80, 'ac');
  await waitFor(() => caffeinate().filter((c) => c.event === 'start').length === 2, { timeout: 10000, message: 'start again on AC' });
  // The job ends (cancelled here): the machine may sleep again.
  hub.send(node, { t: 'job.cancel', job: 31, reason: 'reassigned' });
  await waitFor(() => { const c = caffeinate(); return c.filter((x) => x.event === 'stop').length === 2 && c; }, { timeout: 15000, message: `stop after the job\n${workerOut}` });
  const pids = caffeinate().filter((c) => c.event === 'start').map((c) => c.pid);
  await waitFor(() => pids.every((pid) => !alive(pid)), { timeout: 5000, message: 'no caffeinate left' });
  await waitFor(() => view().resources?.awake === false, { timeout: 5000 });
});

test('new jobs are declined on low battery and when hot, until the power returns or the owner relaxes the policy', async () => {
  const offer = async (job) => {
    hub.send(node, { t: 'job.offer', job, agent: 'codex' });
    return waitFor(() => got('job.accept', job)[0] || got('job.reject', job)[0], { timeout: 10000, message: `answer ${job}\n${workerOut}` });
  };
  power(40, 'battery');
  await waitFor(() => view().status === 'paused', { timeout: 10000, message: 'paused on battery' });
  assert.equal(view().resources.intake.text, 'On battery at 40%: takes new tasks above 50%');
  assert.deepEqual([(await offer(41)).t, (await offer(41)).reason], ['job.reject', 'power']);
  // The owner allows battery work down to 30% (Machines → Power): the worker hears it at once.
  hub.update(node, { policy: { minBattery: 30 } });
  await waitFor(() => view().status === 'online', { timeout: 10000, message: 'online at 40% with a 30% threshold' });
  assert.equal((await offer(42)).t, 'job.accept');
  // Heavy thermal pressure on AC power pauses intake too, until it cools down.
  power(90, 'ac', 2);
  await waitFor(() => view().status === 'paused' && view().resources.intake.reason === 'thermal', { timeout: 10000, message: 'paused when hot' });
  assert.equal((await offer(43)).reason, 'power');
  power(90, 'ac', 0);
  await waitFor(() => view().status === 'online', { timeout: 10000, message: 'online when cool' });
  assert.equal((await offer(44)).t, 'job.accept');
});
