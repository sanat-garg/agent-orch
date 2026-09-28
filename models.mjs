// Discovered model lists: every agent's models come from its own CLI (agents.mjs `discoverModels`), never a
// hardcoded guess. Cached in <DATA>/models.json ({saved, agents: {id: {models, error, at, failedAt?}}}) so a restart
// shows the last lists at once. Each discovery starts a CLI, so a list is rediscovered only once it is a day old (checked
// hourly, one agent at a time) or after that agent's sign-in changes (refresh([id])), never by reads (modelCatalog). At
// most one discovery per agent per MIN_GAP: an earlier request is deferred to the end of the gap (coalesced). A failed
// rediscovery keeps the last good list (never saves an empty one over it), records error + failedAt, and is retried
// after RETRY (hourly) instead of a day; the next success clears both.
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, discoverModels, setModelCatalog, modelCatalog } from './agents.mjs';

export const MODELS_TTL = 24 * 3600e3;
export const MIN_GAP = 60_000;
export const RETRY = 3600e3;

// discover(id) -> {models, error, at} is injectable for tests; onChange(ids) fires after a refresh stored new lists.
export function createModelStore({ file, ids = Object.keys(AGENTS), discover = discoverModels, intervalMs = MODELS_TTL, retryMs = RETRY, minGapMs = MIN_GAP, onChange = () => {}, log = () => {} }) {
  const inflight = new Map(), last = new Map(), deferred = new Map();
  let timer = null;

  function load() {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
    for (const id of ids) {
      const e = j?.agents?.[id];
      if (e && Array.isArray(e.models)) setModelCatalog(id, { models: e.models, error: e.error || null, at: e.at || null, ...(e.failedAt ? { failedAt: e.failedAt } : {}) });
      const t = Math.max(e?.at || 0, e?.failedAt || 0);
      if (t) last.set(id, t);
    }
    return true;
  }
  function save() {
    const agents = Object.fromEntries(ids.map((id) => [id, modelCatalog(id)]));
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ saved: Date.now(), agents }, null, 1));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) { log(`could not save ${file}: ${e.message}`); }
  }
  // Rediscovers the given agents (all by default); one discovery per agent at a time, one per agent per minGapMs.
  async function refresh(only = ids) {
    const want = [];
    for (const id of only.filter((x) => ids.includes(x))) {
      const wait = (last.get(id) ?? -Infinity) + minGapMs - Date.now();
      if (inflight.has(id) || wait <= 0) want.push(id);
      else if (!deferred.has(id)) {
        deferred.set(id, setTimeout(() => { deferred.delete(id); refresh([id]).catch(() => {}); }, wait));
        deferred.get(id).unref?.();
      }
    }
    if (!want.length) return;
    await Promise.all(want.map((id) => {
      if (!inflight.has(id)) {
        last.set(id, Date.now());
        inflight.set(id, (async () => {
          let e;
          try { e = await discover(id); } catch (err) { e = { models: [], error: String(err?.message || err), at: Date.now() }; }
          const prev = modelCatalog(id);
          if (e.error && prev.models?.length) {
            setModelCatalog(id, { models: prev.models, error: e.error, at: prev.at, failedAt: Date.now() });
            log(`${id}: rediscovery failed, keeping ${prev.models.length} models (${e.error})`);
          } else {
            setModelCatalog(id, e);
            if (e.error) log(`${id}: no models (${e.error})`);
          }
        })().finally(() => inflight.delete(id)));
      }
      return inflight.get(id);
    }));
    save();
    try { onChange(want); } catch {}
  }
  // Rediscovers only the lists older than intervalMs (retryMs after a failed rediscovery), one agent after another so
  // CLIs never start side by side.
  async function refreshStale() {
    for (const id of ids) {
      const age = modelCatalog(id).failedAt ? retryMs : intervalMs;
      if (Date.now() - (last.get(id) ?? -Infinity) >= age) await refresh([id]).catch(() => {});
    }
  }
  function start() {
    load();
    const p = refreshStale();
    timer = setInterval(() => refreshStale().catch(() => {}), Math.min(intervalMs, 3600e3));
    timer.unref?.();
    return p;
  }
  const stop = () => { clearInterval(timer); for (const t of deferred.values()) clearTimeout(t); deferred.clear(); };

  return { load, refresh, refreshStale, start, stop, get: modelCatalog };
}
