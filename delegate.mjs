// Delegation (BRIEF goal 8): a queued task whose agent is at its usage limit may move to another agent/model that
// still has usage left and whose Artificial Analysis metrics (aa.mjs view) are comparable on what the task needs.
//   eligible(task)  the policy: reflection tasks yes; the owner's chat tasks only when that message was sent with
//                   Auto Delegate (tasks.auto_delegate); never when the owner pinned a model for it (tasks.pinned_model).
//   rankCandidates  pure ranking of available models against the task's current model, by category-weighted metrics.
//   createDelegator wires both to live state (connections, blocks, usage windows, model catalog, metrics).

export const DELEGATE_CFG = {
  minRatio: 0.95,    // comparable: weighted score ≥ 95% of the original's …
  rankWindow: 2,     // … or within 2 ranks of it among the available models
  maxWindowPct: 90,  // an agent with any plan window at or above this is treated as limited
};

// Metric weights per task category. Keys are aa.mjs metrics fields or `benchmarks` entries.
export const CATEGORY_WEIGHTS = {
  coding: { coding_index: 0.6, terminalbench_hard: 0.4 },
  agentic: { agentic_index: 1 },
  scientific: { scicode: 1 },
  general: { intelligence_index: 1 },
};
export const CATEGORIES = Object.keys(CATEGORY_WEIGHTS);
const CATEGORY_WORDS = {
  coding: /\b(code|coding|implement\w*|fix\w*|bug\w*|tests?|refactor\w*|endpoint\w*|api|function\w*|module\w*|css|html|ui|server|client|migrat\w*|compile\w*|build|lint\w*|type\w*script|javascript|python|npm)\b/gi,
  agentic: /\b(agent\w*|agentic|multi-step|orchestrat\w*|workflow\w*|automat\w*|pipeline\w*|deploy\w*|end-to-end|browse\w*|research\w*|investigat\w*|triage\w*)\b/gi,
  scientific: /\b(scien\w*|data|dataset\w*|analy[sz]\w*|statistic\w*|notebook\w*|simulat\w*|numeric\w*|math\w*|plot\w*|csv|regression|model fitting|experiment\w*)\b/gi,
};

// A planner-provided category wins; else the category whose keywords appear most (title counts double); else general.
export function taskCategory(task = {}) {
  const c = String(task.category || '').toLowerCase();
  if (CATEGORY_WEIGHTS[c]) return c;
  let best = 'general', hits = 0;
  for (const [cat, re] of Object.entries(CATEGORY_WORDS)) {
    const n = 2 * (String(task.title || '').match(re) || []).length + (String(task.prompt || '').match(re) || []).length;
    if (n > hits) { best = cat; hits = n; }
  }
  return best;
}

// The policy matrix. Only work tasks move; plan/reflect runs belong to their agent.
export function eligible(task = {}) {
  if ((task.kind || 'work') !== 'work' || task.pinned_model) return false;
  const origin = task.origin || (task.source === 'reflection' ? 'reflection' : null);
  if (origin === 'reflection') return true;
  if (origin === 'chat') return Number(task.auto_delegate) === 1;
  return false;
}

