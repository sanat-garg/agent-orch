// Manual assignment (#444, orchestrator assignable + assignTask): the tasks a machine could start now, and the owner
// starting one there at once, over the node's slot target, but never past a real blocker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('assignable filters by prerequisites, kind and browser profile; assign starts over the target, else 409 with the reason', { timeout: 90_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assign-'));
  const dataDir = path.join(tmp, 'data'), repo = path.join(tmp, 'demo');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
    import { waitFor } from ${JSON.stringify(new URL('./helpers/wait.mjs', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    import path from 'node:path';
    const [dataDir, repo] = process.argv.slice(1), GB = 2 ** 30;
    const o = createOrchestrator({ config: { pollMs: 100, meminfo: ${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)} },
      query: () => (async function* () {})(), dataDir, claudeEnv: { PATH: process.env.PATH }, getLimits: () => [], onSubscription: () => true,
      broadcast() {}, emitChat() {}, convoExists: () => false });
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    // Paused: the scheduler claims nothing by itself, so every start below is the owner's.
    db.prepare("INSERT INTO kv(key,value) VALUES('paused_all','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    const worker = (id, name, osName, agents, extra = {}) => ({ id, name, os: osName, arch: 'arm64', local: false, status: 'online', connected: true, enabled: true,
      draining: false, maxSlots: 1, features: ['git'], inventory: { cores: 8, agents: agents.map((a) => ({ id: a, installed: true, signedIn: true })) },
      resources: { memAvailable: 64 * GB, at: Date.now(), load: [0.5, 0.5, 0.5] }, ...extra });
    // A Mac at its target (1 slot) with a saturated CPU and only Claude; a VPS with Codex too; an offline one.
    const mac = worker('mac', 'mac-1', 'darwin', ['claude'], { resources: { memAvailable: 64 * GB, at: Date.now(), cpu: [97, 95], load: [9, 9, 9] } });
    const nodes = [{ id: 'controller', name: 'oracle-vm', local: true, status: 'online', connected: true, enabled: true },
      mac, worker('vps', 'vps-2', 'linux', ['claude', 'codex']), worker('off', 'off-1', 'linux', ['claude'], { status: 'offline', connected: false })];
    const sent = [];
    let onMsg = () => {};
    o.attachCluster({ listNodes: () => nodes, node: (id) => nodes.find((n) => n.id === id) || null, isConnected: (id) => !!nodes.find((n) => n.id === id)?.connected,
      version: () => 1, onMessage: (fn) => { onMsg = fn; },
      send: (node, msg) => {
        sent.push({ node, ...msg });
        if (msg.t === 'job.offer') setTimeout(() => onMsg(node, { t: 'job.accept', job: msg.job, seq: sent.length, ts: Date.now() }), 10);
        return true;
      } });
    const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,next_reflect_at,created_at) VALUES(?,'demo',50,'active',1,?,0)")
      .run(repo, Date.now() / 1000 + 86400 * 365).lastInsertRowid);
    const task = (title, f = {}) => Number(db.prepare(\`INSERT INTO tasks(project_id,kind,title,prompt,priority,urgency,source,created_at,agent,integrates,capabilities,execution,browser_identity,run_on)
      VALUES(?,?,?,?,50,'normal','user',?,?,?,?,?,?,?)\`).run(pid, f.kind || 'work', title, title, Date.now() / 1000, f.agent ?? null, f.integrates ?? null,
      f.capabilities ?? null, f.execution ?? null, f.identity ?? null, f.runOn ?? null).lastInsertRowid);
    const ids = {};
    ids.a = task('A'); ids.b = task('B'); ids.pre = task('Prerequisite');
    ids.dep = task('Needs the prerequisite');
    db.prepare('INSERT INTO task_deps(task_id, depends_on) VALUES(?, ?)').run(ids.dep, ids.pre);
    ids.reflect = task('Reflect: what else should be done?', { kind: 'reflect' });
    ids.integ = task('Integrate #1', { integrates: ids.a });
    ids.browser = task('Book a table', { capabilities: '["browser"]', execution: 'browser', identity: 'default', runOn: 'vps' });
    ids.codex = task('Codex work', { agent: 'codex', model: 'gpt-5' });
    const list = (node) => o.assignable(node).tasks?.map((t) => t.id);
    const out = { ids, mac: list('mac'), vps: list('vps'), head: list('controller'), off: o.assignable('off'), sample: o.assignable('mac').tasks[0], none: o.assignable('nope') };
    out.first = o.assignTask(ids.a, 'mac');
    await waitFor(() => sent.some((f) => f.t === 'job.start' && f.job === ids.a), { timeout: 30000, message: 'A starts on mac' });
    // The Mac now runs A: it is at its target (1), and B still starts there, at once.
    out.second = o.assignTask(ids.b, 'mac');
    await waitFor(() => sent.some((f) => f.t === 'job.offer' && f.job === ids.b), { timeout: 30000, message: 'B is offered to mac' });
    out.dep = o.assignTask(ids.dep, 'mac');
    out.offline = o.assignTask(ids.pre, 'off');
    out.codex = o.assignTask(ids.codex, 'mac');
    out.again = o.assignTask(ids.a, 'mac');
    out.headOnly = o.assignTask(ids.reflect, 'mac');
    const row = (id) => db.prepare('SELECT status, node_id, run_on FROM tasks WHERE id=?').get(id);
    out.rows = { a: row(ids.a), b: row(ids.b), dep: row(ids.dep) };
    out.events = db.prepare('SELECT task_id, message FROM events WHERE message LIKE ?').all('%assigned by owner%');
    out.offers = sent.filter((f) => f.t === 'job.offer').map((f) => ({ node: f.node, job: f.job, assigned: f.assigned }));
    console.log(JSON.stringify(out));
    process.exit(0);`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo], { cwd: ROOT, encoding: 'utf8', timeout: 80_000 });
    const r = JSON.parse(stdout.trim().split('\n').pop()), { ids } = r;
    // A worker gets plain work only: not the task waiting for a prerequisite, the reflection or the integrator (head-only),
    // the browser task whose profile is on another node, or the Codex task (Codex isn't signed in there).
    assert.deepEqual(r.mac.sort(), [ids.a, ids.b, ids.pre].sort());
    assert.deepEqual(r.vps.sort(), [ids.a, ids.b, ids.pre, ids.codex].sort(), 'the VPS has Codex; the browser task is not a browser worker\'s');
    assert.ok(r.head.includes(ids.reflect) && r.head.includes(ids.integ), 'reflection and integrators are the controller\'s');
    assert.ok(!r.head.includes(ids.dep) && !r.head.includes(ids.browser));
    assert.deepEqual(r.off, { tasks: [] });
    assert.equal(r.none.status, 404);
    assert.deepEqual(Object.keys(r.sample).sort(), ['agent', 'files', 'id', 'model', 'title', 'urgency', 'waitingSince']);
    assert.equal(r.sample.agent, 'claude');
    // Started at once, pinned there, with the CPU warning; the second goes over the Mac's target of 1.
    assert.deepEqual(r.first, { started: true, taskId: ids.a, node: 'mac', warning: 'CPU busy' });
    assert.deepEqual(r.second, { started: true, taskId: ids.b, node: 'mac', warning: 'CPU busy' });
    assert.deepEqual(r.rows.a, { status: 'running', node_id: 'mac', run_on: 'mac' });
    assert.deepEqual(r.rows.b, { status: 'running', node_id: 'mac', run_on: 'mac' });
    assert.deepEqual(r.offers.map((f) => [f.node, f.job, f.assigned]), [['mac', ids.a, true], ['mac', ids.b, true]]);
    assert.deepEqual(r.events.map((e) => [e.task_id, e.message]), [[ids.a, `#${ids.a} assigned by owner to mac-1`], [ids.b, `#${ids.b} assigned by owner to mac-1`]]);
    // Real blockers stay: 409 with a plain reason, and nothing changes.
    assert.deepEqual(r.dep, { error: `#${ids.dep} waits for #${ids.pre}`, status: 409 });
    assert.deepEqual(r.rows.dep, { status: 'queued', node_id: null, run_on: null });
    assert.deepEqual(r.offline, { error: 'node offline', status: 409 });
    assert.deepEqual(r.codex, { error: "Codex isn't signed in on this Mac", status: 409 });
    assert.deepEqual(r.again, { error: 'already running', status: 409 });
    assert.equal(r.headOnly.status, 409);
    assert.match(r.headOnly.error, /runs only on the controller/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
