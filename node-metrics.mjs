// Worker health telemetry as a rolling 24 h time series per node (BRIEF goal 11): <DATA>/metrics/nodes/<id>.jsonl, one
// compact sample per line, appended for every `resources` frame (~10 s). Compaction keeps the last hour at full
// resolution, averages older samples into 5-minute buckets and drops anything past 24 h; it runs on the first write after
// a start and then every 10 minutes, so a file stays around 650 lines.
import fs from 'node:fs';
import path from 'node:path';

export const METRICS = { keepMs: 24 * 3600e3, fullMs: 3600e3, bucketMs: 5 * 60e3, compactEveryMs: 10 * 60e3 };
export const RANGES = { '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 };
const SAFE_ID = /^[\w-]{1,64}$/;
const num = (v) => (Number.isFinite(v) ? v : undefined);
const r1 = (v) => (v == null ? v : Math.round(v * 10) / 10);

// A telemetry frame → the stored sample: t (ms), cpu (mean % of all cores), cores (% per core), load (1 min), mem
// (MemAvailable bytes), swap (% used), disk (free bytes), net (1 reachable, 0 not), netMs, jobs (running), bat (%),
// chg (1 charging), therm (CPU speed limit %). Missing readings are left out.
export function sampleOf(res = {}, t = Date.now()) {
  const cores = Array.isArray(res.cpu) ? res.cpu.map((c) => r1(num(c) ?? 0)) : undefined;
  const s = {
    t, cpu: cores?.length ? r1(cores.reduce((a, c) => a + c, 0) / cores.length) : undefined, cores: cores?.length ? cores : undefined,
    load: r1(num(res.load?.[0])), mem: num(res.memAvailable), swap: r1(num(res.swapUsedPct)), disk: num(res.disk?.free),
    net: typeof res.net?.ok === 'boolean' ? Number(res.net.ok) : undefined, netMs: num(res.net?.ms),
    jobs: Array.isArray(res.running) ? res.running.length : undefined, bat: num(res.battery?.pct),
    chg: typeof res.battery?.charging === 'boolean' ? Number(res.battery.charging) : undefined, therm: num(res.thermal?.speedLimit),
  };
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
}

// Folds samples into one stamped `t` (a bucket's start), weighted by how many each already holds (n): readings average,
// except disk and net (the worst: minimum) and jobs (the most: maximum).
function merge(rows, t) {
  const w = (r) => r.n || 1, n = rows.reduce((a, r) => a + w(r), 0);
  const avg = (k) => {
    const xs = rows.filter((r) => Number.isFinite(r[k]));
    return xs.length ? xs.reduce((a, r) => a + r[k] * w(r), 0) / xs.reduce((a, r) => a + w(r), 0) : undefined;
  };
  const pick = (k, f) => { const xs = rows.map((r) => r[k]).filter(Number.isFinite); return xs.length ? f(...xs) : undefined; };
  const width = Math.max(0, ...rows.map((r) => r.cores?.length || 0));
  const cores = width ? Array.from({ length: width }, (_, i) => {
    const xs = rows.filter((r) => Number.isFinite(r.cores?.[i]));
    return r1(xs.reduce((a, r) => a + r.cores[i] * w(r), 0) / (xs.reduce((a, r) => a + w(r), 0) || 1));
  }) : undefined;
  const round = (v) => (v == null ? v : Math.round(v));
  const s = { t, n, cpu: r1(avg('cpu')), cores, load: r1(avg('load')), mem: round(avg('mem')), swap: r1(avg('swap')), disk: pick('disk', Math.min),
    net: pick('net', Math.min), netMs: round(avg('netMs')), jobs: pick('jobs', Math.max), bat: r1(avg('bat')), chg: pick('chg', Math.max), therm: pick('therm', Math.min) };
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
}

// The compaction policy: samples older than keepMs go, those older than fullMs share one bucketMs-wide sample per bucket.
// Idempotent: a bucket already folded (t = its start) folds into itself.
export function compactSamples(samples, now = Date.now(), { keepMs, fullMs, bucketMs } = METRICS) {
  const out = [], buckets = new Map();
  for (const s of samples) {
    if (!s || !Number.isFinite(s.t) || s.t < now - keepMs) continue;
    if (s.t >= now - fullMs) { out.push(s); continue; }
    const b = Math.floor(s.t / bucketMs) * bucketMs;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(s);
  }
  for (const [b, rows] of buckets) out.push(rows.length === 1 && rows[0].t === b && rows[0].n ? rows[0] : merge(rows, b));
  return out.sort((a, b) => a.t - b.t);
}

// dir: <DATA>/metrics/nodes. record(id, frame) stores one telemetry frame; series(id, range) reads a range ('1h' or ms).
export function createNodeMetrics({ dir, opts = METRICS, log = () => {} }) {
  const compacted = new Map(); // node id -> when its file was last compacted
  const file = (id) => path.join(dir, `${id}.jsonl`);
  function read(id) {
    if (!SAFE_ID.test(id)) return [];
    let text = '';
    try { text = fs.readFileSync(file(id), 'utf8'); } catch { return []; }
    return text.split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
  }
  function compact(id, now = Date.now()) {
    if (!SAFE_ID.test(id)) return;
    compacted.set(id, now);
    const rows = compactSamples(read(id), now, opts), f = file(id);
    try {
      fs.writeFileSync(`${f}.tmp`, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
      fs.renameSync(`${f}.tmp`, f);
    } catch (e) { log(`metrics compaction for ${id} failed: ${e.message}`); }
  }
  function record(id, frame, t = Date.now()) {
    if (!SAFE_ID.test(id)) return null;
    const s = sampleOf(frame, t);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file(id), JSON.stringify(s) + '\n');
    } catch (e) { log(`metrics for ${id} not written: ${e.message}`); return null; }
    if (t - (compacted.get(id) || 0) >= opts.compactEveryMs) compact(id, t);
    return s;
  }
  // range: a RANGES key ('15m', '1h', '6h', '24h') or milliseconds; unknown → 1h.
  function series(id, range = '1h', now = Date.now()) {
    const ms = typeof range === 'number' ? Math.min(range, opts.keepMs) : RANGES[range] ?? RANGES['1h'];
    return read(id).filter((s) => s.t >= now - ms && s.t <= now + 60e3).sort((a, b) => a.t - b.t);
  }
  function remove(id) { if (SAFE_ID.test(id)) { fs.rmSync(file(id), { force: true }); compacted.delete(id); } }
  return { record, series, compact, read, remove, file };
}
