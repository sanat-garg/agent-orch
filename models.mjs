// Discovered model lists: every agent's models come from its own CLI (agents.mjs `discoverModels`), never a
// hardcoded guess. Cached in <DATA>/models.json ({saved, agents: {id: {models, error, at}}}) so a restart shows the
// last lists at once; refreshed on start, every 6 h, after a sign-in change (refresh([id])) and from the Connections
// Refresh, never by reads (modelCatalog). At most one discovery per agent per MIN_GAP: an earlier request is deferred
// to the end of the gap (coalesced) and answers from the cache meanwhile.
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, discoverModels, setModelCatalog, modelCatalog } from './agents.mjs';

export const MODELS_TTL = 6 * 3600e3;
export const MIN_GAP = 60_000;

// discover(id) -> {models, error, at} is injectable for tests; onChange(ids) fires after a refresh stored new lists.
export function createModelStore({ file, ids = Object.keys(AGENTS), discover = discoverModels, intervalMs = MODELS_TTL, minGapMs = MIN_GAP, onChange = () => {}, log = () => {} }) {
  const inflight = new Map(), last = new Map(), deferred = new Map();
  let timer = null;

  function load() {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
    for (const id of ids) {
      const e = j?.agents?.[id];
      if (e && Array.isArray(e.models)) setModelCatalog(id, { models: e.models, error: e.error || null, at: e.at || null });
      if (e?.at) last.set(id, e.at);
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
          setModelCatalog(id, e);
          if (e.error) log(`${id}: no models (${e.error})`);
        })().finally(() => inflight.delete(id)));
      }
      return inflight.get(id);
    }));
    save();
    try { onChange(want); } catch {}
  }
  function start() {
    load();
    const p = refresh();
    timer = setInterval(() => refresh().catch(() => {}), intervalMs);
    timer.unref?.();
    return p;
  }
  const stop = () => { clearInterval(timer); for (const t of deferred.values()) clearTimeout(t); deferred.clear(); };

  return { load, refresh, start, stop, get: modelCatalog };
}
