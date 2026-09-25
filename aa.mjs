// Artificial Analysis (https://artificialanalysis.ai/data-api/docs) model metrics: evaluations (Intelligence/Coding/Agentic
// indexes, Terminal-Bench, SciCode, …), speed, TTFT, context window and pricing, mapped onto the models our CLIs report.
// The API key lives in <DATA>/secrets.json (0600, never sent to the client) or AA_API_KEY. The models list is cached in
// <DATA>/aa-models.json and refetched at most every 24 h (free tier: 100 requests per fixed 24 h window; 429 → Retry-After).
// Without a key, .agent-orch/model-metrics.json (hand-maintained) is used and every entry says source 'manual'.
// Their terms require attribution wherever the data is shown: ATTRIBUTION goes into every output.
import fs from 'node:fs';
import path from 'node:path';

export const AA_BASE = 'https://artificialanalysis.ai/api/v2';
export const AA_TTL = 24 * 3600e3;
export const ATTRIBUTION = { text: 'Model metrics by Artificial Analysis', url: 'https://artificialanalysis.ai' };
const MAX_PAGES = 10;

// ---------- key storage ----------
export function createSecrets(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } };
  const write = (j) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(j, null, 1), { mode: 0o600 });
    fs.chmodSync(`${file}.tmp`, 0o600);
    fs.renameSync(`${file}.tmp`, file);
  };
  return {
    get: (k) => read()[k] || null,
    set: (k, v) => { const j = read(); if (v) j[k] = v; else delete j[k]; write(j); },
  };
}

// ---------- parsing ----------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// One API row → our shape. `benchmarks` keeps every evaluation the API returns (numbers only), so new ones show up as-is.
export function parseModel(r) {
  const ev = r.evaluations || {}, perf = r.performance || {}, pr = r.pricing || {};
  const benchmarks = {};
  for (const [k, v] of Object.entries(ev)) if (num(v) !== null && !/^artificial_analysis_\w+_index$/.test(k)) benchmarks[k] = v;
  return {
    slug: r.slug || null, name: r.name || r.slug || '', creator: r.model_creator?.name || null, release_date: r.release_date || null,
    reasoning: !!r.reasoning_model,
    intelligence_index: num(ev.artificial_analysis_intelligence_index),
    coding_index: num(ev.artificial_analysis_coding_index),
    agentic_index: num(ev.artificial_analysis_agentic_index),
    benchmarks,
    tokens_per_s: num(perf.median_output_tokens_per_second),
    ttft_s: num(perf.median_time_to_first_token_seconds),
    context_window: num(r.context_window_tokens),
    pricing: { input: num(pr.price_1m_input_tokens), output: num(pr.price_1m_output_tokens), blended: num(pr.price_1m_blended_3_to_1) },
  };
}

// Fetches every page. Rate-limit headers are returned so the caller can avoid a 429; a 429 throws with retryAfter (s).
export async function fetchModels(key, { fetch = globalThis.fetch, base = AA_BASE } = {}) {
  const rows = [];
  let tier = null, limit = null, endpoint = 'models';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const request = () => fetch(`${base}/language/${endpoint}?page=${page}`, { headers: { 'x-api-key': key, accept: 'application/json' } });
    let r = await request();
    // Free keys cannot access the full endpoint. Keep paid-tier benchmarks when available.
    if (r.status === 403 && endpoint === 'models') {
      await r.arrayBuffer?.();
      endpoint = 'models/free';
      rows.length = 0; page = 1;
      r = await request();
    }
    const h = (n) => r.headers?.get?.(n) ?? null;
    limit = { remaining: Number(h('x-ratelimit-remaining') ?? NaN), reset: Number(h('x-ratelimit-reset') ?? NaN) };
    if (r.status === 429) throw Object.assign(new Error('Artificial Analysis rate limit reached'), { status: 429, retryAfter: Number(h('retry-after')) || 3600 });
    if (r.status === 401) throw Object.assign(new Error('Artificial Analysis rejected the API key'), { status: r.status });
    if (r.status === 403) throw Object.assign(new Error('Artificial Analysis access denied for this subscription'), { status: r.status });
    if (!r.ok) throw Object.assign(new Error(`Artificial Analysis: HTTP ${r.status}`), { status: r.status });
    const j = await r.json();
    tier = j.tier ?? tier;
    if (!Array.isArray(j.data)) throw new Error('Invalid Artificial Analysis response');
    rows.push(...j.data);
    if (!j.pagination?.has_more) break;
  }
  return { models: rows.map(parseModel).filter((m) => m.slug), tier, limit };
}

