#!/usr/bin/env node
// Health check for every agent CLI: installed + version, signed in + account, models discovered (count and the first
// few ids), plan-limit windows (name, pct, resetsAt) and their source, when each was last fetched, and errors.
// By default models and limits are fetched live from the CLIs (nothing is billed); --cached reads the server's caches
// (<DATA>/models.json, <DATA>/limits.json) instead. A failed live fetch shows the cache's last successful time.
//   node bin/agent-health.mjs [--json] [--cached] [--agent claude,codex] [--data <dir>]
// Exit 1 when an installed, signed-in agent has 0 models, or a limit window without a reset time although its source
// reports resets. A model list kept after a failed rediscovery is printed as an error but exits 0 (a warning).

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AGENTS, discoverModels, fetchLimits, setModelCatalog, LIMITS_NOT_EXPOSED } from '../agents.mjs';
import { agentState, healthRow } from '../health.mjs';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const { values: opt } = parseArgs({ options: {
  json: { type: 'boolean' }, cached: { type: 'boolean' }, agent: { type: 'string' },
  data: { type: 'string', default: process.env.CW_DATA_DIR || path.join(ROOT, 'data') },
} });
const ids = opt.agent ? opt.agent.split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(AGENTS);
for (const id of ids) if (!AGENTS[id]) { console.error(`unknown agent: ${id}`); process.exit(2); }

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(opt.data, f), 'utf8')); } catch { return null; } };
const cache = { models: readJson('models.json')?.agents || {}, limits: readJson('limits.json')?.agents || {} };

async function check(id) {
  let models = cache.models[id] || null, limits = cache.limits[id] || null;
  if (!opt.cached) {
    const m = await discoverModels(id);
    // A failed fetch still reports when the last good one was (from the server's cache).
    models = m.models.length ? m : { ...m, at: models?.models?.length ? models.at : null };
    const l = await fetchLimits(id);
    limits = l.error ? { ...l, at: limits?.at ?? null } : l;
  }
  if (models) setModelCatalog(id, models);
  return healthRow(id, { ...(await agentState(id)), models, limits });
}
const rows = await Promise.all(ids.map(check));
const ok = rows.every((r) => r.ok);

if (opt.json) {
  console.log(JSON.stringify({ ok, mode: opt.cached ? 'cached' : 'live', checkedAt: Date.now(), agents: rows }, null, 1));
  process.exit(ok ? 0 : 1);
}

const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '–');
const cells = (r) => [
  r.id,
  r.installed ? `yes ${r.version || '(version ?)'}` : 'no',
  !r.installed ? '–' : r.signedIn ? `yes${r.account ? ` ${r.account}` : ''}` : 'no',
  !r.signedIn ? '–' : [`${r.models.count}`, ...r.models.ids.slice(0, 3), ...(r.models.count > 3 ? ['…'] : [])].join('\n'),
  !r.signedIn ? '–' : !r.limits.exposed ? LIMITS_NOT_EXPOSED
    : [...r.limits.windows.map((w) => `${w.window} ${Math.round(w.pct)}% resets ${when(w.resetsAt && w.resetsAt * 1000)}${w.resetsAt && w.resetsAt * 1000 < Date.now() ? ' (passed)' : ''}`), `(${r.limits.source})`].join('\n'),
  !r.signedIn ? '–' : `models ${when(r.models.at)}\nlimits ${r.limits.exposed ? when(r.limits.at) : '–'}`,
  r.errors.join('\n') || (r.ok ? '' : 'failing'),
];
const head = ['agent', 'installed', 'signed in', 'models', 'limits (source)', 'last fetch', 'errors'];
const table = [head, ...rows.map(cells)].map((c) => c.map((s) => String(s).split('\n')));
const width = head.map((_, i) => Math.max(...table.map((r) => Math.max(...r[i].map((l) => l.length)))));
const line = (r) => {
  const out = [];
  for (let k = 0; k < Math.max(...r.map((c) => c.length)); k++) out.push(r.map((c, i) => (c[k] || '').padEnd(width[i])).join('  ').trimEnd());
  return out.join('\n');
};
console.log([line(table[0]), width.map((w) => '-'.repeat(w)).join('  '), ...table.slice(1).map(line)].join('\n'));
console.log(ok ? '\nOK: every signed-in agent has models and limits (or none exposed by its CLI).'
  : `\nFAIL: ${rows.filter((r) => !r.ok).map((r) => `${r.id} (${r.problems.join('; ')})`).join(', ')}`);
process.exit(ok ? 0 : 1);
