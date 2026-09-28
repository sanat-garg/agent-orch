// A Mac worker's power policy (power.mjs): the readings (pmset batt/therm, the thermal pressure level) parsed from
// fixtures, the intake decisions on AC, on battery and when hot, keep-awake only while jobs run, the caffeinate manager
// (stubbed spawn), the policy on the controller's hub (defaults per OS in welcome, the owner's edits pushed as
// node.policy, 'paused' while the worker reports no intake), and the scheduler's caps (Auto = cores − 1 on a Mac, 3 GB
// left free for its owner).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createCluster } from '../cluster.mjs';
import { PROTOCOL_VERSION, WS_PATH, FEATURE_LIST, createSender } from '../cluster-protocol.mjs';
import {
  autoTasks, checkPolicy, createKeepAwake, effectivePolicy, intake, parsePressure, policyDefaults, readPower, thermalLevel, wantsAwake,
} from '../power.mjs';
import { waitFor } from './helpers/wait.mjs';

// What a MacBook prints (pmset -g batt / pmset -g therm / notifyutil -g com.apple.system.thermalpressurelevel).
const BATT = {
  acCharging: "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t64%; charging; 1:10 remaining present: true\n",
  acFull: "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true\n",
  battery: (pct) => `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t${pct}%; discharging; 3:12 remaining present: true\n`,
  mini: "Now drawing from 'AC Power'\n", // a Mac mini: no battery
};
const THERM = {
  nominal: 'Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded\n',
  limited: (pct) => `CPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= ${pct}\n`,
};
const PRESSURE = (level) => `com.apple.system.thermalpressurelevel ${level}\n`;
const MAC = effectivePolicy('darwin');
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-macos-power-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
async function reading(batt, therm = THERM.nominal, pressure = PRESSURE(0)) {
  const f = path.join(tmp, 'power.json');
  fs.writeFileSync(f, JSON.stringify({ batt, therm, pressure }));
  return readPower({ fixture: f });
}

test('readings: battery and power source from pmset, thermal pressure from pmset and notifyutil', async () => {
  assert.deepEqual((await reading(BATT.acCharging)).battery, { pct: 64, charging: true, source: 'ac' });
  assert.deepEqual((await reading(BATT.battery(42))).battery, { pct: 42, charging: false, source: 'battery' });
  assert.equal((await reading(BATT.mini)).battery, null);
  const cool = await reading(BATT.acFull);
  assert.deepEqual([cool.thermal.pressure, cool.thermal.level, thermalLevel(cool.thermal)], ['nominal', 'nominal', 'nominal']);
  const hot = await reading(BATT.acFull, THERM.nominal, PRESSURE(2));
  assert.deepEqual([hot.thermal.pressure, hot.thermal.level], ['throttled', 'heavy']);
  assert.equal(parsePressure(PRESSURE(4)), 'sleeping');
  assert.equal(parsePressure('garbage'), null);
  // Without notifyutil's level, pmset's CPU speed limit decides: under 100% is moderate, 70% or less is heavy.
  assert.equal(thermalLevel((await reading(BATT.acFull, THERM.limited(85), '')).thermal), 'moderate');
  assert.equal(thermalLevel((await reading(BATT.acFull, THERM.limited(65), '')).thermal), 'heavy');
  assert.equal((await reading('', '', '')).thermal, null);
});

