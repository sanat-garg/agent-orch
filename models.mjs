// Discovered model lists: every agent's models come from its own CLI (agents.mjs `discoverModels`), never a
// hardcoded guess. Cached in <DATA>/models.json ({saved, agents: {id: {models, error, at}}}) so a restart shows the
// last lists at once; refreshed on start, every 6 h and after a sign-in change (refresh([id])).
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, discoverModels, setModelCatalog, modelCatalog } from './agents.mjs';

export const MODELS_TTL = 6 * 3600e3;

// discover(id) -> {models, error, at} is injectable for tests; onChange(ids) fires after a refresh stored new lists.
export function createModelStore({ file, ids = Object.keys(AGENTS), discover = discoverModels, intervalMs = MODELS_TTL, onChange = () => {}, log = () => {} }) {
  const inflight = new Map();
  let timer = null;

  function load() {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
    for (const id of ids) {
      const e = j?.agents?.[id];
      if (e && Array.isArray(e.models)) setModelCatalog(id, { models: e.models, error: e.error || null, at: e.at || null });
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
  // Rediscovers the given agents (all by default); one discovery per agent at a time.
  async function refresh(only = ids) {
    const want = only.filter((id) => ids.includes(id));
    await Promise.all(want.map((id) => {
      if (!inflight.has(id)) {
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
  const stop = () => clearInterval(timer);

  return { load, refresh, start, stop, get: modelCatalog };
}
