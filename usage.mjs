// Usage history: an append-only log at <DATA>/metrics/usage.jsonl, one JSON record per line (t = epoch ms,
// resetsAt = epoch s or null), kept for 30 days:
//   {t, agent, kind:'window', window, pct, resetsAt, at?}      a plan window reading (dedupe: unchanged within 5 min);
//     claude: five_hour/seven_day/…, codex: 5h/weekly (from window_minutes), antigravity: <group>-5h/<group>-weekly;
//     OpenCode currently exposes per-turn tokens but no live subscription windows or reset times.
//     at = when the reading was taken (epoch ms) if earlier than t, e.g. a polled codex rollout snapshot
//   {t, agent, kind:'tokens', input, output, cached, premiumRequests?, source, ref}  one chat turn or task run
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
  // agy reports cache reads beside input (total_tokens = input + output; live runs read more cached than input);
  // codex's cached_input_tokens are part of input_tokens.
  if (agent === 'antigravity') return { input: num(u.input_tokens), output: num(u.output_tokens), cached: num(u.cache_read_tokens) };
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

const limitId = (agent, group) => (group ? `${agent}\n${group}` : agent);

export function createUsageLog(dataDir, { now = Date.now } = {}) {
  const file = path.join(dataDir, 'metrics', 'usage.jsonl');
  let state = null; // agent/window -> last window record; agent(/group) -> last limit record
  const load = () => {
    if (state) return state;
    state = { windows: new Map(), limits: new Map() };
    for (const r of readRecords(file)) note(r);
    return state;
  };
  const note = (r) => {
    if (r.kind === 'window') state.windows.set(`${r.agent}\n${r.window}`, r);
    else if (r.kind === 'limit') state.limits.set(limitId(r.agent, r.group), r);
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
    window(agent, window, pct, resetsAt, at) {
      if (pct == null || !Number.isFinite(Number(pct))) return null;
      const r = { agent, kind: 'window', window, pct: Number(pct), resetsAt: toEpochSec(resetsAt), ...(Number.isFinite(at) && at < now() && { at: Math.round(at) }) };
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
      const premiumRequests = agent === 'copilot' && Number.isFinite(Number(usage?.premiumRequests)) ? Number(usage.premiumRequests) : null;
      if (!u.input && !u.output && !u.cached && !premiumRequests) return null;
      return append({ agent, kind: 'tokens', ...u, ...(premiumRequests != null && { premiumRequests }), source, ref: ref ?? null });
    },
    // A repeated hit with the same reset is skipped; 'cleared' is only written while the agent is marked hit.
    // `group` (antigravity's 'gemini'/'3p') keeps each model group's limit separate.
    limitHit(agent, resetsAt, window, group) {
      const last = load().limits.get(limitId(agent, group)), at = toEpochSec(resetsAt);
      if (last?.status === 'hit' && last.resetsAt === at) return null;
      return append({ agent, kind: 'limit', status: 'hit', resetsAt: at, ...(window && { window }), ...(group && { group }) });
    },
    lastLimit(agent, group) { return load().limits.get(limitId(agent, group)) || null; },
    limitCleared(agent, group) {
      const last = load().limits.get(limitId(agent, group));
      if (last?.status !== 'hit') return null;
      return append({ agent, kind: 'limit', status: 'cleared', resetsAt: last.resetsAt, ...(last.window && { window: last.window }), ...(group && { group }) });
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
  for (let b = start; b <= to; b += size) buckets.push({ t: b, input: 0, output: 0, cached: 0, premiumRequests: 0, turns: 0 });
  for (const r of records) {
    if (r.kind !== 'tokens' || r.t < from || r.t > to) continue;
    const b = buckets[Math.floor((r.t - start) / size)];
    if (!b) continue;
    b.input += num(r.input); b.output += num(r.output); b.cached += num(r.cached); b.premiumRequests += num(r.premiumRequests); b.turns++;
  }
  return buckets;
}

// Window lengths by name, for staleness (a reading older than its window says nothing about the current one).
const WINDOW_MS = { '5h': 5 * 3600e3, five_hour: 5 * 3600e3, weekly: 7 * 86400e3, seven_day: 7 * 86400e3 };
const windowMs = (w) => WINDOW_MS[w] ?? (/(?:^|-)5h$/.test(w) ? 5 * 3600e3 : /weekly$/.test(w) ? 7 * 86400e3 : null);

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
    const lastLimit = new Map(); // group ('' for the whole agent) -> latest limit record
    for (const r of recs) {
      if (r.kind === 'window') {
        const read = r.at ?? r.t, len = windowMs(r.window);
        a.status.windows[r.window] = { pct: r.pct, resetsAt: r.resetsAt ?? null, t: read,
          stale: (r.resetsAt != null && r.resetsAt * 1000 <= at) || (len != null && at - read > len) };
        if (r.t >= from) (a.windows[r.window] ||= []).push({ t: r.t, pct: r.pct, resetsAt: r.resetsAt ?? null });
      } else if (r.kind === 'limit') {
        lastLimit.set(r.group || '', r);
        if (r.t >= from) a.limits.push({ t: r.t, status: r.status, resetsAt: r.resetsAt ?? null, ...(r.window && { window: r.window }), ...(r.group && { group: r.group }) });
      }
    }
    for (const w of Object.keys(a.windows)) a.windows[w] = downsample(a.windows[w]);
    a.tokens = bucketTokens(recs, from, at, bucket);
    // Blocked while the latest limit event (per group) is a hit whose reset (if known) is still ahead.
    // status.groups: antigravity's blocked groups → resetsAt; blocked/resetsAt cover any of them.
    for (const [g, l] of lastLimit) {
      if (l.status !== 'hit' || (l.resetsAt != null && l.resetsAt * 1000 <= at)) continue;
      a.status.blocked = true;
      a.status.resetsAt = Math.max(a.status.resetsAt ?? 0, l.resetsAt ?? 0) || null;
      if (g) (a.status.groups ||= {})[g] = l.resetsAt ?? null;
    }
  }
  return { range, from, to: at, bucketMs: bucket, agents };
}