// ---------- matching AA entries to CLI models ----------
const EFFORTS = ['xhigh', 'high', 'medium', 'low', 'minimal', 'max'];
const NOISE = new Set(['preview', 'thinking', 'reasoning', 'adaptive', 'latest', 'exp', 'experimental', 'effort', 'mode', 'non', 'nonreasoning', ...EFFORTS]);
// → {key, effort, nonReasoning}. Word tokens are sorted and numbers kept in order, so "claude-4-5-sonnet" and
// "Claude Sonnet 4.5" meet; dates (8 digits), effort levels and marketing suffixes are dropped.
export function normName(s) {
  const raw = String(s || '').toLowerCase().replace(/[()[\],/_.:\s]+/g, '-');
  const toks = raw.split('-').filter(Boolean);
  const effort = EFFORTS.find((e) => toks.includes(e)) || null;
  const nonReasoning = /non-?reasoning/.test(raw);
  const words = [], nums = [];
  for (const t of toks) {
    if (NOISE.has(t) || /^\d{8}$/.test(t)) continue;
    (/^\d+$/.test(t) ? nums : words).push(t);
  }
  return { key: `${[...words].sort().join(' ')}|${nums.join('.')}`, effort, nonReasoning };
}
// The CLI names to try for a model: id, the id an alias resolves to, and the label (prefixed with the family when it lacks one).
const FAMILY = { claude: 'claude', codex: 'gpt', antigravity: 'gemini' };
function cliNames(agent, m) {
  const out = [m.resolved, m.id, m.label].filter(Boolean);
  if (m.label && FAMILY[agent] && !m.label.toLowerCase().includes(FAMILY[agent])) out.push(`${FAMILY[agent]} ${m.label}`);
  return out;
}
// Among AA variants with the same key: the CLI's own effort level if named, else reasoning variants, else the best index.
function pickVariant(cands, effort) {
  const score = (c) => [effort && c.n.effort === effort ? 1 : 0, c.n.nonReasoning ? 0 : 1, c.m.intelligence_index ?? -1];
  return [...cands].sort((a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; })[0].m;
}
// catalog: {agent: [{id,label,resolved?}]}; overrides: {"agent:id" | "id": aaSlug | null}. → {matches: {agent: {id: m|null}}, unmatched}
export function matchModels(catalog, aaModels, overrides = {}) {
  const byKey = new Map(), bySlug = new Map();
  for (const m of aaModels) {
    bySlug.set(m.slug, m);
    for (const s of new Set([m.slug, m.name])) {
      const n = normName(s);
      if (!byKey.has(n.key)) byKey.set(n.key, []);
      const list = byKey.get(n.key);
      if (!list.some((c) => c.m === m)) list.push({ m, n: { ...n, effort: n.effort || normName(m.name).effort, nonReasoning: n.nonReasoning || normName(m.name).nonReasoning } });
    }
  }
  const matches = {}, unmatched = [];
  for (const [agent, models] of Object.entries(catalog)) {
    matches[agent] = {};
    for (const m of models || []) {
      const ov = [`${agent}:${m.id}`, m.id].find((k) => k in overrides);
      let hit = null;
      if (ov !== undefined) hit = overrides[ov] ? bySlug.get(overrides[ov]) || null : null;
      else {
        for (const s of cliNames(agent, m)) {
          const n = normName(s), cands = byKey.get(n.key);
          if (cands?.length) { hit = pickVariant(cands, n.effort); break; }
        }
      }
      matches[agent][m.id] = hit;
      if (!hit && !(ov !== undefined && overrides[ov] === null)) unmatched.push({ agent, model: m.id, label: m.label || m.id });
    }
  }
  return { matches, unmatched };
}

// ---------- manual fallback ----------
// .agent-orch/model-metrics.json: {models: {"agent:id" | "id": {coding_index, agentic_index, intelligence_index,
// benchmarks: {terminalbench_hard, scicode, …}, tokens_per_s, ttft_s, context_window, pricing: {input, output}}}, updated?}
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function manualRow(table, agent, id) {
  const r = table?.models?.[`${agent}:${id}`] ?? table?.models?.[id];
  if (!r) return null;
  return {
    slug: null, name: r.name || id,
    intelligence_index: num(r.intelligence_index), coding_index: num(r.coding_index), agentic_index: num(r.agentic_index),
    benchmarks: Object.fromEntries(Object.entries(r.benchmarks || {}).filter(([, v]) => num(v) !== null)),
    tokens_per_s: num(r.tokens_per_s), ttft_s: num(r.ttft_s), context_window: num(r.context_window),
    pricing: { input: num(r.pricing?.input), output: num(r.pricing?.output), blended: num(r.pricing?.blended) },
  };
}

