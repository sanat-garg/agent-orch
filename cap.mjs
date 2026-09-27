// A worker machine's local contribution cap (BRIEF goal 11; .agent-orch/CLUSTER.md "Local cap"): how much CPU and RAM
// the machine lends the cluster. It is the ONE setting made on a worker itself (`node worker.mjs limit …`), saved in its
// config.json as typed ({cpu: 4 | '50%', mem: 8 (GB) | '50%', maxTasks, onlyOnAc}) and reported resolved for the
// machine ({cpu: cores, mem: bytes, maxTasks, onlyOnAc}; null = no cap) in its inventory and every resources frame. The
// head treats it as a hard ceiling (capSlots in orchestrator nodeCap) and the worker enforces it too (capRejection on
// job.offer, worker-cap.mjs for the processes). Shared by both sides, so no deps.

export const GB = 1024 ** 3;
// An agent run's memory (the scheduler's footprint per agent; a constant until each agent's p90 is measured) and the
// cores a task counts against a CPU cap (until each agent's CPU is measured).
export const FOOTPRINT = { claude: 1.2 * GB, codex: 0.8 * GB };
export const CPU_PER_TASK = 1;

const NUM = /^(\d+(?:\.\d+)?)$/, PCT = /^(\d+(?:\.\d+)?)\s*%$/, MEM = /^(\d+(?:\.\d+)?)\s*(?:g|gb|gib)?$/i, OFF = /^(off|none|no)$/i;
const round2 = (n) => Math.round(n * 100) / 100;
export const fmtGB = (b) => (b > 0 && b < 0.95 * GB ? `${Math.round(b / 1024 ** 2)} MB` : `${+(b / GB).toFixed(1)} GB`);
export const fmtCores = (n) => `${+Number(n).toFixed(2)} ${n === 1 ? 'core' : 'cores'}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Each option as typed → {value} (null removes it) or {error}. machine: {cores, memTotal (bytes)}.
export function parseCpu(s, { cores }) {
  const v = String(s ?? '').trim();
  if (OFF.test(v)) return { value: null };
  const p = PCT.exec(v), n = NUM.exec(v);
  if (p) return Number(p[1]) > 0 && Number(p[1]) <= 100 ? { value: `${Number(p[1])}%` } : { error: '--cpu takes a share of this machine\'s cores up to 100%' };
  if (!n || !(Number(n[1]) > 0)) return { error: `--cpu takes cores (4, 2.5) or a share of this machine's ${cores} cores (50%), or off` };
  if (Number(n[1]) > cores) return { error: `--cpu ${n[1]}: this machine has ${plural(cores, 'core')}` };
  return { value: Number(n[1]) };
}
export function parseMem(s, { memTotal }) {
  const v = String(s ?? '').trim();
  if (OFF.test(v)) return { value: null };
  const p = PCT.exec(v), n = MEM.exec(v);
  if (p) return Number(p[1]) > 0 && Number(p[1]) <= 100 ? { value: `${Number(p[1])}%` } : { error: '--mem takes a share of this machine\'s RAM up to 100%' };
  if (!n || !(Number(n[1]) > 0)) return { error: `--mem takes GB (8, 7.5) or a share of this machine's ${fmtGB(memTotal)} (50%), or off` };
  if (Number(n[1]) * GB > memTotal) return { error: `--mem ${n[1]} GB: this machine has ${fmtGB(memTotal)} of RAM` };
  return { value: Number(n[1]) };
}
export function parseMaxTasks(s) {
  const v = String(s ?? '').trim();
  if (OFF.test(v)) return { value: null };
  return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 64 ? { value: Number(v) } : { error: '--max-tasks takes a whole number from 1 to 64, or off' };
}
export function parseSwitch(s, name) {
  if (s === true || s === undefined) return { value: true };
  const v = String(s).trim().toLowerCase();
  if (['on', 'yes', 'true'].includes(v)) return { value: true };
  if (['off', 'no', 'false'].includes(v)) return { value: null };
  return { error: `--${name} takes no value, or on/off` };
}

// `limit` options over the saved cap (only the ones given change) → {cap: the new saved cap, null when nothing is left}
// or {error}. opts: {cpu, mem, maxTasks, onlyOnAc} as typed.
export function applyLimit(stored, opts, machine) {
  const next = { ...(stored && typeof stored === 'object' ? stored : {}) };
  delete next.at;
  const parsers = { cpu: (v) => parseCpu(v, machine), mem: (v) => parseMem(v, machine), maxTasks: parseMaxTasks, onlyOnAc: (v) => parseSwitch(v, 'only-on-ac') };
  for (const [k, parse] of Object.entries(parsers)) {
    if (!(k in opts)) continue;
    const r = parse(opts[k]);
    if (r.error) return { error: r.error };
    if (r.value == null) delete next[k]; else next[k] = r.value;
  }
  return { cap: Object.keys(next).length ? { ...next, at: Date.now() } : null };
}

