// A chat's token usage, compared with the account's weekly plan limits (GET /api/convos/:id/usage, the chat header's
// token chip). The CLIs report each weekly window only as a percent, never in tokens, so a window's size is estimated:
// the weighted tokens (users.mjs tokenWeight) recorded for that window's models from its start up to the reading,
// divided by the reading's percent. The chat's tokens over that size say how much of a week it used: this week (its
// turns since the window began) and over its whole life (usage.mjs lifetime totals).
//   chatUsage({usageLog, refs: [{source, ref}], tasks: [{source, ref}], agents, now})
//     → {chat: Sum, tasks: Sum|null, weeks: [{agent, window, label, pct, resetsAt, readAt, size, week, life, tasksWeek, tasksLife}],
//        recent: {since, until, chat: Sum, tasks: Sum|null}}
//   Sum: {input, output, cached, turns, first, last, models: [{agent, model, input, output, cached, turns}]}
//   size: estimated weighted tokens of the whole window, or null while the reading is too small to scale up (< MIN_PCT);
//   week/life (and the tasks' pair): the chat's percent of one full window.
//   recent: the same sums over only the turns recorded in the rolling seven days since..until (now - WEEK_MS .. now).
import { tokenWeight, windowCovers, windowName, isWeekly, WEEK_MS } from './users.mjs';

export const MIN_PCT = 2; // below this a reading's rounding swamps the estimate

export function sumTotals(entries) {
  const out = { input: 0, output: 0, cached: 0, turns: 0, first: null, last: null, models: [] }, by = new Map();
  for (const e of entries) {
    if (!e) continue;
    out.first = out.first == null ? e.first : Math.min(out.first, e.first);
    out.last = out.last == null ? e.last : Math.max(out.last, e.last);
    for (const [key, m] of Object.entries(e.models || {})) {
      const [agent, ...rest] = key.split('/');
      const row = by.get(key) || by.set(key, { agent, model: rest.join('/') || null, input: 0, output: 0, cached: 0, turns: 0 }).get(key);
      for (const f of ['input', 'output', 'cached', 'turns']) { row[f] += m[f] || 0; out[f] += m[f] || 0; }
    }
  }
  out.models = [...by.values()].sort((a, b) => tokenWeight(b) - tokenWeight(a));
  return out;
}

// Tokens records (usage.mjs) summed into one Sum, as if they were one ref's lifetime totals.
export function sumRecords(records) {
  const e = { first: null, last: null, models: {} };
  for (const r of records) {
    e.first = e.first == null ? r.t : Math.min(e.first, r.t);
    e.last = e.last == null ? r.t : Math.max(e.last, r.t);
    const m = (e.models[`${r.agent}/${r.model || ''}`] ??= { input: 0, output: 0, cached: 0, turns: 0 });
    for (const f of ['input', 'output', 'cached']) m[f] += Number(r[f]) || 0;
    m.turns++;
  }
  return sumTotals(records.length ? [e] : []);
}

export function chatUsage({ usageLog, refs, tasks = null, agents = ['claude', 'codex'], now = Date.now() }) {
  const keys = (list) => new Set((list || []).map((r) => `${r.source}:${r.ref}`));
  const mine = keys(refs), theirs = keys(tasks);
  const chat = sumTotals(refs.map((r) => usageLog.totalsOf(r.source, r.ref)));
  const taskSum = tasks ? sumTotals(tasks.map((r) => usageLog.totalsOf(r.source, r.ref))) : null;
  const records = usageLog.tokensSince(now - WEEK_MS);
  const lifeOf = (sum, agent, window) => (sum?.models || []).reduce((s, m) => s + (m.agent === agent && windowCovers(agent, window, m.model) ? tokenWeight(m) : 0), 0);
  const used = new Set([...chat.models, ...(taskSum?.models || [])].map((m) => m.agent));
  const weeks = [];
  for (const agent of agents) {
    if (!used.has(agent)) continue;
    for (const w of usageLog.current(agent) || []) {
      if (!isWeekly(w.window)) continue;
      const start = (w.resetsAt ? w.resetsAt * 1000 : now) - WEEK_MS, readAt = w.readAt ?? now;
      let all = 0, week = 0, tasksWeek = 0;
      for (const r of records) {
        if (r.agent !== agent || r.t < start || !windowCovers(agent, w.window, r.model)) continue;
        const x = tokenWeight(r), k = `${r.source}:${r.ref}`;
        if (r.t <= readAt) all += x;
        if (mine.has(k)) week += x;
        else if (theirs.has(k)) tasksWeek += x;
      }
      const size = Number(w.pct) >= MIN_PCT && all > 0 ? all / (Number(w.pct) / 100) : null;
      const pct = (x) => (size ? Math.round(x / size * 1000) / 10 : null);
      const life = lifeOf(chat, agent, w.window);
      // A chat that used none of a per-model window's models has nothing to compare with it.
      if (!life && !lifeOf(taskSum, agent, w.window)) continue;
      weeks.push({
        agent, window: w.window, label: windowName(agent, w.window), pct: w.pct, resetsAt: w.resetsAt ?? null, readAt,
        size: size && Math.round(size), week: pct(week), life: pct(life),
        ...(taskSum && { tasksWeek: pct(tasksWeek), tasksLife: pct(lifeOf(taskSum, agent, w.window)) }),
      });
    }
  }
  const since = now - WEEK_MS, inRange = records.filter((r) => r.t <= now), of = (set) => inRange.filter((r) => set.has(`${r.source}:${r.ref}`));
  const recent = { since, until: now, chat: sumRecords(of(mine)), tasks: tasks ? sumRecords(of(theirs)) : null };
  return { chat, tasks: taskSum, weeks, recent };
}
