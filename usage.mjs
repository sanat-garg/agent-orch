// Usage history: an append-only log at <DATA>/metrics/usage.jsonl, one JSON record per line (t = epoch ms,
// resetsAt = epoch s or null), kept for 30 days:
//   {t, agent, kind:'window', window, pct, resetsAt}           a plan window reading (dedupe: unchanged within 5 min);
//     claude: five_hour/seven_day/…, codex: 5h/weekly (from window_minutes), antigravity: <group>-5h/<group>-weekly
//   {t, agent, kind:'tokens', input, output, cached, source, ref}  one chat turn ('chat', ref = convo id) or run ('task', ref = task id)
//   {t, agent, kind:'limit', status:'hit'|'cleared', resetsAt, window?}
// `input` is uncached input (Claude: input + cache writes; codex/agy report input including the cached part).

import fs from 'node:fs';
import path from 'node:path';

export const KEEP_MS = 30 * 86400e3;
export const DEDUPE_MS = 5 * 60e3;
export const MAX_POINTS = 300;
export const RANGES = { '6h': { ms: 6 * 3600e3, bucket: 15 * 60e3 }, '24h': { ms: 86400e3, bucket: 3600e3 }, '7d': { ms: 7 * 86400e3, bucket: 86400e3 }, '30d': { ms: 30 * 86400e3, bucket: 86400e3 } };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Epoch seconds from an ISO string, epoch s or epoch ms.
export function toEpochSec(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : /^\d+(\.\d+)?$/.test(String(v)) ? Number(v) : Date.parse(v) / 1000;
  if (!Number.isFinite(n)) return null;
  return n > 1e12 ? Math.round(n / 1000) : Math.round(n);
}

// A result's usage in one shape for every adapter.
export function normUsage(agent, u = {}) {
  u = u || {};
  if (agent === 'claude' || u.cache_read_input_tokens != null) {
    return { input: num(u.input_tokens) + num(u.cache_creation_input_tokens), output: num(u.output_tokens), cached: num(u.cache_read_input_tokens) };
  }
  const cached = num(u.cached_input_tokens ?? u.cache_read_tokens ?? u.cached);
  return { input: Math.max(0, num(u.input_tokens) - cached), output: num(u.output_tokens), cached };
}

export function readRecords(file, since = 0) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r && r.t >= since) out.push(r); } catch {}
  }
  return out;
}

export function createUsageLog(dataDir, { now = Date.now } = {}) {
  const file = path.join(dataDir, 'metrics', 'usage.jsonl');
  let state = null; // agent/window -> last window record; agent -> last limit record
  const load = () => {
    if (state) return state;
    state = { windows: new Map(), limits: new Map() };
    for (const r of readRecords(file)) note(r);
    return state;
  };
  const note = (r) => {
    if (r.kind === 'window') state.windows.set(`${r.agent}\n${r.window}`, r);
    else if (r.kind === 'limit') state.limits.set(r.agent, r);
  };
  const append = (r) => {
    load();
    const rec = { t: now(), ...r };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    } catch (e) { console.error('[usage] append failed', e); return null; }
    note(rec);
    return rec;
  };

  return {
    file,
    window(agent, window, pct, resetsAt) {
      if (pct == null || !Number.isFinite(Number(pct))) return null;
      const r = { agent, kind: 'window', window, pct: Number(pct), resetsAt: toEpochSec(resetsAt) };
      const last = load().windows.get(`${agent}\n${window}`);
      if (last && last.pct === r.pct && last.resetsAt === r.resetsAt && now() - last.t < DEDUPE_MS) return null;
      return append(r);
    },
    // The latest reading of each of an agent's plan windows whose reset (if known) is still ahead: [{window, pct, resetsAt}].
    current(agent) {
      const out = [];
      for (const r of load().windows.values()) if (r.agent === agent && (r.resetsAt == null || r.resetsAt * 1000 > now())) out.push({ window: r.window, pct: r.pct, resetsAt: r.resetsAt });
      return out;
    },
    // An adapter's res.windows ([{window, pct, resetsAt}], e.g. codex '5h'/'weekly', agy 'gemini-5h').
    windows(agent, list) { return (list || []).map((w) => this.window(agent, w.window, w.pct, w.resetsAt)).filter(Boolean); },
    tokens(agent, usage, source, ref) {
      const u = normUsage(agent, usage);
      if (!u.input && !u.output && !u.cached) return null;
      return append({ agent, kind: 'tokens', ...u, source, ref: ref ?? null });
    },
    // A repeated hit with the same reset is skipped; 'cleared' is only written while the agent is marked hit.
    limitHit(agent, resetsAt, window) {
      const last = load().limits.get(agent), at = toEpochSec(resetsAt);
      if (last?.status === 'hit' && last.resetsAt === at) return null;
      return append({ agent, kind: 'limit', status: 'hit', resetsAt: at, ...(window && { window }) });
    },
    limitCleared(agent) {
      const last = load().limits.get(agent);
      if (last?.status !== 'hit') return null;
      return append({ agent, kind: 'limit', status: 'cleared', resetsAt: last.resetsAt, ...(last.window && { window: last.window }) });
    },
    // Drops records older than 30 days (and unparseable lines); run on startup.
    compact() {
      const cutoff = now() - KEEP_MS;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
      const lines = text.split('\n').filter(Boolean);
      const keep = lines.filter((l) => { try { return JSON.parse(l).t >= cutoff; } catch { return false; } });
      if (keep.length === lines.length) return 0;
      fs.writeFileSync(file + '.tmp', keep.map((l) => l + '\n').join(''));
      fs.renameSync(file + '.tmp', file);
      state = null;
      return lines.length - keep.length;
    },
    history(range) { return usageHistory(readRecords(file, now() - KEEP_MS), range, now()); },
  };
}