test('intake: new jobs on AC power, or on battery above 50% by default; paused at heavy thermal pressure', async () => {
  const decide = async (policy, ...r) => intake(policy, await reading(...r));
  assert.deepEqual(await decide(MAC, BATT.acCharging), { ok: true }, 'AC power at any charge');
  assert.deepEqual(await decide(MAC, BATT.mini), { ok: true }, 'no battery');
  assert.equal((await decide(MAC, BATT.battery(51))).ok, true);
  const low = await decide(MAC, BATT.battery(50));
  assert.deepEqual([low.ok, low.reason, low.text], [false, 'battery', 'On battery at 50%: takes new tasks above 50%']);
  assert.equal((await decide({ ...MAC, minBattery: 30 }, BATT.battery(42))).ok, true, 'the threshold is configurable');
  const acOnly = await decide({ ...MAC, minBattery: null }, BATT.battery(95));
  assert.deepEqual([acOnly.ok, acOnly.reason], [false, 'battery']);
  assert.match(acOnly.text, /only on AC power/);
  assert.equal((await decide({ ...MAC, minBattery: 0 }, BATT.battery(3))).ok, true);
  // Thermal pressure: heavy or worse pauses by default; 'moderate' is stricter, 'off' ignores it.
  const hot = await decide(MAC, BATT.acCharging, THERM.nominal, PRESSURE(2));
  assert.deepEqual([hot.ok, hot.reason], [false, 'thermal']);
  assert.equal((await decide(MAC, BATT.acCharging, THERM.nominal, PRESSURE(1))).ok, true);
  assert.equal((await decide({ ...MAC, thermal: 'moderate' }, BATT.acCharging, THERM.nominal, PRESSURE(1))).ok, false);
  assert.equal((await decide({ ...MAC, thermal: 'off' }, BATT.acCharging, THERM.nominal, PRESSURE(3))).ok, true);
  assert.equal((await decide(MAC, BATT.acCharging, THERM.limited(60), '')).reason, 'thermal', 'pmset alone');
  assert.deepEqual(intake(MAC, null), { ok: true }, 'no readings (a VPS) never blocks');
});

test('keep awake only while jobs run, and by default only on AC power', async () => {
  const ac = await reading(BATT.acCharging), batt = await reading(BATT.battery(80)), mini = await reading(BATT.mini);
  assert.equal(wantsAwake(MAC, ac, 1), true);
  assert.equal(wantsAwake(MAC, ac, 0), false, 'idle: the Mac may sleep');
  assert.equal(wantsAwake(MAC, batt, 2), false, 'on battery by default');
  assert.equal(wantsAwake(MAC, mini, 1), true);
  assert.equal(wantsAwake({ ...MAC, keepAwake: 'always' }, batt, 1), true);
  assert.equal(wantsAwake({ ...MAC, keepAwake: 'never' }, ac, 1), false);
});

test('caffeinate -i -w <worker pid> starts with the first job and stops with the last (stubbed spawn)', () => {
  const spawned = [], killed = [], lines = [];
  const spawn = (bin, args) => { const c = Object.assign(new EventEmitter(), { pid: 9000 + spawned.length }); spawned.push({ bin, args, c }); return c; };
  const k = createKeepAwake({ bin: '/usr/bin/caffeinate', pid: 4242, spawn, kill: (pid) => killed.push(pid), log: (m) => lines.push(m) });
  const ac = { battery: { pct: 90, charging: true, source: 'ac' } }, batt = { battery: { pct: 90, charging: false, source: 'battery' } };
  let jobs = 0;
  const tick = (power = ac) => k.set(wantsAwake(MAC, power, jobs));
  tick();
  assert.equal(spawned.length, 0, 'nothing runs while idle');
  jobs = 1; tick(); jobs = 2; tick();
  assert.deepEqual(spawned.map((s) => [s.bin, s.args]), [['/usr/bin/caffeinate', ['-i', '-w', '4242']]], 'one caffeinate for all jobs');
  assert.equal(k.active(), true);
  jobs = 1; tick();
  assert.deepEqual(killed, []);
  jobs = 0; tick();
  assert.deepEqual(killed, [9000]);
  assert.equal(k.active(), false);
  // Unplugged mid-job: it stops (keepAwake 'ac'), and starts again once back on power.
  jobs = 1; tick(); tick(batt); tick(ac);
  assert.deepEqual([spawned.length, killed], [3, [9000, 9001]]);
  // One that dies at once isn't respawned in a loop.
  spawned[2].c.emit('exit', 1, null);
  tick(); tick();
  assert.equal(spawned.length, 3);
  assert.equal(k.active(), false);
  assert.ok(lines.some((l) => /caffeinate -i -w 4242/.test(l)));
  k.stop();
});