// A metric on a 0–100 scale (AA benchmarks are fractions).
function metricValue(m, key) {
  const v = m?.[key] ?? m?.benchmarks?.[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v <= 1 ? v * 100 : v;
}
// Weighted mean over the keys the model has → {score, used} | null.
export function weightedScore(metrics, weights) {
  let sum = 0, w = 0;
  const used = {};
  for (const [k, wt] of Object.entries(weights)) {
    const v = metricValue(metrics, k);
    if (v == null) continue;
    sum += v * wt; w += wt; used[k] = Math.round(v * 10) / 10;
  }
  return w ? { score: sum / w, used } : null;
}

const LABELS = { coding_index: 'Coding Index', terminalbench_hard: 'Terminal-Bench', agentic_index: 'Agentic Index', scicode: 'SciCode', intelligence_index: 'Intelligence Index' };
const r1 = (x) => Math.round(x * 10) / 10;

// current: {agent, model}; entries: aa view entries ({agent, model, label, metrics}); available: [{agent, model}].
// → {category, original: {…, score} | null, candidates: [{agent, model, label, score, ratio, rank, metrics, reason}]}
// Candidates are the comparable available models, most similar to the original first (ties: higher score).
export function rankCandidates({ current, entries = [], available = [], category = 'general', cfg = DELEGATE_CFG }) {
  const same = (a, b) => a.agent === b.agent && a.model === b.model;
  const orig = entries.find((e) => same(e, current));
  let weights = CATEGORY_WEIGHTS[category] || CATEGORY_WEIGHTS.general;
  // Compare only on metrics the original has; without any of the category's, fall back to the Intelligence Index.
  let o = orig?.metrics && weightedScore(orig.metrics, weights);
  if (!o && category !== 'general') { weights = CATEGORY_WEIGHTS.general; o = orig?.metrics && weightedScore(orig.metrics, weights); }
  if (!o) return { category, original: null, candidates: [] };
  weights = Object.fromEntries(Object.entries(weights).filter(([k]) => k in o.used));
  const pool = [];
  for (const a of available) {
    if (same(a, current)) continue;
    const e = entries.find((x) => same(x, a));
    const s = e?.metrics && weightedScore(e.metrics, weights);
    if (s) pool.push({ agent: a.agent, model: a.model, label: e.label || a.model, score: s.score, metrics: s.used });
  }
  const ordered = [...pool, { self: true, score: o.score }].sort((a, b) => b.score - a.score);
  const origRank = ordered.findIndex((x) => x.self);
  const origName = orig.label || current.model;
  const candidates = [];
  for (const c of pool) {
    const rank = ordered.indexOf(c), ratio = c.score / o.score;
    const byScore = ratio >= cfg.minRatio, byRank = Math.abs(rank - origRank) <= cfg.rankWindow;
    if (!byScore && !byRank) continue;
    const keys = Object.entries(c.metrics).map(([k, v]) => `${LABELS[k] || k} ${v}`).join(', ');
    candidates.push({ agent: c.agent, model: c.model, label: c.label, score: r1(c.score), ratio: Math.round(ratio * 1000) / 1000, rank: rank + 1,
      metrics: c.metrics, similarity: 1 - Math.abs(c.score - o.score) / o.score,
      reason: `${category}: ${r1(c.score)} vs ${origName} ${r1(o.score)} (${Math.round(ratio * 100)}%${byScore ? '' : `, rank ${rank + 1} vs ${origRank + 1}`}); ${keys}` });
  }
  candidates.sort((a, b) => b.similarity - a.similarity || b.score - a.score);
  return { category, original: { ...current, label: origName, score: r1(o.score), metrics: o.used }, candidates };
}

// Live wiring. agents() → ids; connected(id) → bool (installed, signed in, on the subscription);
// blockedUntil(id) → epoch s | 0; windows(id) → [{window, pct}] current plan windows; models(id) → [{id, default?}];
// metrics() → aa view ({entries}). A window reading can't say which models it covers, so any window ≥ maxWindowPct
// makes the whole agent unavailable (conservative).
export function createDelegator({ agents, connected, blockedUntil, windows = () => [], models, metrics, cfg = DELEGATE_CFG }) {
  const hasUsage = (id) => connected(id) && !blockedUntil(id) && !(windows(id) || []).some((w) => Number(w.pct) >= cfg.maxWindowPct);
  const available = () => agents().filter(hasUsage).flatMap((a) => (models(a) || []).map((m) => ({ agent: a, model: m.id })));
  // The model a route with no model runs: the agent's default (else its first) model.
  const defaultModel = (agent) => { const ms = models(agent) || []; return (ms.find((m) => m.default) || ms[0])?.id || null; };
  function candidates(task, current) {
    const cur = { agent: current.agent, model: current.model || defaultModel(current.agent) };
    let view = null;
    try { view = metrics(); } catch {}
    return rankCandidates({ current: cur, entries: view?.entries || [], available: available(), category: taskCategory(task), cfg });
  }
  return { eligible, candidates, hasUsage, available };
}

// Auto Delegate preview (the composer summary): the start model plus the comparable models most likely used after it.
// all: [{agent, model, label}] every model of a connected agent, limited or not; usage(agent) → {status, until?, note?}
// where status is available | near | limited | unavailable. Limited candidates stay listed (the UI greys them) but rank
// after every usable one. → {category, start, candidates: [≤limit rankCandidates rows + usage + full metrics]}
export function previewDelegation({ current, entries = [], all = [], usage, category = 'coding', limit = 3, cfg = DELEGATE_CFG }) {
  const ranked = rankCandidates({ current, entries, available: all, category, cfg });
  const full = (a, m) => entries.find((e) => e.agent === a && e.model === m)?.metrics || null;
  const usable = (s) => s === 'available' || s === 'near';
  const rows = ranked.candidates.map((c, i) => ({ ...c, i, used: c.metrics, metrics: full(c.agent, c.model), ...usage(c.agent) }));
  rows.sort((a, b) => usable(b.status) - usable(a.status) || a.i - b.i);
  const label = all.find((m) => m.agent === current.agent && m.model === current.model)?.label
    || entries.find((e) => e.agent === current.agent && e.model === current.model)?.label || current.model;
  return {
    category: ranked.category,
    start: { ...current, label, score: ranked.original?.score ?? null, metrics: full(current.agent, current.model), ...usage(current.agent) },
    candidates: rows.slice(0, limit).map(({ i, similarity, ...r }) => r),
  };
}