// Plan-limit checks per agent (agents.mjs `fetchLimits`), for the health view: <DATA>/limits.json keeps each agent's
// {source, exposed, windows, error, at (last successful reading), checkedAt}; readings also go to the usage log.
// Refreshed on start, every 6 h, after a sign-in change and from the Connections modal's Refresh; `note` takes a
// reading made elsewhere (the server's 3-minute Claude poll). fetch(id) is injectable for tests.
export const LIMITS_TTL = 6 * 3600e3;
export function createLimitStore({ file, ids, fetch, usageLog = null, intervalMs = LIMITS_TTL, onChange = () => {}, log = () => {}, now = Date.now }) {
  const status = new Map(), inflight = new Map();
  let timer = null;
  try { for (const [id, e] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')).agents || {})) if (ids.includes(id)) status.set(id, e); } catch {}
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ saved: now(), agents: Object.fromEntries(status) }, null, 1));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) { log(`could not save ${file}: ${e.message}`); }
  };
  // A failed check keeps the last good windows and their time, so "last successful fetch" stays meaningful.
  function set(id, r) {
    const prev = status.get(id);
    const ok = !r.error;
    status.set(id, { source: r.source ?? prev?.source ?? null, exposed: r.exposed ?? prev?.exposed ?? true,
      windows: ok ? r.windows || [] : prev?.windows || [], error: r.error || null, at: ok ? r.at ?? now() : prev?.at ?? null, checkedAt: now() });
    if (ok && usageLog) for (const w of r.windows || []) usageLog.window(id, w.window, w.pct, w.resetsAt, r.at ?? undefined);
  }
  async function refresh(only = ids) {
    const want = only.filter((id) => ids.includes(id));
    await Promise.all(want.map((id) => {
      if (!inflight.has(id)) {
        inflight.set(id, (async () => {
          let r;
          try { r = await fetch(id); } catch (e) { r = { error: String(e?.message || e) }; }
          set(id, r);
          if (r.error) log(`${id}: no limits (${r.error})`);
        })().finally(() => inflight.delete(id)));
      }
      return inflight.get(id);
    }));
    save();
    try { onChange(want); } catch {}
  }
  return {
    refresh,
    note(id, r) { if (!ids.includes(id)) return; set(id, { ...status.get(id), ...r, error: null }); save(); },
    get: (id) => status.get(id) || null,
    start() { const p = refresh(); timer = setInterval(() => refresh().catch(() => {}), intervalMs); timer.unref?.(); return p; },
    stop: () => clearInterval(timer),
  };
}