// Keeps at most `max` points, evenly spaced, always including the first and last.
export function downsample(points, max = MAX_POINTS) {
  if (points.length <= max) return points;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  return out;
}

// Token totals per bucket (bucket start, epoch ms), including empty buckets, oldest first.
export function bucketTokens(records, from, to, size) {
  const start = Math.floor(from / size) * size;
  const buckets = [];
  for (let b = start; b <= to; b += size) buckets.push({ t: b, input: 0, output: 0, cached: 0, turns: 0 });
  for (const r of records) {
    if (r.kind !== 'tokens' || r.t < from || r.t > to) continue;
    const b = buckets[Math.floor((r.t - start) / size)];
    if (!b) continue;
    b.input += num(r.input); b.output += num(r.output); b.cached += num(r.cached); b.turns++;
  }
  return buckets;
}

// The /api/usage/history payload: per agent, window series, token buckets, limit events and current status.
export function usageHistory(records, rangeKey, at = Date.now()) {
  const range = RANGES[rangeKey] ? rangeKey : '24h';
  const { ms, bucket } = RANGES[range];
  const from = at - ms;
  const agents = {};
  const of = (id) => (agents[id] ||= { windows: {}, tokens: [], limits: [], status: { windows: {}, blocked: false, resetsAt: null } });
  const byAgent = new Map();
  for (const r of records) {
    if (!r?.agent || !Number.isFinite(r.t)) continue;
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, []);
    byAgent.get(r.agent).push(r);
  }
  for (const [id, recs] of byAgent) {
    recs.sort((a, b) => a.t - b.t);
    const a = of(id);
    let lastLimit = null;
    for (const r of recs) {
      if (r.kind === 'window') {
        a.status.windows[r.window] = { pct: r.pct, resetsAt: r.resetsAt ?? null, t: r.t };
        if (r.t >= from) (a.windows[r.window] ||= []).push({ t: r.t, pct: r.pct, resetsAt: r.resetsAt ?? null });
      } else if (r.kind === 'limit') {
        lastLimit = r;
        if (r.t >= from) a.limits.push({ t: r.t, status: r.status, resetsAt: r.resetsAt ?? null, ...(r.window && { window: r.window }) });
      }
    }
    for (const w of Object.keys(a.windows)) a.windows[w] = downsample(a.windows[w]);
    a.tokens = bucketTokens(recs, from, at, bucket);
    // Blocked while the latest limit event is a hit whose reset (if known) is still ahead.
    if (lastLimit?.status === 'hit' && (lastLimit.resetsAt == null || lastLimit.resetsAt * 1000 > at)) {
      a.status.blocked = true;
      a.status.resetsAt = lastLimit.resetsAt ?? null;
    }
  }
  return { range, from, to: at, bucketMs: bucket, agents };
}
