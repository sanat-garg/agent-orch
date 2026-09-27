// A worker machine's power policy (BRIEF goal 11; .agent-orch/CLUSTER.md "Power policy"), set per node on the head and
// enforced by the worker. The controller (cluster.mjs) stores each node's settings and sends the effective policy in
// `welcome` and `node.policy`; the worker (worker.mjs) decides its intake from its own readings and keeps a Mac awake
// while it runs jobs. Only node built-ins, helpers.mjs and the pmset parsers in resources.mjs.
//   minBattery  new jobs on battery power only above this charge (%); null = only on AC power
//   keepAwake   while jobs run, `caffeinate -i -w <worker pid>`: 'ac' (only on AC power), 'always' or 'never'
//   thermal     no new jobs at this thermal pressure or worse: 'moderate', 'heavy' or 'off'
//   reserveGB   RAM a new job must leave free for the machine's owner (a Mac: 3 GB; elsewhere 0 = only the claim floor)
// Its task cap is the node's max tasks (nodes.max_slots, sent as maxTasks): Auto = cores − 1 on a Mac, all cores elsewhere.
import fs from 'node:fs';
import { helperOut, killGroup, spawnHelper } from './helpers.mjs';
import { parseBattery, parseThermal } from './resources.mjs';

export const KEEP_AWAKE = ['ac', 'always', 'never'];
export const THERMAL = ['moderate', 'heavy', 'off'];
// macOS thermal pressure levels (kOSThermalPressureLevel*, <libkern/OSThermalNotification.h>), mildest first.
export const PRESSURE = ['nominal', 'moderate', 'heavy', 'trapping', 'sleeping'];
export const PRESSURE_KEY = 'com.apple.system.thermalpressurelevel';
const GB = 1024 ** 3;

export const policyDefaults = (os) => ({ minBattery: 50, keepAwake: 'ac', thermal: 'heavy', reserveGB: os === 'darwin' ? 3 : 0 });
// The owner's settings over the defaults for the node's OS (stored = only what the owner changed; null = none).
export const effectivePolicy = (os, stored) => ({ ...policyDefaults(os), ...(stored || {}) });
// Auto task cap: a Mac keeps one core for its owner.
export const autoTasks = (os, cores) => Math.max(1, os === 'darwin' ? (cores || 1) - 1 : cores || 1);
export const reserveBytes = (policy) => Math.round((policy?.reserveGB || 0) * GB);

// An owner's edit (PATCH /api/cluster/nodes/:id {policy}): only the keys given. {value} or {error}.
export function checkPolicy(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'policy must be an object, or null for the defaults' };
  for (const [k, v] of Object.entries(patch)) {
    const bad = k === 'minBattery' ? v !== null && !(Number.isInteger(v) && v >= 0 && v <= 100) && 'minBattery must be null (AC power only) or 0-100'
      : k === 'keepAwake' ? !KEEP_AWAKE.includes(v) && `keepAwake must be one of ${KEEP_AWAKE.join(', ')}`
        : k === 'thermal' ? !THERMAL.includes(v) && `thermal must be one of ${THERMAL.join(', ')}`
          : k === 'reserveGB' ? !(typeof v === 'number' && v >= 0 && v <= 256) && 'reserveGB must be a number 0-256'
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
// Whether the machine takes new jobs now: {ok: true} or {ok: false, reason: 'battery' | 'thermal', text}. Jobs already
// running go on either way. No reading (a Mac mini has no battery, a VPS neither) never blocks.
export function intake(policy, power) {
  const p = { ...policyDefaults(), ...policy }, b = power?.battery;
  if (onBattery(power) && Number.isFinite(b.pct)) {
    if (p.minBattery == null) return { ok: false, reason: 'battery', text: `On battery (${b.pct}%): takes new tasks only on AC power` };
    if (b.pct <= p.minBattery) return { ok: false, reason: 'battery', text: `On battery at ${b.pct}%: takes new tasks above ${p.minBattery}%` };
  }
  const level = thermalLevel(power?.thermal);
  if (p.thermal !== 'off' && level && PRESSURE.indexOf(level) >= PRESSURE.indexOf(p.thermal)) {
    return { ok: false, reason: 'thermal', text: `Running hot (${level} thermal pressure): takes new tasks once it cools down` };
  }
  return { ok: true };
}
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
