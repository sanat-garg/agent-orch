// resources.mjs: classification against a fake procfs, reaper safety (protected categories are never selected or
// signalled), orphan detection for a finished task's surviving CLI, manual kills, and GET /api/resources on a test server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, buildTrees, createResources, readProcesses, readSystem, REAP, PROTECTED } from '../resources.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UID = 1000, SELF = 200, UPTIME = 100000;
const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };

// A fake /proc: system files plus one dir per process (stat, status, cmdline, environ, cgroup, smaps_rollup, cwd link).
function fakeProc(procs) {
  const dir = tmp('fake-proc-');
  fs.writeFileSync(path.join(dir, 'meminfo'), 'MemTotal:        6000000 kB\nMemAvailable:    1000000 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n');
  fs.writeFileSync(path.join(dir, 'loadavg'), '0.50 0.40 0.30 1/200 999\n');
  fs.writeFileSync(path.join(dir, 'uptime'), `${UPTIME}.00 1000.00\n`);
  fs.writeFileSync(path.join(dir, 'stat'), 'cpu  10 0 10 80 0 0 0 0 0 0\ncpu0 5 0 5 40 0 0 0 0 0 0\ncpu1 5 0 5 40 0 0 0 0 0 0\n');
  for (const p of procs) {
    const d = path.join(dir, String(p.pid));
    fs.mkdirSync(d);
    const argv = p.argv, comm = p.comm || path.basename(argv[0] || '').slice(0, 15);
    const start = (UPTIME - (p.age ?? 3600)) * 100;
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime prio nice threads itreal starttime
    fs.writeFileSync(path.join(d, 'stat'), `${p.pid} (${comm}) S ${p.ppid} ${p.pgid ?? p.pid} ${p.pid} 0 -1 0 0 0 0 0 ${p.ticks || 0} 0 0 0 20 0 1 0 ${start} 0 0\n`);
    fs.writeFileSync(path.join(d, 'status'), `Name:\t${comm}\nUid:\t${p.uid ?? UID}\t${p.uid ?? UID}\t${p.uid ?? UID}\t${p.uid ?? UID}\nVmRSS:\t${p.rss ?? 10000} kB\n`);
    fs.writeFileSync(path.join(d, 'cmdline'), argv.join('\0') + '\0');
    fs.writeFileSync(path.join(d, 'environ'), Object.entries({ HOME: '/home/ubuntu', ...p.env }).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
    fs.writeFileSync(path.join(d, 'cgroup'), `0::${p.cgroup || '/user.slice/user-1000.slice/session-1.scope'}\n`);
    if (p.pss != null) fs.writeFileSync(path.join(d, 'smaps_rollup'), `Rss:  ${p.rss ?? 10000} kB\nPss:  ${p.pss} kB\n`);
    fs.symlinkSync(p.cwd || '/home/ubuntu', path.join(d, 'cwd'));
  }
  return dir;
}

const SERVICE = '/system.slice/agent-orch.service';
const MIN = 60;
// pid → expected category
const FIXTURE = [
  [{ pid: 1, ppid: 0, uid: 0, argv: ['/sbin/init'], comm: 'systemd' }, 'system'],
  [{ pid: 100, ppid: 1, uid: 0, argv: ['sshd: /usr/sbin/sshd -D'], comm: 'sshd' }, 'system'],
  [{ pid: 101, ppid: 100, argv: ['-bash'], comm: 'bash' }, 'system'],
  [{ pid: 102, ppid: 101, argv: ['/home/ubuntu/.local/bin/claude'], age: 50 * MIN }, 'system'], // the owner's own claude over ssh
  [{ pid: 200, ppid: 1, argv: ['/usr/bin/node', 'server.mjs'], env: { PORT: '3000' }, cgroup: SERVICE, rss: 120000, pss: 100000 }, 'live server'],
  // running task 7: its claude (SDK child: same process group as the server), a shell, a test browser
  [{ pid: 201, ppid: 200, pgid: 200, argv: ['/home/ubuntu/.local/bin/claude', '--output-format', 'stream-json'], env: { AGENT_ORCH_OWNER: `${SELF}:task:7` }, cgroup: SERVICE }, 'task:7'],
  [{ pid: 202, ppid: 201, argv: ['/bin/bash', '-c', 'npm test'], env: { AGENT_ORCH_OWNER: `${SELF}:task:7` }, cgroup: SERVICE }, 'task:7'],
  [{ pid: 203, ppid: 202, argv: ['/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux/headless_shell'], env: { AGENT_ORCH_OWNER: `${SELF}:task:7` }, cgroup: SERVICE, age: 30 * MIN }, 'task:7'],
  // a running task's detached test server re-parented to init: still the task's
  [{ pid: 204, ppid: 1, argv: ['node', 'server.mjs'], env: { AGENT_ORCH_OWNER: `${SELF}:task:7`, PORT: '3999', CW_DATA_DIR: '/tmp/x' }, cgroup: SERVICE, age: 60 * MIN }, 'task:7'],
  [{ pid: 210, ppid: 200, pgid: 200, argv: ['/home/ubuntu/.local/bin/claude'], env: { AGENT_ORCH_OWNER: `${SELF}:chat:abc` }, cgroup: SERVICE, age: 90 * MIN }, 'chat'],
  // task 9 finished, but its CLI child lives on (still under the server, in its process group) with a subprocess
  [{ pid: 220, ppid: 200, pgid: 200, argv: ['/home/ubuntu/.local/bin/claude'], env: { AGENT_ORCH_OWNER: `${SELF}:task:9` }, cgroup: SERVICE, age: 5 * MIN, rss: 300000, pss: 250000 }, 'orphaned agent'],
  [{ pid: 222, ppid: 220, pgid: 200, argv: ['node', '/x/mcp-server.js'], env: { AGENT_ORCH_OWNER: `${SELF}:task:9` }, cgroup: SERVICE, age: 5 * MIN }, 'orphaned agent'],
  // task 9's codex, registered by pid only, re-parented to init
  [{ pid: 221, ppid: 1, argv: ['codex', 'exec', '--json'], cgroup: SERVICE, age: 5 * MIN }, 'orphaned agent'],
  // a CLI whose server (pid 777) is gone
  [{ pid: 225, ppid: 1, argv: ['opencode', 'run'], env: { AGENT_ORCH_OWNER: '777:task:3' }, age: 5 * MIN }, 'orphaned agent'],
  [{ pid: 230, ppid: 1, argv: ['/home/ubuntu/.local/bin/kiro-cli', 'chat'], age: 10 * MIN }, 'orphaned agent'],
  [{ pid: 231, ppid: 1, argv: ['/home/ubuntu/.local/bin/agy', '-p'], age: 1 * MIN }, 'orphaned agent'], // too young to reap
  [{ pid: 240, ppid: 1, argv: ['node', 'server.mjs'], env: { PORT: '3999', CW_DATA_DIR: '/tmp/cw-x' }, cgroup: SERVICE, age: 40 * MIN }, 'test server'],
  [{ pid: 241, ppid: 1, argv: ['node', 'server.mjs'], env: { PORT: '4001' }, age: 5 * MIN }, 'test server'], // too young
  [{ pid: 250, ppid: 1, argv: ['/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux/headless_shell', '--headless'], age: 20 * MIN }, 'browser'],
  [{ pid: 251, ppid: 250, pgid: 250, argv: ['/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux/headless_shell', '--type=renderer'], age: 20 * MIN }, 'browser'],
  [{ pid: 260, ppid: 1, argv: ['tmux', '-L', 'agent-orch-login', 'new-session', '-d', '-s', 'login-claude'], cgroup: SERVICE, age: 10 * MIN }, 'login session'],
  [{ pid: 261, ppid: 260, argv: ['claude', '/login'], cgroup: SERVICE, age: 10 * MIN }, 'login session'],
  [{ pid: 270, ppid: 1, argv: ['/usr/bin/tmux', '-D'], cgroup: '/system.slice/agent-orch-tmux.service', age: 600 * MIN }, 'owner terminal'],
  [{ pid: 271, ppid: 270, argv: ['bash', '-l'], cgroup: '/system.slice/agent-orch-tmux.service', age: 500 * MIN }, 'owner terminal'],
  [{ pid: 272, ppid: 271, argv: ['/home/ubuntu/.local/bin/claude'], cgroup: '/system.slice/agent-orch-tmux.service', age: 400 * MIN }, 'owner terminal'],
  [{ pid: 280, ppid: 1, argv: ['/usr/bin/ttyd', '-p', '7682'], cgroup: '/system.slice/agent-orch-shell.service', age: 600 * MIN }, 'owner terminal'],
  [{ pid: 290, ppid: 1, argv: ['/usr/lib/systemd/systemd', '--user'], comm: 'systemd' }, 'system'],
  [{ pid: 291, ppid: 290, argv: ['/usr/bin/dbus-daemon', '--session'], comm: 'dbus-daemon' }, 'system'],
  [{ pid: 292, ppid: 290, argv: ['/home/ubuntu/.local/bin/claude'], age: 10 * MIN }, 'orphaned agent'], // parent is systemd --user
  [{ pid: 300, ppid: 1, argv: ['vim', 'notes.txt'], age: 600 * MIN }, 'other'],
  [{ pid: 320, ppid: 1, uid: 1001, argv: ['claude'], age: 600 * MIN }, 'system'], // not ours
  [{ pid: 330, ppid: 2, uid: 0, argv: [], comm: 'kworker/0:1' }, 'system'],
];
const registered = new Map([[221, { tag: `${SELF}:task:9`, pgid: 221, start: null }]]);
const isActive = (o) => (o.kind === 'task' ? o.id === '7' : o.id === 'abc');
const procDir = fakeProc(FIXTURE.map(([p]) => p));

test('classifies fixture process trees', () => {
  const procs = readProcesses(procDir);
  assert.equal(procs.size, FIXTURE.length);
  const cats = classify(procs, { uid: UID, selfPid: SELF, isActive, registered, tmpDirs: ['/tmp'] });
  for (const [p, want] of FIXTURE) assert.equal(cats.get(p.pid), want, `pid ${p.pid} ${p.argv.join(' ')}`);
  const trees = buildTrees(procs, cats, { uptime: UPTIME });
  const t220 = trees.find((t) => t.pid === 220);
  assert.deepEqual(t220.pids.sort(), [220, 222]);
  assert.equal(t220.ageSec, 5 * MIN);
  assert.equal(trees.find((t) => t.pid === 201).category, 'task:7');
  assert.equal(procs.get(200).pss, 100000 * 1024);
  assert.equal(procs.get(200).cwd, '/home/ubuntu');
  const sys = readSystem(procDir);
  assert.equal(sys.memAvailable, 1000000 * 1024);
  assert.equal(sys.cpus.length, 2);
});

test('orphan detection: a finished task\'s CLI child is an orphaned agent, the same child of a running task is not', () => {
  const procs = readProcesses(procDir);
  const running9 = classify(procs, { uid: UID, selfPid: SELF, isActive: (o) => o.kind === 'task' && (o.id === '7' || o.id === '9'), registered, tmpDirs: ['/tmp'] });
  assert.equal(running9.get(220), 'task:9');
  assert.equal(running9.get(221), 'task:9');
  const done9 = classify(procs, { uid: UID, selfPid: SELF, isActive, registered, tmpDirs: ['/tmp'] });
  assert.equal(done9.get(220), 'orphaned agent');
  assert.equal(done9.get(221), 'orphaned agent');
  // Seen from another server (a test instance, pid 240): the live server's running work is its tree, never a leftover.
  const foreign = classify(procs, { uid: UID, selfPid: 240, registered: new Map(), tmpDirs: ['/tmp'] });
  for (const pid of [201, 202, 203, 210, 220, 222]) assert.equal(foreign.get(pid), 'live server', `pid ${pid}`);
});

function reaper(opts = {}) {
  const calls = [];
  const dataDir = tmp('reaper-data-');
  const r = createResources({ procDir, dataDir, uid: UID, selfPid: SELF, isActive, tmpDirs: ['/tmp'], killWaitMs: 20, registered: new Map(registered),
    kill: (pid, sig) => calls.push([pid, sig]), ...opts });
  return { r, calls, dataDir };
}
// Every pid a signal reached, expanding group kills to their fixture members.
const signalled = (calls) => new Set(calls.flatMap(([pid]) => (pid < 0 ? FIXTURE.filter(([p]) => (p.pgid ?? p.pid) === -pid).map(([p]) => p.pid) : [pid])));

test('the reaper kills only aged leftovers and never a protected category', async () => {
  const { r, calls, dataDir } = reaper();
  const killed = r.reap();
  const byPid = new Set(killed.map((k) => k.pid));
  assert.deepEqual([...byPid].sort((a, b) => a - b), [220, 221, 225, 230, 240, 250, 260, 292]);
  for (const k of killed) assert.ok(REAP[k.category] != null, k.category);
  const hit = signalled(calls);
  const protectedPids = FIXTURE.filter(([, c]) => PROTECTED.has(c) || c.startsWith('task:') || c === 'chat' || c === 'other').map(([p]) => p.pid);
  for (const pid of protectedPids) assert.ok(!hit.has(pid), `protected pid ${pid} was signalled`);
  // the leftover SDK child shares the server's process group: signalled one by one, never via -200
  assert.ok(!calls.some(([pid]) => pid === -200));
  assert.ok(calls.some(([pid, sig]) => pid === 220 && sig === 'SIGTERM') && calls.some(([pid]) => pid === 222));
  assert.ok(calls.some(([pid, sig]) => pid === -250 && sig === 'SIGTERM'), 'browser group killed as a whole');
  await new Promise((res) => setTimeout(res, 60));
  assert.ok(calls.some(([pid, sig]) => pid === -250 && sig === 'SIGKILL'), 'survivors get SIGKILL');
  const log = fs.readFileSync(path.join(dataDir, 'metrics', 'reaper.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const e = log.find((x) => x.pid === 220);
  assert.equal(e.category, 'orphaned agent');
  assert.equal(e.rss, (250000 + 10000) * 1024);
  assert.match(e.cmd, /claude/);
});

test('an active login keeps its tmux session; dry run and mode off kill nothing', () => {
  const live = reaper({ loginActive: () => true });
  assert.ok(!live.r.reap().some((k) => k.pid === 260));
  const dry = reaper({ mode: 'dry' });
  const would = dry.r.reap();
  assert.ok(would.length > 0 && would.every((k) => k.dryRun));
  assert.equal(dry.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(dry.dataDir, 'metrics', 'reaper.jsonl'), 'utf8').trim().split('\n').length, would.length);
  dry.r.reap();
  assert.equal(fs.readFileSync(path.join(dry.dataDir, 'metrics', 'reaper.jsonl'), 'utf8').trim().split('\n').length, would.length, 'logged once');
  const off = reaper({ mode: 'off' });
  assert.deepEqual(off.r.reap(), []);
  assert.equal(off.calls.length, 0);
});

test('manual kill refuses the live server, system, owner terminals, running tasks and other users', () => {
  const { r, calls } = reaper();
  for (const pid of [200, 101, 270, 280, 320, 1]) assert.ok([403].includes(r.killPid(pid).status), `pid ${pid}`);
  assert.equal(r.killPid(201).status, 409);
  assert.equal(r.killPid(99999).status, 404);
  assert.equal(calls.length, 0);
  assert.ok(r.killPid(300).ok);
  assert.deepEqual(calls[0], [-300, 'SIGTERM']);
});

test('summary groups trees and estimates reclaimable memory', () => {
  const { r } = reaper();
  const s = r.summary();
  assert.equal(s.system.memAvailable, 1000000 * 1024);
  assert.equal(s.system.cores, 2);
  const cats = s.groups.map((g) => g.category);
  for (const c of ['live server', 'task', 'chat', 'orphaned agent', 'test server', 'browser', 'login session', 'owner terminal', 'system', 'other']) assert.ok(cats.includes(c), c);
  const orphans = s.groups.find((g) => g.category === 'orphaned agent');
  assert.ok(orphans.trees.find((t) => t.pid === 220).reapable);
  assert.ok(!orphans.trees.find((t) => t.pid === 231).reapable);
  assert.ok(s.reclaimable.bytes > s.reclaimable.nowBytes && s.reclaimable.nowBytes > 0);
  assert.ok(s.groups.find((g) => g.category === 'live server').trees[0].top.length > 0);
});

test('GET /api/resources on a test server returns grouped processes and a reclaimable estimate', async () => {
  const PASSWORD = 'resources-test-password';
  const dataDir = tmp('cw-resources-');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  let out = '';
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, CW_NO_ORCHESTRATOR: '1', PORT: String(port), CW_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
      const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
    });
    assert.equal((await fetch(base + '/api/resources')).status, 401);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const r = await fetch(base + '/api/resources', { headers: { cookie } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.system.memTotal > 0 && body.system.processes > 0);
    const live = body.groups.find((g) => g.category === 'live server');
    assert.ok(live.count > 0 && live.trees[0].top.length > 0, 'the server finds itself');
    for (const g of body.groups) for (const t of g.trees) assert.ok(t.pid > 0 && t.count > 0 && typeof t.reapable === 'boolean');
    assert.equal(typeof body.reclaimable.bytes, 'number');
    assert.ok(Array.isArray(body.reaper));
    const k = await fetch(base + '/api/resources/kill', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ pid: child.pid }) });
    assert.equal(k.status, 403);
    assert.equal(child.exitCode, null);
  } finally { child.kill('SIGKILL'); }
});
