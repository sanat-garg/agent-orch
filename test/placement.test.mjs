// Placement (BRIEF goal 9, PLACEMENT RULE; placement.mjs, orchestrator place): RAM, battery, AC power and heat never
// block a machine; only a CPU saturated for a minute does (PSI some avg60 > 90%, else load > 2.5 × cores); ready tasks
// spread by (running + 1) / slots with round-robin ties, so every machine gets work, the Pro-like node (battery 1%, 'ac')
// included; every node carries its last placement decision, also in GET /api/cluster/nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpuState, parsePsi, pickNode, slotTarget } from '../placement.mjs';
import { checkPolicy, effectivePolicy, policyDefaults } from '../power.mjs';
import { taskSlots } from '../parallel.mjs';
import { capRejection, capSlots } from '../cap.mjs';
import { CLAIM_PATH, PAIR_PATH } from '../cluster-protocol.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CPU saturation: PSI avg60 over 90% on Linux, else the 1-min load over 2.5 × cores; no reading never skips', () => {
  assert.equal(parsePsi('some avg10=97.00 avg60=93.50 avg300=40.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'), 93.5);
  assert.equal(parsePsi(''), null);
  assert.deepEqual(cpuState({ psi: 93.5, load: [0.1] }, 1), { saturated: true, text: 'CPU pressure 93.5% over 60 s' });
  assert.equal(cpuState({ psi: 60, load: [40, 40, 40] }, 1).saturated, false, 'PSI wins over a high load (tasks waiting on I/O)');
  assert.deepEqual(cpuState({ load: [22, 10, 5] }, 8), { saturated: true, text: 'load 22/8' });
  assert.equal(cpuState({ load: [20, 10, 5] }, 8).saturated, false, '2.5 × cores is still eligible');
  assert.equal(cpuState({ load: [3.9] }, 1).saturated, true);
  assert.equal(cpuState({}, 8), null);
  assert.equal(cpuState(null, null), null);
});

test('slots: cores, at least 4; the controller\'s taskSlots ignore memory; the power policy is keep-awake only', () => {
  assert.deepEqual([slotTarget(1), slotTarget(8), slotTarget(12), slotTarget(undefined)], [4, 8, 12, 4]);
  assert.equal(taskSlots({ setting: 4 }), 4);
  assert.equal(taskSlots({ setting: 4, pacingLimit: 1 }), 1);
  assert.deepEqual(policyDefaults('darwin'), { keepAwake: 'ac' });
  assert.deepEqual(effectivePolicy('darwin', { minBattery: null, thermal: 'moderate', reserveGB: 8, keepAwake: 'always' }), { keepAwake: 'always' });
  assert.match(checkPolicy({ minBattery: 50 }).error, /no longer a setting/);
  assert.deepEqual(checkPolicy({ keepAwake: 'never' }).value, { keepAwake: 'never' });
});

test('pickNode: lowest (running + 1) / slots, ties to the least recently picked', () => {
  const picked = new Map();
  const nodes = [{ id: 'vps', running: 0, slots: 4 }, { id: 'air', running: 0, slots: 8 }, { id: 'pro', running: 0, slots: 12 }];
  assert.equal(pickNode(nodes, picked).id, 'pro');
  const tie = [{ id: 'a', running: 0, slots: 4 }, { id: 'b', running: 2, slots: 12 }];
  assert.equal(pickNode(tie).id, 'a', '1/4 = 3/12: list order');
  picked.set('a', 1);
  assert.equal(pickNode(tie, picked).id, 'b', 'round-robin');
  assert.equal(pickNode([{ id: 'a', running: 1, slots: 4 }, { id: 'b', running: 3, slots: 12 }], picked).id, 'b', '2/4 > 4/12');
  assert.equal(pickNode([]), null);
  assert.equal(pickNode([{ id: 'capped', running: 0, cores: 12, slots: 1 }, { id: 'air', running: 0, cores: 8, slots: 8 }]).id,
    'capped', 'owner ceilings do not change the core-weighted ranking');
});

