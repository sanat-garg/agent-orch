// A worker's local cap (cap.mjs, `node worker.mjs limit`) and its terminal status view (`node worker.mjs status`,
// worker-status.mjs): the cap's parsing and wording; the head's slots for a worker under its cap (orchestrator nodeCap,
// in a child process with a stub hub) and its "up next" count; the wrapper a job's commands run through (pid recorded,
// nice level); and a real worker.mjs against an in-process hub: the cap reported and reloaded live, offers over it
// declined with reason 'cap', the memory watch pausing the newest job, the status socket's snapshot (0600) and
// `node worker.mjs status --once` printing the connection, the cap and the running job's line.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCluster } from '../cluster.mjs';
import { CLAIM_PATH } from '../cluster-protocol.mjs';
import { GB, applyLimit, capRejection, capSlots, capText, localCap, parseCpu, parseMaxTasks, parseMem, resolveCap } from '../cap.mjs';
import { createJobUsage, createWrappers, wrapperScript } from '../worker-cap.mjs';
import { request, renderStatus } from '../worker-status.mjs';
import { limitArgs } from '../worker.mjs';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/test-owner/demo.git';
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-worker-cap-')); });
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('cap parsing: cores or a share of them, GB or a share of RAM, max tasks, AC power only; off removes a part', () => {
  const m = { cores: 8, memTotal: 16 * GB };
  assert.deepEqual([parseCpu('4', m), parseCpu('2.5', m), parseCpu('50%', m), parseCpu('off', m)], [{ value: 4 }, { value: 2.5 }, { value: '50%' }, { value: null }]);
  for (const bad of ['0', '-1', '9', 'four', '150%', '0%', '']) assert.ok(parseCpu(bad, m).error, `--cpu ${bad}`);
  assert.match(parseCpu('9', m).error, /this machine has 8 cores/);
  assert.deepEqual([parseMem('8', m), parseMem('7.5 GB', m), parseMem('8g', m), parseMem('25%', m)], [{ value: 8 }, { value: 7.5 }, { value: 8 }, { value: '25%' }]);
  for (const bad of ['0', '17', 'lots', '101%', '8 TB']) assert.ok(parseMem(bad, m).error, `--mem ${bad}`);
  assert.match(parseMem('17', m).error, /16 GB of RAM/);
  assert.deepEqual([parseMaxTasks('3'), parseMaxTasks('off')], [{ value: 3 }, { value: null }]);
  for (const bad of ['0', '65', '1.5', 'x']) assert.ok(parseMaxTasks(bad).error, `--max-tasks ${bad}`);

  // The CLI's options: --only-on-ac takes no value (or on/off), the others take one.
  assert.deepEqual(limitArgs(['--cpu', '4', '--mem=8', '--only-on-ac', '--max-tasks', '3']).opts, { cpu: '4', mem: '8', onlyOnAc: true, maxTasks: '3' });
  assert.deepEqual(limitArgs(['--only-on-ac', 'off', '--show']).opts, { onlyOnAc: 'off', show: true });
  for (const bad of [['--cpu'], ['--cpu', '--mem', '8'], ['--bogus'], ['4']]) assert.ok(limitArgs(bad).error, bad.join(' '));

  // Only the parts given change; the saved form keeps a share as typed; nothing left = no cap.
  const a = applyLimit(null, { cpu: '4', mem: '50%', maxTasks: '3', onlyOnAc: true }, m).cap;
  assert.deepEqual({ ...a, at: 0 }, { cpu: 4, mem: '50%', maxTasks: 3, onlyOnAc: true, at: 0 });
  const b = applyLimit(a, { cpu: 'off', onlyOnAc: 'off' }, m).cap;
  assert.deepEqual([b.cpu, b.mem, b.maxTasks, b.onlyOnAc], [undefined, '50%', 3, undefined]);
  assert.equal(applyLimit(b, { mem: 'off', maxTasks: 'off' }, m).cap, null);
  assert.match(applyLimit(a, { cpu: '99' }, m).error, /8 cores/);

  // Resolved for the machine: a share of its cores and RAM, capped at what it has; anything unreadable counts as unset.
  assert.deepEqual(resolveCap(a, m), { cpu: 4, mem: 8 * GB, maxTasks: 3, onlyOnAc: true });
  assert.deepEqual(resolveCap({ cpu: '50%', mem: 6 }, { cores: 10, memTotal: 16 * GB }), { cpu: 5, mem: 6 * GB, maxTasks: null, onlyOnAc: false });
  assert.equal(resolveCap({ cpu: 32 }, m).cpu, 8);
  assert.equal(resolveCap({ cpu: 'lots', maxTasks: 0 }, m), null);
  assert.equal(resolveCap(null, m), null);
  assert.equal(capText(resolveCap({ cpu: 4, mem: 8 }, m), m), '4 cores · 8 GB');
  assert.equal(capText(resolveCap({ maxTasks: 1, onlyOnAc: true }, m), m), '8 cores · 16 GB · at most 1 task · on AC power only');

  // The head's ceiling: max tasks, 1 core a task, and the running jobs + what fits in the rest of the RAM cap.
  assert.equal(capSlots(null, { runs: 3 }), Infinity);
  assert.equal(capSlots({ cpu: 4, mem: 8 * GB }, { runs: 0, jobsMem: 0, footprint: 1.2 * GB }), 4);
  assert.equal(capSlots({ cpu: 8, mem: 8 * GB }, { runs: 0, jobsMem: 0, footprint: 1.2 * GB }), 6);
  assert.equal(capSlots({ mem: 8 * GB }, { runs: 2, jobsMem: 5 * GB, footprint: 1.2 * GB }), 4);
  assert.equal(capSlots({ mem: 8 * GB }, { runs: 2, jobsMem: 9 * GB, footprint: 1.2 * GB }), 2, 'over its RAM cap: nothing new');
  assert.equal(capSlots({ cpu: 2.5, maxTasks: 5 }, { footprint: GB }), 2);
  assert.equal(capSlots({ cpu: 2.5 }, { footprint: GB, cpuPerTask: 0.5 }), 5);
  // The worker's own check before it accepts one more.
  assert.equal(capRejection({ maxTasks: 1 }, { jobs: 1 }).kind, 'tasks');
  assert.match(capRejection({ maxTasks: 1 }, { jobs: 1 }).text, /allows 1 task \(max tasks\)/);
  assert.equal(capRejection({ mem: 2 * GB }, { jobs: 0, jobsMem: GB, footprint: 1.2 * GB }).kind, 'memory');
  assert.equal(capRejection({ mem: 2 * GB, cpu: 2 }, { jobs: 1, jobsMem: 0.5 * GB, footprint: 1.2 * GB }), null);
  // A node's reported cap: its latest resources frame (null = none) over its inventory.
  assert.equal(localCap({ resources: { cap: null }, inventory: { cap: { maxTasks: 2 } } }), null);
  assert.equal(localCap({ resources: {}, inventory: { cap: { maxTasks: 2 } } }).maxTasks, 2);
  assert.equal(localCap({ resources: { cap: { cpu: 'x', mem: -1 } } }), null);
});

