// One health row per agent CLI: install + version, sign-in + account, discovered models, plan-limit windows and their
// source, when each was last fetched, and what is wrong. Shared by bin/agent-health.mjs (live checks) and the
// Connections modal (the server's cached model/limit stores).
import { AGENTS, readVersion, LIMITS_NOT_EXPOSED } from './agents.mjs';
import { codexAccount } from './connections.mjs';

export function agentAccount(id) {
  const a = AGENTS[id];
  if (id === 'codex') return codexAccount();
  return a.account?.() || null;
}

// models: a model catalog entry {models, error, at}; limits: a fetchLimits/limit-store entry {source, exposed, windows,
// error, at}. `problems` fail the health check (0 models, or a window without a reset while the source provides resets);
// `errors` are everything worth showing, problems included.
export function healthRow(id, { installed, version = null, signedIn, account = null, models, limits }) {
  const a = AGENTS[id], ms = models?.models || [];
  const exposed = limits ? limits.exposed !== false : !!a.limitSource;
  const windows = exposed ? limits?.windows || [] : [];
  const row = {
    id, label: a.label, installed: !!installed, version, signedIn: !!(installed && signedIn), account: installed && signedIn ? account : null,
    models: { count: ms.length, ids: ms.map((m) => m.id), error: models?.error || null, at: ms.length ? models.at ?? null : null },
    limits: { source: exposed ? limits?.source || a.limitSource : null, exposed, note: exposed ? null : LIMITS_NOT_EXPOSED,
      windows: windows.map((w) => ({ window: w.window, pct: w.pct, resetsAt: w.resetsAt ?? null })),
      error: exposed ? limits?.error || null : null, at: exposed ? limits?.at ?? null : null },
    problems: [], errors: [],
  };
  if (!row.signedIn) return { ...row, ok: true };
  if (!row.models.count) row.problems.push(`no models${row.models.error ? ` (${row.models.error})` : ''}`);
  const noReset = row.limits.windows.filter((w) => w.resetsAt == null).map((w) => w.window);
  if (noReset.length) row.problems.push(`no reset time for ${noReset.join(', ')}`);
  row.errors.push(...row.problems);
  if (row.limits.error) row.errors.push(`limits: ${row.limits.error}`);
  else if (exposed && !row.limits.windows.length) row.errors.push('limits: no reading yet');
  return { ...row, ok: !row.problems.length };
}

// Install/sign-in state and version, read now (login checks are cached for a minute).
export async function agentState(id) {
  const a = AGENTS[id], installed = !!a.available();
  const signedIn = installed && !!a.loggedIn();
  return { installed, version: installed ? await readVersion(id) : null, signedIn, account: signedIn ? agentAccount(id) : null };
}
