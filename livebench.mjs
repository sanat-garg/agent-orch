// LiveBench (https://livebench.ai) published results, mapped onto the models our CLIs report. Replaces the planned
// reliance on Artificial Analysis for delegation (BRIEF goal 8). LiveBench has no API: the official leaderboard is a
// static site built from github.com/LiveBench/livebench.github.io, and its page fetches, per benchmark release R
// (YYYY_MM_DD), `table_R.csv` (model × task scores, 0–100) and `categories_R.json` ({category: [task columns]}).
// We read exactly those files; releases are listed from that repo's public/ dir via the GitHub contents API.
// A category score is the mean of its task columns and the global average the mean of categories, as the site computes.
// Cache: <DATA>/livebench.json, refetched at most every 24 h; a failed refresh keeps the last good data (marked stale).
// Mapping is exact: a LiveBench model name equal to the CLI id/resolved id, or an explicit alias in
// .agent-orch/livebench-map.json. No fuzzy matching: a score from another version or effort level is never borrowed.
import fs from 'node:fs';
import path from 'node:path';

export const LB_SITE = 'https://livebench.ai';
export const LB_REPO = 'https://github.com/LiveBench/livebench.github.io';
export const LB_RELEASES_API = 'https://api.github.com/repos/LiveBench/livebench.github.io/contents/public';
export const LB_TTL = 24 * 3600e3;
const RETRY = 3600e3;
export const ATTRIBUTION = { text: 'Benchmark scores by LiveBench', url: LB_SITE };
const RELEASE_RE = /^\d{4}_\d{2}_\d{2}$/;

const bad = (msg) => Object.assign(new Error(`Invalid LiveBench data: ${msg}`), { malformed: true });

// ---------- parsing ----------
// categories_R.json → {category: [task]}; every value a non-empty list of distinct task names.
export function parseCategories(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Object.keys(j).length) throw bad('categories is not an object');
  const seen = new Set(), out = {};
  for (const [c, tasks] of Object.entries(j)) {
    if (!Array.isArray(tasks) || !tasks.length || !tasks.every((t) => typeof t === 'string' && t)) throw bad(`category ${c} has no task list`);
    for (const t of tasks) { if (seen.has(t)) throw bad(`task ${t} in two categories`); seen.add(t); }
    out[c] = [...tasks];
  }
  return out;
}

// table_R.csv (unquoted, header `model,<task>…`) → [{model, tasks, categories, global_average}]. Every categorised task
// must be a column; cells are empty (not run) or a number in 0–100. Anything else rejects the whole response.
export function parseTable(csv, categories) {
  if (typeof csv !== 'string' || /^\s*</.test(csv)) throw bad('table is not CSV');
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw bad('table has no rows');
  if (lines.some((l) => l.includes('"'))) throw bad('quoted CSV fields are not expected');
  const head = lines[0].split(',').map((s) => s.trim());
  if (head[0] !== 'model') throw bad('first column is not "model"');
  const col = new Map(head.map((h, i) => [h, i]));
  for (const t of Object.values(categories).flat()) if (!col.has(t)) throw bad(`missing task column ${t}`);
  const rows = [], names = new Set();
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((s) => s.trim());
    if (cells.length !== head.length) throw bad(`row "${cells[0]}" has ${cells.length} cells, expected ${head.length}`);
    const model = cells[0];
    if (!model || names.has(model)) throw bad(`empty or duplicate model "${model}"`);
    names.add(model);
    const tasks = {};
    for (let i = 1; i < head.length; i++) {
      if (cells[i] === '') { tasks[head[i]] = null; continue; }
      const v = Number(cells[i]);
      if (!Number.isFinite(v) || v < 0 || v > 100) throw bad(`${model} ${head[i]} = "${cells[i]}"`);
      tasks[head[i]] = v;
    }
    const cats = {};
    for (const [c, ts] of Object.entries(categories)) {
      const vs = ts.map((t) => tasks[t]).filter((v) => v !== null);
      cats[c] = vs.length ? round(vs.reduce((a, b) => a + b, 0) / vs.length) : null;
    }
    const cv = Object.values(cats).filter((v) => v !== null);
    rows.push({ model, tasks, categories: cats, global_average: cv.length ? round(cv.reduce((a, b) => a + b, 0) / cv.length) : null });
  }
  return rows;
}
const round = (v) => Math.round(v * 1000) / 1000;

// GitHub contents listing of public/ → releases (YYYY_MM_DD) that have both files, newest first.
export function parseReleases(list) {
  if (!Array.isArray(list)) throw bad('release listing is not an array');
  const names = new Set(list.map((f) => f?.name).filter((n) => typeof n === 'string'));
  return [...names].map((n) => /^table_(\d{4}_\d{2}_\d{2})\.csv$/.exec(n)?.[1]).filter((r) => r && names.has(`categories_${r}.json`)).sort().reverse();
}

// ---------- fetching ----------
async function get(fetch, url, kind) {
  let r;
  try { r = await fetch(url, { headers: { accept: kind === 'json' ? 'application/json' : 'text/csv,text/plain' } }); }
  catch (e) { throw Object.assign(new Error(`LiveBench request failed: ${e.message}`), { network: true }); }
  if (!r.ok) throw Object.assign(new Error(`LiveBench: HTTP ${r.status} for ${url}`), { status: r.status });
  const text = await r.text();
  if (kind !== 'json') return text;
  try { return JSON.parse(text); } catch { throw bad(`${url} is not JSON`); }
}
export const releaseUrls = (release, site = LB_SITE) => ({ table: `${site}/table_${release}.csv`, categories: `${site}/categories_${release}.json` });