test('the head keeps to a worker\'s local cap: slots = min(its own setting, max tasks, CPU, RAM left); up next counts what it could take', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'orch-')), repo = fs.mkdtempSync(path.join(tmp, 'demo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['remote', 'add', 'origin', REPO], { cwd: repo });
  const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
    import { effectivePolicy } from ${JSON.stringify(new URL('../power.mjs', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    import path from 'node:path';
    const [dataDir, repo] = process.argv.slice(1), GB = 2 ** 30;
    const agents = (...ids) => ids.map((id) => ({ id, installed: true, signedIn: true }));
    const node = (id, os, cores, free, maxSlots, res = {}, inv = {}) => ({ id, name: id, os, local: false, status: 'online', connected: true, enabled: true, draining: false,
      maxSlots, inventory: { cores, agents: agents('claude'), ...inv }, resources: { memAvailable: free * GB, at: Date.now(), ...res }, policy: effectivePolicy(os) });
    const nodes = [{ id: 'controller', local: true, status: 'online', connected: true, enabled: true },
      node('capped', 'linux', 8, 32, 6, { cap: { cpu: 4, mem: 8 * GB, maxTasks: null, onlyOnAc: false }, jobsMem: 0 }),
      node('mac-tasks', 'darwin', 10, 32, null, { cap: { cpu: null, mem: null, maxTasks: 2, onlyOnAc: true }, jobsMem: 0 }),
      node('ram-used', 'linux', 8, 32, 8, { cap: { cpu: null, mem: 4 * GB, maxTasks: null, onlyOnAc: false }, jobsMem: 3.5 * GB }),
      node('no-cap', 'linux', 8, 32, 3, { cap: null }, { cap: { maxTasks: 1 } }),
      node('old-worker', 'linux', 8, 32, 3, {}, { cap: { maxTasks: 1 } }),
      node('both-agents', 'linux', 8, 32, 3, { cap: null }, { agents: agents('claude', 'codex') })];
    const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, disabled: true, claudeEnv: {}, getLimits: () => [],
      onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false });
    let upNext = null;
    o.attachCluster({ listNodes: () => nodes, onMessage() {}, version: () => 1, setUpNext: (fn) => { upNext = fn; } });
    // The queue: three ready work tasks (two for Claude, one for codex), one waiting on a prerequisite, a plan task.
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,'demo',50,'active',0,0)").run(repo).lastInsertRowid);
    const task = (kind, agent = null) => Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,agent,created_at) VALUES(?,?,'t','t',?,?)").run(pid, kind, agent, Date.now() / 1000).lastInsertRowid);
    task('work'); task('work'); task('work', 'codex'); task('plan');
    const blocked = task('work'), first = task('work');
    db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(first);
    db.prepare('INSERT INTO task_deps(task_id, depends_on) VALUES(?, ?)').run(blocked, first);
    const slots = Object.fromEntries(o.machines(nodes).map((n) => [n.id, n.slots]));
    console.log(JSON.stringify({ slots, workers: o.stateView().capacity.workers,
      upNext: { claude: upNext('capped'), both: upNext('both-agents'), controller: upNext('controller'), unknown: upNext('nope') } }));
    process.exit(0);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo], { cwd: ROOT, encoding: 'utf8', timeout: 45000 });
  const r = JSON.parse(stdout.trim().split('\n').pop());
  // capped: the head says 6, its cap 4 cores (1 a task) and 8 GB (6 Claude-sized runs) → 4. mac-tasks: Auto would be 9
  // (cores − 1), its cap says 2. ram-used: its jobs use 3.5 of its 4 GB → no room. no-cap: resources say none (the
  // inventory's older cap no longer counts) → the head's 3. old-worker: no cap in resources → its inventory's max 1.
  assert.deepEqual(r.slots, { controller: r.slots.controller, capped: 4, 'mac-tasks': 2, 'ram-used': 0, 'no-cap': 3, 'old-worker': 1, 'both-agents': 3 });
  assert.equal(r.workers, 4 + 2 + 0 + 3 + 1 + 3);
  // Up next: the ready work tasks whose agent is signed in there (not the blocked one, not the plan task).
  assert.deepEqual(r.upNext, { claude: 2, both: 3, controller: null, unknown: null });
});

