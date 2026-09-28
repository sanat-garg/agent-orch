// Placement (BRIEF goal 9, PLACEMENT RULE): which machine runs the next task. Every online machine counts; RAM, battery,
// AC power and heat never do. CPU is the only gate, and only when it is genuinely saturated for a minute: Linux PSI
// `cpu some avg60` over 90%, else (macOS, or no PSI) the 1-min load average over 2.5 × cores. Among the eligible nodes the
// scheduler (orchestrator.mjs place) takes the lowest (running + 1) / effective cores, ties round-robin, so every machine gets work.
// A node's slot target is its cores, at least MIN_SLOTS (agents mostly wait on the LLM, so a 1-core VPS runs 4); the
// owner's caps (nodes.max_slots, `node worker.mjs limit`) stay optional ceilings. Pure, no deps: the worker uses it too.

export const PSI_SATURATED = 90;   // % of the last 60 s some task waited for a CPU (/proc/pressure/cpu some avg60)
export const LOAD_SATURATED = 2.5; // 1-min load average per core
export const MIN_SLOTS = 4;

export const slotTarget = (cores) => Math.max(MIN_SLOTS, Number.isInteger(cores) && cores > 0 ? cores : 1);

// `/proc/pressure/cpu` ("some avg10=1.00 avg60=2.50 avg300=0.10 total=123") → avg60, or null.
export function parsePsi(text) {
  const m = /^some\s.*\bavg60=([\d.]+)/m.exec(text || '');
  return m ? Number(m[1]) : null;
}

// A node's CPU from its latest reading (res.psi: PSI some avg60; res.load: [1, 5, 15 min]): {saturated, text} ('CPU
// saturated (load 22/8)'), or null without a usable reading (never a reason to skip it).
export function cpuState(res, cores) {
  const r1 = (v) => Math.round(v * 10) / 10;
  if (Number.isFinite(res?.psi)) return { saturated: res.psi > PSI_SATURATED, text: `CPU pressure ${r1(res.psi)}% over 60 s` };
  const load = Number(res?.load?.[0]);
  if (!Number.isFinite(load) || !(cores > 0)) return null;
  return { saturated: load > LOAD_SATURATED * cores, text: `load ${r1(load)}/${cores}` };
}

// The next node from eligible, not full candidates [{id, running, cores, slots}]: the lowest (running + 1) / effective cores (compared
// exactly, as cross products; cores are slotTarget(physical cores), independent of owner ceilings), ties to the one picked least recently (picked: id → sequence number of its last pick),
// then list order. null when there are none.
export function pickNode(cands, picked = new Map()) {
  let best = null;
  for (const c of cands) {
    if (!best) { best = c; continue; }
    const d = (c.running + 1) * (best.cores ?? best.slots) - (best.running + 1) * (c.cores ?? c.slots);
    if (d < 0 || (d === 0 && (picked.get(c.id) ?? -1) < (picked.get(best.id) ?? -1))) best = c;
  }
  return best;
}