test('legacy local RAM and AC caps never block intake; explicit CPU/task caps remain ceilings', () => {
  const cap = { mem: 1, onlyOnAc: true };
  assert.equal(capSlots(cap, { jobsMem: 2 ** 30, footprint: 2 ** 30 }), Infinity);
  assert.equal(capRejection(cap, { jobs: 4, jobsMem: 2 ** 30, footprint: 2 ** 30 }), null);
  assert.equal(capSlots({ ...cap, cpu: 2, maxTasks: 3 }), 2);
  assert.equal(capRejection({ ...cap, maxTasks: 2 }, { jobs: 2 }).kind, 'tasks');
});

// The owner's cluster: the 1-core VPS controller, two 8-core Airs and the 12-core Pro. The Air has 200 MB free, is on
// battery at 5% and running hot; the Pro reports a bogus battery of 1% on 'ac' and, as a worker from before #344, an
// intake that says no. None of that matters: 10 ready tasks spread over all four by their slots (4, 8, 8, 12).
test('10 ready tasks spread over 4 nodes by slots; RAM, battery and AC never block, a saturated CPU does', { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-placement-'));
  const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    import { execFileSync } from 'node:child_process';
    import path from 'node:path';
    const [dataDir, tmp] = process.argv.slice(1), GB = 2 ** 30, MB = 2 ** 20;
    const claude = [{ id: 'claude', installed: true, signedIn: true }];
    const node = (id, os, cores, res = {}) => ({ id, name: id, os, local: false, status: 'online', connected: true, enabled: true, draining: false, maxSlots: null,
      inventory: { cores, agents: claude }, resources: { memAvailable: 16 * GB, load: [0.5, 0.5, 0.5], at: Date.now(), ...res }, policy: { keepAwake: 'ac' } });
    const nodes = [
      { id: 'controller', name: 'vps', local: true, status: 'online', connected: true, enabled: true, inventory: { cores: 1, agents: claude },
        resources: { memAvailable: 150 * MB, load: [0.9, 0.9, 0.9], psi: 12 } },
      node('air', 'darwin', 8, { memAvailable: 200 * MB, battery: { pct: 5, charging: false, source: 'battery' }, thermal: { pressure: 'throttled', speedLimit: 50, level: 'heavy' } }),
      node('soham', 'darwin', 8),
      node('pro', 'darwin', 12, { cap: { mem: 1, onlyOnAc: true }, jobsMem: 2 * GB, battery: { pct: 1, charging: false, source: 'ac' }, intake: { ok: false, reason: 'battery', text: 'On battery (1%): takes new tasks only on AC power' } }),
    ];
    let version = 1;
    const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
      broadcast() {}, emitChat() {}, convoExists: () => false,
      config: { pollMs: 1e9, parallelTasks: 4, agentSlots: 'auto', controllerWork: true, meminfo: '/nonexistent' } });
    o.attachCluster({ listNodes: () => nodes, node: (id) => nodes.find((n) => n.id === id) || null, isConnected: () => false, send: () => false,
      onMessage() {}, version: () => version });
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    // One project (its own GitHub repo) per task: tasks claimed here never start, so nothing else would share a project.
    let projects = 0;
    const add = (n) => {
      for (let i = 0; i < n; i++) {
        const repo = path.join(tmp, 'repo' + ++projects);
        execFileSync('git', ['init', '-q', '-b', 'main', repo]);
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/test-owner/spread' + projects + '.git'], { cwd: repo });
        const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,position,created_at) VALUES(?,?,50,'active',0,?,0)").run(repo, 'p' + projects, projects).lastInsertRowid);
        db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,files,created_at) VALUES(?,'work',?,'p',?,?)").run(pid, 't' + projects, JSON.stringify(['a.txt']), Date.now() / 1000);
      }
    };
    const claimAll = () => { const got = []; for (let c; (c = o.claimNext(null));) got.push(c.node); return got; };
    const count = (list) => Object.fromEntries(nodes.map((n) => [n.id, list.filter((x) => x === n.id).length]));
    const decisions = () => Object.fromEntries(o.machines(nodes).map((n) => [n.id, n.lastDecision]));
    const out = { before: decisions() };
    const codex = { ...nodes[2], inventory: { cores: 8, agents: [{ id: 'codex', installed: true, signedIn: true }] } };
    out.explanations = o.machines([
      { ...codex, resources: { load: [22] } },
      { ...codex, inventory: { cores: 8, agents: [{ id: 'codex', installed: true, signedIn: false }] } },
      { ...codex, enabled: false },
    ]).map((n) => n.lastDecision.text);
    add(10);
    out.spread = count(claimAll());
    out.after = decisions();
    // Soham's CPU saturates (load 30 on 8 cores): the next ready tasks go elsewhere, and its card says why.
    db.prepare("UPDATE tasks SET status='done' WHERE status='running'").run();
    nodes[2].resources = { ...nodes[2].resources, load: [30, 12, 6] }; version++;
    add(8);
    out.saturated = count(claimAll());
    out.soham = decisions().soham;
    out.capacity = o.stateView().capacity;
    console.log(JSON.stringify(out));
    process.exit(0);`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, path.join(tmp, 'data'), tmp], { encoding: 'utf8', timeout: 30000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    // Before any placement: each node's state now (at null).
    assert.deepEqual(Object.values(r.before).map((d) => [d.at, d.ok]), [[null, true], [null, true], [null, true], [null, true]]);
    assert.equal(r.before.pro.text, 'eligible: 0/12 running');
    assert.deepEqual(r.explanations, ['skipped: CPU saturated (load 22/8)', 'skipped: agent codex signed out', 'skipped: disabled']);
    // (running + 1) / slots with round-robin ties: the Pro 4, the Airs 3 and 2, the 1-core VPS (4 slots) 1.
    assert.deepEqual(r.spread, { controller: 1, air: 3, soham: 2, pro: 4 });
    for (const [id, d] of Object.entries(r.after)) {
      assert.ok(d.at > 0, `${id} was weighed`);
      assert.match(d.text, /^eligible: \d+\/\d+ running/, `${id}: ${d.text}`);
    }
    // Saturated: Soham takes nothing; the other three share the 8 by their slots.
    assert.equal(r.saturated.soham, 0);
    assert.equal(r.saturated.controller + r.saturated.air + r.saturated.pro, 8);
    assert.ok(r.saturated.controller >= 1 && r.saturated.air >= 1 && r.saturated.pro > r.saturated.air, JSON.stringify(r.saturated));
    assert.deepEqual([r.soham.ok, r.soham.text], [false, 'skipped: CPU saturated (load 30/8)']);
    assert.equal(r.capacity.workers, 8 + 12, 'a saturated node adds no capacity; RAM takes none away');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

test('GET /api/cluster/nodes: every node has a lastDecision; a disabled one says so', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-placement-api-'));
  const salt = crypto.randomBytes(16).toString('hex'), password = 'placement-password';
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') }));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' } });
  try {
    let out = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
      const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
    });
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = async (p, method = 'GET', body) => (await fetch(base + p, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body && JSON.stringify(body) })).json();
    const { code } = await call(PAIR_PATH, 'POST', {});
    const paired = await (await fetch(base + CLAIM_PATH, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'MacBook Pro', os: 'darwin', arch: 'arm64' }) })).json();
    await call(`/api/cluster/nodes/${paired.node}`, 'PATCH', { enabled: false });
    const { nodes } = await call('/api/cluster/nodes');
    assert.equal(nodes.length, 2);
    for (const n of nodes) assert.match(n.lastDecision?.text || '', /^(eligible|skipped): /, `${n.id}: ${JSON.stringify(n.lastDecision)}`);
    assert.equal(nodes.find((n) => n.id === paired.node).lastDecision.text, 'skipped: disabled');
    assert.equal(nodes.find((n) => n.id === paired.node).maxSlots, null, 'a new node starts on Auto');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