test('a job\'s wrapper records its pid, runs the command in place at a lower priority under a CPU cap, and is measured', { skip: process.platform !== 'linux' && 'reads /proc', timeout: 30000 }, async () => {
  const dir = path.join(tmp, 'run'), cap = { cpu: 1, mem: null };
  const w = createWrappers({ dir, cap: () => cap, mode: () => 'nice' });
  w.reset();
  const file = w.wrap(7, 'check', ['sh']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o700);
  assert.match(fs.readFileSync(file, 'utf8'), /^#!\/bin\/sh\n.*\necho \$\$ >> '.*job-7\.pids'\nexec '\S*nice' -n 10 'sh' "\$@"\n$/);
  const child = spawn(file, ['-c', 'echo "$$ $(nice)"; sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const out = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(String(d).trim().split(' '))));
  assert.equal(Number(out[0]), child.pid, 'the command runs in place (the wrapper execs it)');
  assert.equal(Number(out[1]), Math.min(19, os.getPriority() + 10));
  assert.deepEqual(w.pids(7), [child.pid]);
  const u = await createJobUsage().sample(new Map([[7, w.pids(7)], [8, [process.pid]]]));
  assert.ok(u.jobs.get(7).mem > 0, 'its tree is measured');
  assert.equal(u.jobs.get(8).mem, 0, 'a pid that is not a child of this process does not count');
  child.kill('SIGKILL');
  w.drop(7);
  assert.deepEqual(fs.readdirSync(dir), []);
  // Without a CPU/RAM cap it just execs; with the systemd limiter a scope carries both limits and nice is the fallback.
  assert.match(wrapperScript({ job: 3, what: 'codex', exec: ['codex'], pidFile: '/r/job-3.pids', cap: null, mode: 'systemd' }), /\nexec 'codex' "\$@"\n$/);
  const sd = wrapperScript({ job: 3, what: 'codex', exec: ['codex'], pidFile: '/r/job-3.pids', cap: { cpu: 2.5, mem: 4 * GB }, mode: 'systemd' });
  if (fs.existsSync('/usr/bin/systemd-run')) {
    assert.match(sd, /exec '\/usr\/bin\/systemd-run' --user --scope --quiet --collect "--unit=agent-orch-job-3-\$\$" -p CPUQuota=250% -p MemoryMax=4294967296 -- 'codex' "\$@"/);
  }
  assert.match(sd, /\nexec '\S*nice' -n 10 'codex' "\$@"\n$/);
});

test('the status view renders a snapshot: connection, cap, bars, one line per job, up next and the last finished', () => {
  const t = Date.UTC(2026, 8, 27, 12);
  const lines = renderStatus({
    ok: true, at: t, name: 'studio-mac', controller: 'https://head.example', machine: { cores: 10, memTotal: 32 * GB },
    connection: { state: 'connected', since: t - 3725_000 }, cap: { cpu: 4, mem: 8 * GB, maxTasks: null, onlyOnAc: false }, limiter: 'low priority',
    usage: { cpu: 1.5, mem: 2 * GB }, slots: 4, intake: { ok: true },
    jobs: [{ id: 41, title: 'Add the status view', agent: 'claude', model: 'opus', state: 'running', phase: 'running', startedAt: t - 192_000, activity: 'Edit · worker.mjs', activityAt: t - 4000 }],
    queued: 2, finished: [{ id: 40, title: 'Fix the cap', outcome: 'ok', ms: 724_000, at: t - 300_000 }],
  }, { width: 100, u: true }).join('\n');
  for (const want of [/agent-orch worker · studio-mac/, /Head +● Connected https:\/\/head\.example · for 1h 02m/, /Cap +4 cores · 8 GB \(set on this machine\)/,
    /CPU +\[█+░+\] +1\.5 of 4 cores used by jobs/, /RAM +\[█+░+\] +2 GB of 8 GB used by jobs/, /Running +1 of 4 slots/,
    /#41 +Add the status view +claude·opus +running +3m 12s +Edit · worker\.mjs \(4s ago\)/, /Up next +2 tasks ready on the head/, /#40 +Fix the cap +ok +12m 04s +5m ago/]) {
    assert.match(lines, want);
  }
  const away = renderStatus({ ok: true, at: t, name: 'vps', controller: 'https://h', machine: { cores: 2, memTotal: 4 * GB }, cap: null, usage: { cpu: 0, mem: 0 },
    connection: { state: 'reconnecting', since: t - 5000, retryAt: t + 3000, error: 'connect ECONNREFUSED' }, jobs: [], finished: [], queued: null }).join('\n');
  assert.match(away, /◌ Reconnecting https:\/\/h · since \d\d:\d\d · retry in 3s/);
  assert.match(away, /ECONNREFUSED/);
  assert.match(away, /Cap +none · lends all 2 cores and 4 GB/);
  assert.match(renderStatus({ ok: false, config: { controller: 'https://h' }, error: 'no status socket' }).join('\n'), /Not running/);
});

test('the macOS installer always installs agent-orch-worker-status and says how to set the cap; --status-window adds a Terminal login item', () => {
  const dry = (...args) => {
    const h = fs.mkdtempSync(path.join(tmp, 'inst-'));
    return spawnSync('bash', [path.join(ROOT, 'bin', 'install-worker-macos.sh'), '--dry-run', '--controller', 'https://head.example', '--code', 'ABCD-2345', ...args],
      { encoding: 'utf8', env: { ...process.env, HOME: h, NVM_DIR: path.join(h, 'nvm') } });
  };
  const plain = dry();
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /Live status \(connection, cap, running tasks; q quits\): agent-orch-worker-status {3}\(or sudo -u agentorch -H node \/Users\/agentorch\/agent-orch-worker\/worker\.mjs status\)/);
  assert.match(plain.stdout, /run this installer again with --status-window/);
  assert.match(plain.stdout, /Cap what this Mac lends the cluster: sudo -u agentorch -H node \S+\/worker\.mjs limit --cpu 4 --mem 8/);
  assert.match(plain.stdout, /NOPASSWD: \/usr\/local\/bin\/agent-orch-worker-status\n/);
  assert.doesNotMatch(plain.stdout, /com\.agent-orch\.worker\.status\.plist/);
  const win = dry('--status-window');
  assert.equal(win.status, 0, win.stderr);
  // A root-owned script that re-runs itself as agentorch (whose status socket it reads), one sudoers rule for exactly it,
  // and the owner's LaunchAgent that opens it in Terminal at login.
  assert.match(win.stdout, /\+ write \/usr\/local\/bin\/agent-orch-worker-status \(mode 0755, root\):\n.*\n.*\n {4}\[ "\$\(id -un\)" = agentorch \] \|\| exec \/usr\/bin\/sudo -u agentorch -H "\$0" "\$@"\n {4}exec "\S+node" "\/Users\/agentorch\/agent-orch-worker\/worker\.mjs" status "\$@"/);
  assert.match(win.stdout, /NOPASSWD: \/usr\/local\/bin\/agent-orch-worker-status\n/);
  assert.match(win.stdout, /LaunchAgents\/com\.agent-orch\.worker\.status\.plist:[\s\S]*<string>\/usr\/bin\/open<\/string>\s*<string>-a<\/string>\s*<string>Terminal<\/string>\s*<string>\/usr\/local\/bin\/agent-orch-worker-status<\/string>/);
  assert.match(win.stdout, /launchctl bootstrap gui\/\d+ \S+com\.agent-orch\.worker\.status\.plist/);
  assert.match(win.stdout, /The status view also opens in Terminal each time \S+ logs in/);
  const gone = spawnSync('bash', [path.join(ROOT, 'bin', 'install-worker-macos.sh'), '--dry-run', '--uninstall'], { encoding: 'utf8', env: { ...process.env, HOME: tmp } });
  assert.match(gone.stdout, /rm -f .*\/usr\/local\/bin\/agent-orch-worker-status \/etc\/sudoers\.d\/agent-orch-worker-status/);
  assert.match(gone.stdout, /launchctl bootout gui\/\d+\/com\.agent-orch\.worker\.status/);
});

// ---------------------------------------------------------------- a real worker under a cap
let home, bin, whome, origin, baseSha, server, cluster, base, worker, workerOut = '';
const frames = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const env = () => ({ HOME: home, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off', AGENT_ORCH_WORKER_NET_PROBE: 'off', AGENT_ORCH_WORKER_LIMITER: 'nice',
  AGENT_ORCH_WORKER_CAP_PAUSE_MS: '1500' });
// The hub runs in this process: worker CLI calls must not block it. Resolves {code, stdout, stderr}.
const cli = (...args) => new Promise((resolve) => execFile(process.execPath, ['worker.mjs', ...args], { cwd: ROOT, env: env(), encoding: 'utf8' },
  (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout, stderr })));
const got = (t, job) => frames.filter((f) => f.t === t && (job == null || f.job === job));
const nodeId = () => JSON.parse(fs.readFileSync(path.join(whome, 'config.json'), 'utf8')).node;
const start = (job) => cluster.send(nodeId(), { t: 'job.start', job, title: `Cap job ${job}`, prompt: 'SLOW: create hello.txt', agent: 'codex', repo: REPO, baseSha,
  branch: `agent-orch/task-${job}`, timeouts: { taskSec: 120 } });
// Offers a job and waits for the answer to this offer: 'accept' or the reject reason.
async function offer(job) {
  const from = frames.length;
  cluster.send(nodeId(), { t: 'job.offer', job, agent: 'codex' });
  const [f] = await waitFor(() => { const r = frames.slice(from).filter((x) => (x.t === 'job.accept' || x.t === 'job.reject') && x.job === job); return r.length && r; },
    { timeout: 10000, message: `an answer to offer ${job}\n${workerOut}` });
  return f.t === 'job.accept' ? 'accept' : f.reason;
}

test('worker e2e setup: a paired machine with a cap saved before its worker starts', { timeout: 60000 }, async () => {
  home = path.join(tmp, 'home');
  bin = path.join(tmp, 'bin');
  whome = path.join(home, '.agent-orch-worker');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  isolatedPath(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node ${path.join(ROOT, 'test/fixtures/worker-agent-stub.mjs')} "$@"\n`, { mode: 0o755 });
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

  cluster = createCluster({ dbFile: path.join(tmp, 'hub.db'), heartbeatMs: 300, health: { diskMinBytes: 0 } });
  cluster.setUpNext(() => 3);
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

  // Not paired yet: nothing to cap.
  const unpaired = await cli('limit', '--max-tasks', '1');
  assert.equal(unpaired.code, 1);
  assert.match(unpaired.stderr, /no worker pairing/);
  const { code } = cluster.createPairing();
  assert.equal((await cli('pair', '--controller', base, '--code', code, '--name', 'capped-box')).code, 0);
  cluster.update(nodeId(), { maxSlots: 4 }); // the head allows 4: the local cap is what holds it back
  const saved = await cli('limit', '--max-tasks', '1', '--only-on-ac');
  assert.equal(saved.code, 0, saved.stderr);
  assert.match(saved.stdout, /Local cap saved: .*at most 1 task · on AC power only\./);
  assert.match(saved.stdout, /The worker isn't running here; it applies the cap when it starts\./);
  const cfg = JSON.parse(fs.readFileSync(path.join(whome, 'config.json'), 'utf8'));
  assert.match(cfg.token, /^aon_/, 'the pairing is kept');
  assert.deepEqual([cfg.cap.maxTasks, cfg.cap.onlyOnAc], [1, true]);
  assert.equal(fs.statSync(path.join(whome, 'config.json')).mode & 0o777, 0o600);
  const bad = await cli('limit', '--cpu', '999');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /this machine has \d+ cores?/);
  // With the worker down, status still answers (exit 0) from the saved config.
  const down = await cli('status', '--once');
  assert.equal(down.code, 0);
  assert.match(down.stdout, /Not running/);
  assert.doesNotMatch(down.stdout, /aon_/);
});

test('the worker reports its cap, declines offers over it, reloads it live and pauses the newest job over its RAM cap', { timeout: 120000 }, async () => {
  worker = spawn(process.execPath, ['worker.mjs', 'run'], { cwd: ROOT, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', (d) => { workerOut += d; });
  worker.stderr.on('data', (d) => { workerOut += d; });
  const node = nodeId();
  const n = await waitFor(() => { const x = cluster.node(node); return x?.inventory?.cap && x.resources?.cap && x; }, { timeout: 20000, message: `the cap in inventory and resources\n${workerOut}` });
  assert.deepEqual(n.inventory.cap, { cpu: null, mem: null, maxTasks: 1, onlyOnAc: true });
  assert.deepEqual(n.resources.cap, n.inventory.cap);
  assert.equal(n.resources.jobsMem, 0);

  assert.equal(await offer(31), 'accept');
  start(31);
  await waitFor(() => got('job.event', 31).flatMap((f) => f.events).some((e) => e.k === 'tool'), { timeout: 20000, message: `job 31 runs\n${workerOut}` });
  // At its max tasks: the next offer is declined with reason 'cap' (the head lists feature 'cap').
  assert.equal(await offer(32), 'cap');
  assert.match(workerOut, /declined job 32: the local cap allows 1 task \(max tasks\)/);

  // The status socket (0600): its snapshot, then the CLI's one-shot view.
  assert.equal(fs.statSync(path.join(whome, 'worker.sock')).mode & 0o777, 0o600);
  const snap = await waitFor(async () => { const s = await request(whome, { op: 'status' }); return s.jobs?.[0]?.mem > 0 && s; },
    { timeout: 15000, message: `a snapshot with the job's memory\n${workerOut}` });
  assert.deepEqual([snap.ok, snap.name, snap.connection.state, snap.controller, snap.queued, snap.slots], [true, 'capped-box', 'connected', base, 3, 1]);
  assert.deepEqual(snap.cap, { cpu: null, mem: null, maxTasks: 1, onlyOnAc: true });
  assert.deepEqual([snap.jobs[0].id, snap.jobs[0].title, snap.jobs[0].agent, snap.jobs[0].phase], [31, 'Cap job 31', 'codex', 'running']);
  assert.match(snap.jobs[0].activity, /hello\.txt|Working on/);
  assert.ok(snap.usage.mem > 0, 'the jobs\' memory is measured');
  assert.equal((await request(whome, { op: 'nope' })).ok, false);
  const once = await cli('status', '--once');
  assert.equal(once.code, 0, once.stderr);
  for (const want of [/agent-orch worker · capped-box/, /Head +● Connected/, /Cap +\d+ cores? · [\d.]+ GB · at most 1 task · on AC power only \(set on this machine\)/,
    /Running +1 of 1 slot/, /#31 +Cap job 31 +codex·default +running +(\d+m )?\d+s/, /Up next +3 tasks ready on the head for this machine/]) {
    assert.match(once.stdout, want);
  }

  // Applied live: `limit` saves it and the worker reloads it over its socket and tells the head at once.
  const two = await cli('limit', '--max-tasks', '2');
  assert.match(two.stdout, /Applied now: the worker reloaded it and told the head\./);
  await waitFor(() => cluster.node(node).resources?.cap?.maxTasks === 2 && cluster.node(node).inventory?.cap?.maxTasks === 2, { timeout: 10000, message: 'the new cap reaches the head' });
  assert.equal(await offer(33), 'accept');
  // A RAM cap the running job already exceeds: offers are declined, and after CAP_PAUSE_MS over it the newest job is
  // paused: its WIP pushed and job.done aborted, so the head requeues it to resume later.
  await cli('limit', '--mem', '0.01');
  await waitFor(() => cluster.node(node).resources?.cap?.mem > 0, { timeout: 10000 });
  assert.equal(await offer(34), 'cap');
  const [done] = await waitFor(() => got('job.done', 31).length && got('job.done', 31), { timeout: 30000, message: `the memory watch pauses job 31\n${workerOut}` });
  assert.equal(done.outcome, 'aborted');
  assert.match(done.text, /paused by capped-box's local cap: its jobs used [\d.]+ [MG]B of 10 MB RAM for 2 s; it continues later/);
  assert.ok(done.sessionId, 'it resumes its session later');
  assert.equal(git(origin, 'rev-parse', 'refs/heads/agent-orch/task-31'), done.sha, 'its work is pushed');
  assert.equal(await offer(31), 'cap', 'the paused job is not taken back here for a while');
  const after = await request(whome, { op: 'status' });
  assert.deepEqual([after.finished[0].id, after.finished[0].outcome], [31, 'aborted']);
  assert.match((await cli('status', '--once')).stdout, /#31 +Cap job 31 +aborted/);

  // --reset: no cap at all, on the worker and at the head.
  const reset = await cli('limit', '--reset');
  assert.match(reset.stdout, /Local cap removed/);
  await waitFor(() => cluster.node(node).resources?.cap === null, { timeout: 10000, message: 'the head hears the cap is gone' });
  assert.match((await cli('limit', '--show')).stdout, /^No local cap: capped-box lends all/);
});

test('a stopped worker removes its status socket', { timeout: 30000 }, async () => {
  worker.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(() => { worker.kill('SIGKILL'); r(); }, 15000); worker.on('exit', () => { clearTimeout(t); r(); }); });
  assert.equal(fs.existsSync(path.join(whome, 'worker.sock')), false);
  cluster.close();
  server.close();
});