// Newest release (or the given one) → the cache record. Discovery failure falls back to `release` when known.
export async function fetchResults({ fetch = globalThis.fetch, site = LB_SITE, releasesApi = LB_RELEASES_API, release = null, now = Date.now } = {}) {
  let rel = null;
  try { rel = parseReleases(await get(fetch, releasesApi, 'json'))[0] || null; }
  catch (e) { if (!release) throw e; }
  rel ||= release;
  if (!rel || !RELEASE_RE.test(rel)) throw bad('no release found');
  const urls = releaseUrls(rel, site);
  const categories = parseCategories(await get(fetch, urls.categories, 'json'));
  const models = parseTable(await get(fetch, urls.table, 'text'), categories);
  return { source: { site, repo: LB_REPO, releases: releasesApi, ...urls }, release: rel.replaceAll('_', '-'), fetched_at: now(), categories, models };
}

// ---------- mapping ----------
// catalog: {agent: [{id, label, resolved?}]}; aliases: {"agent:id" | "id": lbModel | null}. → {agent: {id: {model, via}|null}}
export function mapModels(catalog, lbModels, aliases = {}) {
  const names = new Set(lbModels.map((m) => m.model));
  const out = {};
  for (const [agent, models] of Object.entries(catalog)) {
    out[agent] = {};
    for (const m of models || []) {
      const ak = [`${agent}:${m.id}`, m.id].find((k) => Object.hasOwn(aliases, k));
      let hit = null;
      if (ak !== undefined) hit = typeof aliases[ak] === 'string' && names.has(aliases[ak]) ? { model: aliases[ak], via: 'alias' } : null;
      else { const n = [m.id, m.resolved].find((x) => x && names.has(x)); hit = n ? { model: n, via: 'exact' } : null; }
      out[agent][m.id] = hit;
    }
  }
  return out;
}

// ---------- store ----------
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function createLiveBenchStore({ dataDir, metaDir, catalog, fetch = globalThis.fetch, site = LB_SITE, releasesApi = LB_RELEASES_API, now = Date.now, ttl = LB_TTL, log = () => {} }) {
  const cacheFile = path.join(dataDir, 'livebench.json');
  let cache = readJson(cacheFile, null);
  if (!Array.isArray(cache?.models)) cache = cache?.error ? { error: cache.error, failed_at: cache.failed_at } : null;
  let inflight = null, timer = null;
  const save = () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(cache));
      fs.renameSync(`${cacheFile}.tmp`, cacheFile);
    } catch (e) { log(`could not save ${cacheFile}: ${e.message}`); }
  };
  const has = () => Array.isArray(cache?.models);
  const due = () => {
    if (cache?.failed_at && now() - cache.failed_at < RETRY) return false;
    return !has() || now() - cache.fetched_at >= ttl;
  };

  // Only a fully validated response replaces the cache; on failure the last good data stays and error/failed_at are set.
  async function refresh({ force = false } = {}) {
    if (!force && !due()) return false;
    inflight ||= (async () => {
      try {
        const r = await fetchResults({ fetch, site, releasesApi, release: cache?.release?.replaceAll('-', '_') || null, now });
        cache = r;
        save();
        return true;
      } catch (e) {
        const error = e.malformed || e.status || e.network ? e.message : 'LiveBench refresh failed';
        cache = { ...(cache || {}), error, failed_at: now() };
        save();
        log(`refresh failed${has() ? ', keeping last good data' : ''}: ${error}`);
        return false;
      } finally { inflight = null; }
    })();
    return inflight;
  }

  // data_status: ready (good data, maybe stale) | loading (none yet, fetching or not tried) | unavailable (none, last try failed).
  function view() {
    const ok = has();
    const aliases = readJson(path.join(metaDir, 'livebench-map.json'), {}) || {};
    const cat = catalog();
    const map = ok ? mapModels(cat, cache.models, aliases) : {};
    const byName = new Map((ok ? cache.models : []).map((m) => [m.model, m]));
    const entries = [], unmatched = [];
    for (const [agent, models] of Object.entries(cat)) {
      for (const m of models || []) {
        const hit = map[agent]?.[m.id] || null;
        const row = hit && byName.get(hit.model);
        if (ok && !hit) unmatched.push({ agent, model: m.id, label: m.label || m.id });
        entries.push({ agent, model: m.id, label: m.label || m.id,
          livebench: row ? { model: row.model, via: hit.via, release: cache.release } : null,
          scores: row ? { global_average: row.global_average, categories: row.categories } : null });
      }
    }
    const error = cache?.error || null;
    return {
      source: 'livebench', data_status: ok ? 'ready' : inflight || !error ? 'loading' : 'unavailable', data_error: error,
      stale: ok && (!!error || now() - cache.fetched_at >= ttl),
      release: ok ? cache.release : null, fetched_at: ok ? cache.fetched_at : null, source_urls: ok ? cache.source : null,
      categories: ok ? Object.keys(cache.categories) : [], entries, unmatched, attribution: ATTRIBUTION,
    };
  }

  function start() {
    const p = refresh();
    timer = setInterval(() => refresh().catch(() => {}), Math.min(ttl, RETRY));
    timer.unref?.();
    return p;
  }
  const stop = () => clearInterval(timer);
  return { refresh, view, start, stop };
}
