// #435: integrators run on workers too. Placement: an integrator takes a free reserved slot on the head first, else goes
// to a worker (one with features 'git' and 'integrate') like any work task; plan and reflect work never leaves the head.
// End to end (test/fixtures/integrate-controller.mjs and a real worker.mjs whose codex is a stub): a task that ran on the
// worker conflicts with main when it lands; its integrator runs on the worker, which merges the task's branch into main
// through the head's git endpoint, resolves it and pushes agent-orch/integrate-<id>; the head fast-forwards main to it,
// rebases it when main moved on meanwhile, and queues at most 3 integrators when the landing keeps conflicting, then
// alerts the owner. The project's origin is a local bare repo (not GitHub), so the worker can only use the head.
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
import { markersIn } from '../worktrees.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
let tmp, logs = '';
const procs = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-integrate-worker-'))); });
after(async () => {
  for (const p of procs) if (p.exitCode == null) p.kill('SIGTERM');
  await Promise.all(procs.map((p) => p.exitCode != null ? null : new Promise((r) => { const t = setTimeout(() => { p.kill('SIGKILL'); r(); }, 10000); p.on('exit', () => { clearTimeout(t); r(); }); })));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('placement: integrators prefer a free reserved head slot, then a worker; plan and reflect stay on the head', { timeout: 60_000 }, async () => {
  const dir = path.join(tmp, 'placement');
  fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { createOrchestrator } from ${url('orchestrator.mjs')};
    import { DatabaseSync } from 'node:sqlite';
    import { execFileSync } from 'node:child_process';
    import path from 'node:path';
    const [dataDir, repos] = process.argv.slice(1), GB = 2 ** 30;
    // 1 core: 2 work slots and 2 reserved ones on the head; the tick is parked, claims are made by hand.
    const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
      broadcast() {}, emitChat() {}, convoExists: () => false, config: { pollMs: 1e9, agentSlots: Infinity, hardware: () => ({ cores: 1, mem: 8 * GB }), meminfo: ${JSON.stringify(fileURLToPath(new URL('./fixtures/meminfo-ample', import.meta.url)))} } });
    const node = (id, features) => ({ id, name: id, os: 'darwin', local: false, status: 'online', connected: true, enabled: true, draining: false, maxSlots: 4, features,
      inventory: { cores: 8, agents: [{ id: 'claude', installed: true, signedIn: true }] }, resources: { memAvailable: 16 * GB, at: Date.now() } });
    // 'old' predates #435 (no 'integrate'); 'mac' merges through the head.
    const nodes = [{ id: 'controller', name: 'vps', local: true, status: 'online', connected: true, enabled: true }, node('old', ['git']), node('mac', ['git', 'integrate'])];
    o.attachCluster({ listNodes: () => nodes, node: (id) => nodes.find((n) => n.id === id) || null, isConnected: () => false, send: () => false, onMessage() {}, version: () => 1 });
    const d = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    let n = 0;
    const project = () => {
      const repo = path.join(repos, 'p' + ++n);
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      return Number(d.prepare("INSERT INTO projects(path,name,priority,status,perpetual,next_reflect_at,position,created_at) VALUES(?,?,50,'active',1,?,?,0)").run(repo, 'p' + n, Date.now() / 1000 + 86400 * 365, n).lastInsertRowid);
    };
    const task = (kind, title, extra = {}) => Number(d.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,integrates,created_at) VALUES(?,?,?,'p',?,?,?)")
      .run(extra.pid ?? project(), kind, title, extra.status || 'queued', extra.integrates ?? null, Date.now() / 1000).lastInsertRowid);
    const integrator = (title) => { const pid = project(); return task('work', title, { pid, integrates: task('work', 'owner of ' + title, { pid, status: 'needs_integration' }) }); };
    const claim = () => { const c = o.claimNext(null); return c && [c.task.title, c.node]; };
    const out = {};
    task('reflect', 'R1'); out.r1 = claim();           // a reserved slot
    integrator('I1'); out.i1 = claim();                // the other reserved slot: the head, though 'mac' is free
    integrator('I2'); out.i2 = claim();                // reserved slots full: a worker that can integrate
    task('plan', 'P1'); out.p1 = claim();
    task('reflect', 'R2'); out.r2 = claim();           // a head work slot
    task('reflect', 'R3'); out.r3 = claim();           // the last one
    task('reflect', 'R4'); out.r4 = claim();           // the head is full: it waits, the free workers never get it
    task('plan', 'P2'); out.p2 = claim();              // plan tasks hold no slot
    console.log(JSON.stringify(out));
    process.exit(0);`, path.join(dir, 'data'), path.join(dir, 'repos')], { cwd: ROOT, encoding: 'utf8', timeout: 50_000 });
  const r = JSON.parse(stdout.trim().split('\n').pop());
  assert.deepEqual(r.r1, ['R1', 'controller']);
  assert.deepEqual(r.i1, ['I1', 'controller'], 'a free reserved slot on the head comes first');
  assert.deepEqual(r.i2, ['I2', 'mac'], "then a worker, and only one that can integrate ('old' can't)");
  assert.deepEqual([r.p1, r.r2, r.r3], [['P1', 'controller'], ['R2', 'controller'], ['R3', 'controller']]);
  assert.equal(r.r4, null, 'reflection waits for the head rather than going to a worker');
  assert.deepEqual(r.p2, ['P2', 'controller']);
});

test('markersIn finds conflict blocks committed since a base, not ones that were there already', async () => {
  const repo = path.join(tmp, 'markers');
  fs.mkdirSync(repo, { recursive: true });
  const commit = (files, msg) => {
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), text);
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
    return git(repo, 'rev-parse', 'HEAD');
  };
  git(repo, 'init', '-q', '-b', 'main');
  const base = commit({ 'fixture.txt': '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n', 'b.md': 'Title\n=======\n' }, 'base');
  const tip = commit({ 'a.js': 'x\n<<<<<<< HEAD\ny\n=======\nz\n>>>>>>> agent-orch/task-4\n', 'c.js': 'fine\n' }, 'resolved?');
  assert.deepEqual(await markersIn(repo, base, tip), ['a.js']);
  assert.deepEqual(await markersIn(repo, base, commit({ 'a.js': 'x\ny\nz\n' }, 'resolved')), []);
});

// A home with a git identity and a bin dir with only the given agent stubs (like cluster-git-e2e).
function machine(dir, name, stubs = {}) {
  const home = path.join(dir, name, 'home'), bin = path.join(dir, name, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  isolatedPath(bin);
  for (const [cli, fixture] of Object.entries(stubs)) fs.writeFileSync(path.join(bin, cli), `#!/bin/sh\nexec node ${path.join(ROOT, 'test/fixtures', fixture)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = ${name}\n\temail = ${name}@test\n`);
  fs.writeFileSync(path.join(dir, name, 'power.json'), '{}');
  return { HOME: home, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off', GIT_CONFIG_NOSYSTEM: '1', AGENT_ORCH_WORKER_POWER: path.join(dir, name, 'power.json') };
}
function start(args, env) {
  const p = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', (d) => { logs += d; });
  procs.push(p);
  return p;
}
// The project: a clone of a local bare origin, with a journal (every task appends to it).
async function scenario(name) {
  const dir = path.join(tmp, name), seed = path.join(dir, 'seed'), origin = path.join(dir, 'origin.git'), project = path.join(dir, 'controller', 'demo');
  fs.mkdirSync(path.join(seed, '.agent-orch'), { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(seed, '.agent-orch', 'JOURNAL.md'), '# Journal\n');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(dir, 'clone', '-q', '--bare', seed, origin);
  const cenv = machine(dir, 'controller'), wenv = machine(dir, 'worker', { codex: 'worker-agent-stub.mjs' });
  git(dir, 'clone', '-q', origin, project);
  const dataDir = path.join(dir, 'controller', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  logs = '';
  const controller = start(['test/fixtures/integrate-controller.mjs', dataDir, project, name], { ...cenv, CW_DATA_DIR: dataDir });
  const lines = readline.createInterface({ input: controller.stdout })[Symbol.asyncIterator]();
  const next = async () => { for (;;) { const { value, done } = await lines.next(); if (done) throw new Error(`controller exited\n${logs}`); if (value.startsWith('{')) return JSON.parse(value); } };
  const { base, code } = await next();
  await promisify(execFile)(process.execPath, ['worker.mjs', 'pair', '--controller', base, '--code', code, '--name', 'mac-worker'], { cwd: ROOT, env: wenv });
  const worker = start(['worker.mjs', 'run'], wenv);
  worker.stdout.on('data', (d) => { logs += d; });
  const r = await next();
  worker.kill('SIGTERM');
  assert.ok(!r.error, `${r.error}\n${logs}`);
  const why = `\n${r.events.join('\n')}\n${logs}`;
  // The task ran on the worker and conflicted with main when it landed; every integrator ran on the worker too.
  assert.equal(r.runs.find((x) => x.task_id === r.owner.id)?.node_id, r.worker, why);
  assert.ok(r.events.some((m) => m.startsWith(`⚠ #${r.owner.id} needs integration: conflicts with main in README.md`)), why);
  assert.ok(r.integrators.length >= 1, why);
  for (const t of r.integrators) {
    assert.equal(t.node_id, r.worker, `integrator #${t.id} ran on the worker${why}`);
    assert.deepEqual(JSON.parse(t.conflicts), ['README.md']);
    assert.deepEqual(r.pushable[t.id], [`agent-orch/integrate-${t.id}`], 'while it ran, the worker could push its integrate branch and nothing else');
    assert.equal(git(project, 'branch', '--list', `agent-orch/integrate-${t.id}`), '', 'the integrate branch is gone');
  }
  // The worker merged the task's branch into main itself (the journal merged cleanly: a union merge there too).
  assert.match(logs, new RegExp(`merging agent-orch/task-${r.owner.id} into [0-9a-f]{8}: conflicts in README\\.md \\(the head saw README\\.md\\)`), why);
  return { ...r, project, origin, why };
}

test('a conflicting task is integrated on the worker and main fast-forwards to the result', { timeout: 150_000 }, async () => {
  const r = await scenario('land');
  const [integ] = r.integrators;
  assert.equal(r.integrators.length, 1, r.why);
  assert.equal(integ.status, 'done', `${integ.result}${r.why}`);
  assert.equal(r.owner.status, 'done', r.why);
  assert.equal(r.owner.result, `Merged by integrator #${integ.id} on mac-worker.`);
  assert.ok(r.events.includes(`✔ #${r.owner.id} merged by integrator #${integ.id} on mac-worker`), r.why);
  // main moved only by the landing: one commit on top of the owner's edits, with the resolution and both journal entries.
  assert.deepEqual(git(r.project, 'log', '--format=%s', '-3', 'main').split('\n'), [`agent-orch #${integ.id}: Integrate #${r.owner.id}: Rewrite README.md`, 'journal entry on main', 'main edit']);
  assert.equal(git(r.project, 'show', 'main:README.md'), 'hello from the stub agent');
  const journal = git(r.project, 'show', 'main:.agent-orch/JOURNAL.md');
  assert.match(journal, /an entry the owner wrote/);
  assert.match(journal, new RegExp(`#${r.owner.id} Rewrite README\\.md \\[done`));
  assert.equal(git(r.project, 'status', '--porcelain'), '', 'the main tree is clean');
  assert.equal(git(r.project, 'branch', '--list', `agent-orch/task-${r.owner.id}`), '', "the task's branch is gone");
  assert.equal(git(r.origin, 'rev-parse', 'main'), git(r.project, 'rev-parse', 'main'), 'and main went on to origin');
});

test('main moving on while the worker integrates: the result is rebased onto it, then lands', { timeout: 150_000 }, async () => {
  const r = await scenario('moved');
  const [integ] = r.integrators;
  assert.equal(r.integrators.length, 1, r.why);
  assert.equal(integ.status, 'done', `${integ.result}${r.why}`);
  assert.equal(r.owner.result, `Merged by integrator #${integ.id} on mac-worker.`);
  assert.deepEqual(git(r.project, 'log', '--format=%s', '-2', 'main').split('\n'), [`agent-orch #${integ.id}: Integrate #${r.owner.id}: Rewrite README.md`, 'main moved on'],
    'the integration landed on top of the commit it had not seen');
  assert.equal(git(r.project, 'show', 'main:README.md'), 'hello from the stub agent');
  assert.equal(git(r.project, 'show', 'main:other.txt'), 'main moved on');
});

test('a landing that keeps conflicting queues at most 3 integrators, then alerts the owner', { timeout: 200_000 }, async () => {
  const r = await scenario('chain');
  assert.equal(r.integrators.length, 3, r.why);
  assert.deepEqual(r.integrators.map((t) => t.status), ['done', 'done', 'failed'], r.why);
  const [a, b, c] = r.integrators;
  assert.match(a.result, new RegExp(`^Resolved on mac-worker, but main moved on meanwhile and conflicts again in: README\\.md\\. Integrator #${b.id} takes over\\.$`));
  assert.match(b.result, new RegExp(`Integrator #${c.id} takes over\\.$`));
  assert.match(c.result, /^main kept moving while 3 integrators resolved #\d+; it still conflicts in: README\.md$/);
  assert.equal(r.owner.status, 'failed');
  assert.match(r.owner.result, new RegExp(`^integrator #${c.id} failed: \\(integration\\)`));
  const alert = r.notes.find((n) => n.title === 'Integration needs you');
  assert.ok(alert, JSON.stringify(r.notes));
  assert.equal(alert.tag, `task-${r.owner.id}`);
  assert.match(alert.body, /still conflicts with main after 3 integrators \(README\.md\)/);
  assert.equal(git(r.project, 'show', 'main:README.md'), 'main round 3', "main keeps the owner's own edits");
  assert.notEqual(git(r.project, 'branch', '--list', `agent-orch/task-${r.owner.id}`), '', 'the work so far stays on its branch');
});