// ---------- store ----------
const metricsOf = (m) => {
  if (!m) return null;
  const { slug, name, creator, release_date, reasoning, ...rest } = m;
  return rest;
};
// catalog() → {agent: [models]} (models.mjs lists). metaDir is the repo's .agent-orch (model-map.json, model-metrics.json).
export function createAAStore({ dataDir, metaDir, catalog, env = process.env, fetch = globalThis.fetch, base = AA_BASE, now = Date.now, ttl = AA_TTL, log = () => {} }) {
  const cacheFile = path.join(dataDir, 'aa-models.json');
  const secrets = createSecrets(path.join(dataDir, 'secrets.json'));
  let cache = readJson(cacheFile, null), inflight = null, timer = null, notBefore = cache?.notBefore || 0, lastError = cache?.error || null;

  const keyInfo = () => {
    const f = secrets.get('aa_api_key');
    return f ? { key: f, from: 'file' } : env.AA_API_KEY ? { key: env.AA_API_KEY, from: 'env' } : { key: null, from: null };
  };
  const save = (j) => {
    cache = j;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(j));
      fs.renameSync(`${cacheFile}.tmp`, cacheFile);
    } catch (e) { log(`could not save ${cacheFile}: ${e.message}`); }
  };
  const stale = () => !cache?.fetched_at || now() - cache.fetched_at >= ttl;

  // Refetches when the cache is stale (or force), unless there is no key or we're inside a rate-limit wait.
  async function refresh({ force = false } = {}) {
    const { key } = keyInfo();
    if (!key || (!force && !stale()) || now() < notBefore) return false;
    inflight ||= (async () => {
      try {
        const r = await fetchModels(key, { fetch, base });
        lastError = null;
        // Keep a request in hand: if the window is nearly spent, wait for its reset before the next refresh.
        notBefore = r.limit.remaining < 3 && r.limit.reset ? r.limit.reset * 1000 : 0;
        save({ fetched_at: now(), tier: r.tier, notBefore, models: r.models });
        const { unmatched } = view();
        if (unmatched.length) log(`unmatched CLI models: ${unmatched.map((u) => `${u.agent}:${u.model}`).join(', ')}`);
        return true;
      } catch (e) {
        lastError = e.status ? e.message : 'Artificial Analysis request failed';
        notBefore = now() + (e.status === 429 ? e.retryAfter * 1000 : e.status === 401 || e.status === 403 ? ttl : 3600e3);
        save({ ...cache, notBefore, error: lastError });
        log(`fetch failed: ${lastError}`);
        return false;
      } finally { inflight = null; }
    })();
    return inflight;
  }

  // Per CLI model: {agent, model, label, source, fetched_at, aa?: {slug, name}, metrics|null}, plus unmatched and attribution.
  function view() {
    const cat = catalog();
    const { key } = keyInfo();
    const useAA = !!(key && Array.isArray(cache?.models));
    const overrides = readJson(path.join(metaDir, 'model-map.json'), {}) || {};
    const manual = key ? null : readJson(path.join(metaDir, 'model-metrics.json'), null);
    const source = key ? 'artificialanalysis' : 'manual';
    const data_status = key ? (inflight ? 'loading' : lastError ? 'error' : useAA ? 'ready' : 'loading') : manual && Object.keys(manual.models || {}).length ? 'ready' : 'unconfigured';
    const fetched_at = useAA ? cache.fetched_at : manual?.updated ? Date.parse(manual.updated) || null : null;
    const { matches, unmatched } = useAA ? matchModels(cat, cache.models, overrides) : { matches: {}, unmatched: [] };
    const entries = [], manualMissing = [];
    for (const [agent, models] of Object.entries(cat)) {
      for (const m of models || []) {
        const hit = useAA ? matches[agent]?.[m.id] : manualRow(manual, agent, m.id);
        if (!useAA && !hit) manualMissing.push({ agent, model: m.id, label: m.label || m.id });
        entries.push({ agent, model: m.id, label: m.label || m.id, source, fetched_at,
          ...(useAA && hit ? { aa: { slug: hit.slug, name: hit.name } } : {}), metrics: metricsOf(hit) });
      }
    }
    return { source, fetched_at, data_status, data_error: key ? lastError : null, stale: useAA && (stale() || !!lastError), entries, unmatched: useAA ? unmatched : manualMissing, attribution: ATTRIBUTION };
  }
  // What the Connections row may show: never the key itself.
  function status() {
    const { key, from } = keyInfo();
    return { configured: !!key, from, fetched_at: cache?.fetched_at || null, count: cache?.models?.length || 0,
      error: key ? lastError : null, attribution: ATTRIBUTION };
  }
  async function setKey(k) {
    k = String(k || '').trim();
    if (!k || k.length > 500 || /\s/.test(k)) throw Object.assign(new Error('Invalid API key'), { status: 400 });
    secrets.set('aa_api_key', k);
    notBefore = 0;
    lastError = null;
    await refresh({ force: true });
    return status();
  }
  function removeKey() { secrets.set('aa_api_key', null); lastError = null; return status(); }

  function start() {
    const p = refresh();
    timer = setInterval(() => refresh().catch(() => {}), Math.min(ttl, 3600e3));
    timer.unref?.();
    return p;
  }
  const stop = () => clearInterval(timer);
  return { refresh, view, status, setKey, removeKey, start, stop };
}