// The saved cap for this machine → {cpu: cores | null, mem: bytes | null, maxTasks: n | null, onlyOnAc: bool}, or null
// when nothing is capped. A share is of the machine's cores / RAM; values it doesn't understand (a hand edit) count as unset.
export function resolveCap(stored, { cores, memTotal }) {
  if (!stored || typeof stored !== 'object') return null;
  const part = (v, total) => {
    const p = typeof v === 'string' ? PCT.exec(v) : null;
    const n = p ? total * Number(p[1]) / 100 : typeof v === 'number' ? v : NaN;
    return n > 0 ? Math.min(n, total) : null;
  };
  const cpu = part(stored.cpu, cores), memGB = typeof stored.mem === 'number' ? part(stored.mem * GB, memTotal) : part(stored.mem, memTotal);
  const cap = {
    cpu: cpu == null ? null : round2(cpu), mem: memGB == null ? null : Math.round(memGB),
    maxTasks: Number.isInteger(stored.maxTasks) && stored.maxTasks >= 1 ? stored.maxTasks : null, onlyOnAc: stored.onlyOnAc === true,
  };
  return cap.cpu == null && cap.mem == null && cap.maxTasks == null && !cap.onlyOnAc ? null : cap;
}

// A reported cap, checked (the head reads it from a worker): numbers where numbers belong, else unset.
export function cleanCap(c) {
  if (!c || typeof c !== 'object') return null;
  const pos = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const cap = { cpu: pos(c.cpu), mem: pos(c.mem), maxTasks: Number.isInteger(c.maxTasks) && c.maxTasks >= 1 ? c.maxTasks : null, onlyOnAc: c.onlyOnAc === true };
  return cap.cpu == null && cap.mem == null && cap.maxTasks == null && !cap.onlyOnAc ? null : cap;
}
// The cap a node reported: its latest resources frame (cap: null = none), else its inventory (a worker without the field
// has none).
export function localCap(n) {
  const r = n?.resources;
  return cleanCap(r && 'cap' in r ? r.cap : n?.inventory?.cap);
}

// '4 cores · 8 GB · at most 3 tasks · on AC power only' (machine: its totals, shown for a part that isn't capped).
export function capText(cap, machine = null) {
  if (!cap) return 'no local cap';
  const cpu = cap.cpu ?? machine?.cores, mem = cap.mem ?? machine?.memTotal;
  return [cpu != null && fmtCores(cpu), mem != null && fmtGB(mem), cap.maxTasks != null && `at most ${plural(cap.maxTasks, 'task')}`,
    cap.onlyOnAc && 'on AC power only'].filter(Boolean).join(' · ');
}

// Tasks the cap allows by count: its max tasks, and its CPU at cpuPerTask cores each.
export const capTasks = (cap, cpuPerTask = CPU_PER_TASK) => Math.min(cap?.maxTasks ?? Infinity,
  cap?.cpu != null ? Math.floor(cap.cpu / cpuPerTask + 1e-9) : Infinity);

// The head's ceiling for a node under its local cap (Infinity without one): its max tasks, its CPU cap at cpuPerTask
// cores a task, and its running jobs plus what fits in the rest of its RAM cap (cap − jobsMem, the memory its jobs use)
// at `footprint` a task.
export function capSlots(cap, { runs = 0, jobsMem = 0, footprint = FOOTPRINT.claude, cpuPerTask = CPU_PER_TASK } = {}) {
  if (!cap) return Infinity;
  let n = capTasks(cap, cpuPerTask);
  if (cap.mem != null) n = Math.min(n, runs + Math.max(0, Math.floor((cap.mem - jobsMem) / footprint)));
  return n;
}

// The worker's own check before it accepts a job: why taking one more (`footprint` bytes) would go over the cap, as
// {kind: 'tasks' | 'memory', text}, or null. jobs: its jobs that aren't paused; jobsMem: what they use now.
export function capRejection(cap, { jobs = 0, jobsMem = 0, footprint = FOOTPRINT.claude, cpuPerTask = CPU_PER_TASK } = {}) {
  if (!cap) return null;
  const tasks = capTasks(cap, cpuPerTask);
  if (jobs + 1 > tasks) {
    const why = cap.maxTasks != null && cap.maxTasks === tasks ? 'max tasks' : `${fmtCores(cap.cpu)} at ${fmtCores(cpuPerTask)} a task`;
    return { kind: 'tasks', text: `the local cap allows ${plural(tasks, 'task')} (${why}) and ${plural(jobs, 'job')} ${jobs === 1 ? 'runs' : 'run'}` };
  }
  if (cap.mem != null && jobsMem + footprint > cap.mem) {
    return { kind: 'memory', text: `its jobs use ${fmtGB(jobsMem)} of the local ${fmtGB(cap.mem)} RAM cap and one more needs about ${fmtGB(footprint)}` };
  }
  return null;
}