test('policy settings: defaults per OS, validation, Auto task cap', () => {
  assert.deepEqual(policyDefaults('darwin'), { minBattery: 50, keepAwake: 'ac', thermal: 'heavy', reserveGB: 3 });
  assert.equal(policyDefaults('linux').reserveGB, 0);
  assert.deepEqual(effectivePolicy('darwin', { minBattery: null }), { ...MAC, minBattery: null });
  for (const bad of [{ minBattery: 101 }, { minBattery: '50' }, { keepAwake: 'lid' }, { thermal: 'hot' }, { reserveGB: -1 }, { cpu: 1 }, [], null]) {
    assert.ok(checkPolicy(bad).error, JSON.stringify(bad));
  }
  assert.deepEqual(checkPolicy({ minBattery: 25, keepAwake: 'always', thermal: 'moderate', reserveGB: 4.5 }).value,
    { minBattery: 25, keepAwake: 'always', thermal: 'moderate', reserveGB: 4.5 });
  assert.deepEqual([autoTasks('darwin', 8), autoTasks('darwin', 1), autoTasks('linux', 8)], [7, 1, 8]);
});

// ---- the policy on the controller's hub
test('hub: welcome carries the policy, owner edits reach the worker as node.policy, no intake shows as paused', async (t) => {
  const hub = createCluster({ dbFile: path.join(tmp, 'hub.db'), heartbeatMs: 300 });
  const server = http.createServer((req, r) => { r.writeHead(404); r.end(); });
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sockets = [];
  t.after(() => { for (const ws of sockets) ws.terminate(); hub.close(); server.close(); });
  async function worker(name, kind, features = FEATURE_LIST) {
    const { code } = hub.createPairing();
    const { node, token } = hub.claim({ code, name, os: kind, arch: 'arm64' });
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}${WS_PATH}`, { headers: { authorization: `Bearer ${token}` } });
    sockets.push(ws);
    const frames = [], sender = createSender('w');
    const send = (t, f = {}) => ws.send(sender(t, f));
    ws.on('message', (d) => { const f = JSON.parse(d); frames.push(f); if (f.t === 'heartbeat') send('heartbeat'); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    send('hello', { node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [], ...(features ? { features } : {}) });
    await waitFor(() => frames.find((f) => f.t === 'welcome'), { timeout: 5000 });
    return { node, frames, send, got: (t) => frames.filter((f) => f.t === t) };
  }
  const mac = await worker('MacBook Pro (policy)', 'darwin');
  assert.deepEqual(mac.got('welcome')[0].policy, { minBattery: 50, keepAwake: 'ac', thermal: 'heavy', reserveGB: 3, maxTasks: null });
  assert.deepEqual(hub.node(mac.node).policy, MAC);
  const vps = await worker('vps-policy', 'linux');
  assert.equal(vps.got('welcome')[0].policy.reserveGB, 0);

  // The owner's edits: merged over the defaults, stored, and sent to the worker right away.
  assert.equal(hub.update(mac.node, { policy: { minBattery: null, keepAwake: 'always' } }).node.policy.minBattery, null);
  let p = await waitFor(() => mac.got('node.policy')[0], { timeout: 5000 });
  assert.deepEqual(p.policy, { minBattery: null, keepAwake: 'always', thermal: 'heavy', reserveGB: 3, maxTasks: null });
  hub.update(mac.node, { maxSlots: 2 });
  p = await waitFor(() => mac.got('node.policy')[1], { timeout: 5000 });
  assert.deepEqual([p.policy.maxTasks, p.policy.keepAwake], [2, 'always']);
  assert.equal(hub.update(mac.node, { policy: { minBattery: 150 } }).status, 400);
  assert.equal(hub.update(mac.node, { policy: { lid: 'open' } }).status, 400);
  assert.equal(hub.update('controller', { policy: { minBattery: 20 } }).status, 400);
  assert.deepEqual(hub.update(mac.node, { policy: null }).node.policy, MAC);
  // A worker that predates node.policy gets it in its next welcome only.
  const old = await worker('MacBook Air (old)', 'darwin', null);
  hub.update(old.node, { policy: { reserveGB: 4 } });
  assert.equal(old.got('node.policy').length, 0);

  // The worker reports its intake with its telemetry: paused while it takes no new jobs, online again after.
  const res = (intakeState) => ({ memAvailable: 8e9, load: [0.1, 0.1, 0.1], running: [], intake: intakeState });
  mac.send('resources', res({ ok: false, reason: 'battery', text: 'On battery at 42%: takes new tasks above 50%' }));
  await waitFor(() => hub.node(mac.node).status === 'paused', { timeout: 5000, message: 'paused' });
  assert.equal(hub.node(mac.node).resources.intake.reason, 'battery');
  mac.send('resources', res({ ok: true }));
  await waitFor(() => hub.node(mac.node).status === 'online', { timeout: 5000, message: 'online again' });
});

// ---- the scheduler (orchestrator nodeCap / capacityView) with a stub hub
test('scheduler: a Mac on Auto takes at most cores − 1 tasks and leaves 3 GB free, saying why when none fits; a paused Mac takes none', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'orch-'));
  const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
    import { effectivePolicy } from ${JSON.stringify(new URL('../power.mjs', import.meta.url).href)};
    const GB = 2 ** 30, node = (id, os, cores, free, extra = {}) => ({ id, name: id, os, local: false, status: 'online', connected: true, enabled: true,
      draining: false, maxSlots: null, inventory: { cores, agents: [] }, resources: { memAvailable: free * GB, at: Date.now() }, policy: effectivePolicy(os), ...extra });
    const nodes = [{ id: 'controller', local: true, status: 'online', connected: true, enabled: true },
      node('mac-tight', 'darwin', 8, 8), node('mac-roomy', 'darwin', 8, 32), node('mac-set', 'darwin', 8, 32, { maxSlots: 8 }),
      node('vps', 'linux', 8, 8), node('mac-battery', 'darwin', 8, 32, { status: 'paused' }), node('mac-full', 'darwin', 8, 3.5)];
    let version = 1;
    const o = createOrchestrator({ query: () => (async function* () {})(), dataDir: process.argv[1], disabled: true, claudeEnv: {}, getLimits: () => [],
      onSubscription: () => false, broadcast() {}, emitChat() {}, convoExists: () => false });
    o.attachCluster({ listNodes: () => nodes, onMessage() {}, version: () => version });
    const slots = Object.fromEntries(o.machines(nodes).map((n) => [n.id, n.slots])), why = Object.fromEntries(o.machines(nodes).map((n) => [n.id, n.slotsWhy]));
    console.log(JSON.stringify({ slots, why, workers: o.stateView().capacity.workers }));
    process.exit(0);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir], { encoding: 'utf8', timeout: 30000 });
  const r = JSON.parse(stdout.trim().split('\n').pop());
  // mac-tight: min(8 − 1 cores, (8 GB free − 3 GB for the owner) / 1.2 GB per run = 4); mac-roomy: cores − 1 = 7;
  // mac-set: the owner's explicit 8; vps: min(8, (8 − 0.8) / 1.2 = 6).
  assert.deepEqual([r.slots['mac-tight'], r.slots['mac-roomy'], r.slots['mac-set'], r.slots.vps], [4, 7, 8, 6]);
  assert.equal(r.workers, 4 + 7 + 8 + 6, 'the paused Mac adds no capacity');
  // mac-full: (3.5 − 3) GB fits no 1.2 GB run, and its card says why.
  assert.equal(r.slots['mac-full'], 0);
  assert.equal(r.why['mac-full'], 'Auto fits no task: 3.5 GB free, and a task needs 1.2 GB on top of the 3 GB kept free');
  assert.deepEqual(Object.entries(r.why).filter(([id, w]) => w && id !== 'mac-full'), []);
});
