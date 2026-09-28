// A worker machine's power policy (BRIEF goal 11; .agent-orch/CLUSTER.md "Power policy"), set per node on the head and
// applied by the worker. The controller (cluster.mjs) stores each node's settings and sends the effective policy in
// `welcome` and `node.policy`; the worker (worker.mjs) keeps a Mac awake while it runs jobs. Battery, AC power, heat and
// RAM never decide whether a machine takes work (BRIEF goal 9, PLACEMENT RULE; placement.mjs): the readings here are
// telemetry for the Machines view and keep-awake only. Only node built-ins, helpers.mjs and the pmset parsers in resources.mjs.
//   keepAwake   while jobs run, `caffeinate -i -w <worker pid>`: 'ac' (only on AC power), 'always' or 'never'
// Its task cap is the node's max tasks (nodes.max_slots, sent as maxTasks): Auto = placement.mjs slotTarget.
import fs from 'node:fs';
import { helperOut, killGroup, spawnHelper } from './helpers.mjs';
import { parseBattery, parseThermal } from './resources.mjs';

export const KEEP_AWAKE = ['ac', 'always', 'never'];
// macOS thermal pressure levels (kOSThermalPressureLevel*, <libkern/OSThermalNotification.h>), mildest first.
export const PRESSURE = ['nominal', 'moderate', 'heavy', 'trapping', 'sleeping'];
export const PRESSURE_KEY = 'com.apple.system.thermalpressurelevel';

export const policyDefaults = () => ({ keepAwake: 'ac' });
// The owner's settings over the defaults (stored = only what the owner changed; null = none). Settings from before #344
// (minBattery, thermal, reserveGB) are dropped: nothing gates on them any more.
export const effectivePolicy = (os, stored) => ({ ...policyDefaults(os), ...(KEEP_AWAKE.includes(stored?.keepAwake) ? { keepAwake: stored.keepAwake } : {}) });

// An owner's edit (PATCH /api/cluster/nodes/:id {policy}): only the keys given. {value} or {error}.
export function checkPolicy(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'policy must be an object, or null for the defaults' };
  for (const [k, v] of Object.entries(patch)) {
    const bad = k === 'keepAwake' ? !KEEP_AWAKE.includes(v) && `keepAwake must be one of ${KEEP_AWAKE.join(', ')}`
      : ['minBattery', 'thermal', 'reserveGB'].includes(k) ? `${k} is no longer a setting: battery, heat and RAM never decide where tasks run`
        : `unknown policy setting ${k}`;
    if (bad) return { error: bad };
  }
  return { value: { ...patch } };
}

// `notifyutil -g com.apple.system.thermalpressurelevel` ("com.apple.system.thermalpressurelevel 2") → 'heavy', or null.
export function parsePressure(text) {
  const m = new RegExp(`${PRESSURE_KEY.replace(/\./g, '\\.')}\\s+(\\d+)`).exec(text || '');
  return m ? PRESSURE[Math.min(Number(m[1]), PRESSURE.length - 1)] : null;
}
// The thermal pressure level: the notify level when known, else from pmset alone (a CPU speed limit is moderate
// pressure; 70% or less, or a thermal warning, is heavy). null without a reading.
export function thermalLevel(thermal) {
  if (!thermal) return null;
  if (PRESSURE.includes(thermal.level)) return thermal.level;
  const s = thermal.speedLimit;
  if (thermal.warning > 0 || (s != null && s <= 70)) return 'heavy';
  return s != null && s < 100 ? 'moderate' : 'nominal';
}

// A Mac's power: {battery: {pct, charging, source} | null, thermal: {pressure, speedLimit, warning, level} | null} from
// `pmset -g batt`, `pmset -g therm` and the thermal pressure level (notifyutil: no powermetrics, no root). fixture: a
// JSON file {batt, therm, pressure} holding those outputs instead (tests; re-read on every call).
export async function readPower({ fixture = process.env.AGENT_ORCH_WORKER_POWER } = {}) {
  let t = {};
  if (fixture) { try { t = JSON.parse(fs.readFileSync(fixture, 'utf8')); } catch {} }
  else {
    const out = (cmd, args) => helperOut(cmd, args, { timeoutMs: 3000 }).catch(() => '');
    [t.batt, t.therm, t.pressure] = await Promise.all([out('/usr/bin/pmset', ['-g', 'batt']), out('/usr/bin/pmset', ['-g', 'therm']),
      out('/usr/bin/notifyutil', ['-g', PRESSURE_KEY])]);
  }
  const therm = parseThermal(t.therm), level = parsePressure(t.pressure);
  let thermal = null;
  if (therm || level) {
    thermal = { pressure: 'nominal', speedLimit: null, warning: null, ...therm, ...(level ? { level } : {}) };
    if (PRESSURE.indexOf(level) > 0) thermal.pressure = 'throttled';
  }
  return { battery: parseBattery(t.batt), thermal };
}

const onBattery = (power) => power?.battery?.source === 'battery';
// Keep the machine awake now? Only while jobs run, and per keepAwake ('ac': not on battery power).
export const wantsAwake = (policy, power, busy) => !!busy && (policy?.keepAwake === 'always' || (policy?.keepAwake === 'ac' && !onBattery(power)));

// `caffeinate -i -w <pid>` while wanted: idle sleep is held off until it is stopped or <pid> (the worker) exits. A closed
// lid or a manual sleep still sleeps the Mac; the controller's failover then moves its jobs (CLUSTER.md, Failure modes).
// set(on) starts or stops it (idempotent); one that fails to start, or dies within 5 s, isn't retried for a minute.
export function createKeepAwake({ bin = process.env.AGENT_ORCH_WORKER_CAFFEINATE || '/usr/bin/caffeinate', pid = process.pid,
  spawn = spawnHelper, kill = killGroup, log = () => {} } = {}) {
  let child = null, failedAt = 0;
  function start() {
    if (Date.now() - failedAt < 60_000) return;
    let c;
    try { c = spawn(bin, ['-i', '-w', String(pid)], { stdio: 'ignore' }); } catch (e) { failedAt = Date.now(); return log(`caffeinate failed: ${e.message}`, 'warn'); }
    const at = Date.now();
    child = c;
    c.on('error', (e) => { failedAt = Date.now(); log(`caffeinate failed: ${e.message}`, 'warn'); if (child === c) child = null; });
    c.on('exit', () => {
      if (child !== c) return;
      child = null;
      if (Date.now() - at < 5000) failedAt = Date.now();
      log('caffeinate exited on its own', 'warn');
    });
    log(`keeping this Mac awake while jobs run (caffeinate -i -w ${pid})`);
  }
  function set(on) {
    if (on && !child) start();
    else if (!on && child) {
      const c = child;
      child = null;
      if (c.pid) kill(c.pid);
      log('caffeinate stopped: this Mac may sleep again');
    }
    return !!child;
  }
  return { set, active: () => !!child, stop: () => set(false) };
}
