// Delegation (BRIEF goal 8): a queued task whose agent is at its usage limit may move to another agent/model that
// still has usage left and whose LiveBench scores from one release are comparable on what the task needs.
//   eligible(task)  the policy: reflection tasks yes; the owner's chat tasks only when that message was sent with
//                   Auto Delegate (tasks.auto_delegate); never when the owner pinned a model for it (tasks.pinned_model).
//   rankCandidates  pure ranking of available models against the task's current model, by category-weighted metrics.
//   createDelegator wires both to live state (connections, blocks, usage windows, model catalog, metrics).

export const DELEGATE_CFG = {
  maxScoreDrop: 5,   // LiveBench percentage points; no rank-window shortcut
  maxWindowPct: 90,  // an agent with any plan window at or above this is treated as limited
};

// Task → actual LiveBench categories. Scientific requires both categories; never reweight missing values.
export const CATEGORY_WEIGHTS = {
  coding: { Coding: 1 },
  agentic: { 'Agentic Coding': 1 },
  scientific: { Mathematics: 0.5, 'Data Analysis': 0.5 },
  general: { global_average: 1 },
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

// LiveBench already uses 0–100, including values below one. All requested metrics must exist.
export function weightedScore(scores, weights) {
  let sum = 0, total = 0;
  const used = {};
  for (const [key, weight] of Object.entries(weights)) {
    const v = key === 'global_average' ? scores?.global_average : scores?.categories?.[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return null;
    sum += v * weight; total += weight; used[key] = v;
  }
  return total ? { score: sum / total, used } : null;
}
const r1 = (x) => Math.round(x * 10) / 10;
// Stale data is displayable but never used to assert comparability. No AA compatibility fallback.
export function rankingEntries(view) {
  return view?.source === 'livebench' && view.data_status === 'ready' && !view.stale
    ? (view.entries || []).filter((e) => e.livebench?.release === view.release) : [];
}
export function rankCandidates({ current, entries = [], available = [], category = 'general', cfg = DELEGATE_CFG }) {
  const same = (a, b) => a.agent === b.agent && a.model === b.model;
  const weights = CATEGORY_WEIGHTS[category] || CATEGORY_WEIGHTS.general;
  const orig = entries.find((e) => same(e, current));
  const o = orig?.livebench?.release && weightedScore(orig.scores, weights);
  const fallback = [], scored = [];
  for (const a of available) {
    if (same(a, current)) continue;
    const e = entries.find((e) => same(e, a));
    const score = o && e?.livebench?.release === orig.livebench.release && weightedScore(e.scores, weights);
    const c = { ...a, label: e?.label || a.label || a.model };
    if (!score) {
      fallback.push({ ...c, score: null, ratio: null, metrics: null, benchmark: false,
        reason: 'non-benchmark fallback: no fresh comparable LiveBench score; same agent first, then agent/model ID' });
    } else if (score.score >= o.score - (cfg.maxScoreDrop ?? DELEGATE_CFG.maxScoreDrop)) {
      scored.push({ ...c, score: r1(score.score), ratio: o.score ? score.score / o.score : null,
        metrics: score.used, benchmark: true, release: orig.livebench.release, distance: Math.abs(score.score - o.score),
        reason: `LiveBench ${orig.livebench.release} ${category}: ${r1(score.score)} vs ${orig.label || current.model} ${r1(o.score)}` });
    }
  }
  const lexical = (a, b) => { const x = `${a.agent}/${a.model}`, y = `${b.agent}/${b.model}`; return x < y ? -1 : x > y ? 1 : 0; };
  scored.sort((a, b) => a.distance - b.distance || b.score - a.score || lexical(a, b));
  fallback.sort((a, b) => Number(b.agent === current.agent) - Number(a.agent === current.agent) || lexical(a, b));
  return { category, original: o ? { ...current, label: orig.label || current.model, score: r1(o.score), metrics: o.used } : null,
    candidates: [...scored, ...fallback].map((c, i) => ({ ...c, rank: i + 1 })) };
}

// Owner-curated fallbacks (a chat's `fallbacks`, snapshotted into tasks.fallbacks as JSON): [{agent, model}] in the
// owner's order, or null = automatic ranking. An empty array is curated too: nothing to delegate to.
export function parseFallbacks(v) {
  if (v == null || v === '') return null;
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { return null; } }
  return Array.isArray(a) ? a.filter((f) => f && typeof f.agent === 'string' && typeof f.model === 'string').map(({ agent, model }) => ({ agent, model })) : null;
}
// The owner chose these, so the comparable threshold doesn't apply: every listed model (but the current one) that
// `usable` accepts, in the owner's order. Score/metrics against the current model are for display only (null without
// metrics); rank is the 1-based position in the owner's list.
export function curatedCandidates({ current, list = [], entries = [], usable = () => true, category = 'general', cfg = DELEGATE_CFG }) {
  const scored = rankCandidates({ current, entries, available: list, category, cfg: { ...cfg, maxScoreDrop: Infinity } });
  const key = (x) => `${x.agent}/${x.model}`;
  const byKey = new Map(scored.candidates.map((c) => [key(c), c]));
  const seen = new Set([key(current)]), candidates = [];
  list.forEach((f, i) => {
    if (seen.has(key(f)) || !usable(f)) return;
    seen.add(key(f));
    const c = byKey.get(key(f));
    candidates.push({ agent: f.agent, model: f.model, label: c?.label || entries.find((e) => key(e) === key(f))?.label || f.model, score: c?.score ?? null, ratio: c?.ratio ?? null,
      rank: i + 1, metrics: c?.metrics || null, reason: `owner's fallback #${i + 1}${c ? `; ${c.reason}` : ''}` });
  });
  return { category: scored.category, original: scored.original, candidates, curated: true };
}

// Live wiring. agents() → ids; connected(id) → bool (installed, signed in, on the subscription);
// blockedUntil(id, model) → epoch s | 0; windows(id, model) → [{window, pct}] the plan windows that model counts against
// (antigravity: its group's); models(id) → [{id, default?}]; metrics() → LiveBench view ({entries}). Any such window
// ≥ maxWindowPct makes the model unavailable, so a full Gemini window never hides antigravity's third-party models.
export function createDelegator({ agents, connected, blockedUntil, windows = () => [], models, metrics, cfg = DELEGATE_CFG }) {
  const hasUsage = (id, model) => connected(id) && !blockedUntil(id, model) && !(windows(id, model) || []).some((w) => Number(w.pct) >= cfg.maxWindowPct);
  const available = () => agents().filter((a) => connected(a)).flatMap((a) => (models(a) || []).filter((m) => hasUsage(a, m.id)).map((m) => ({ agent: a, model: m.id })));
  // The model a route with no model runs: the agent's default (else its first) model.
  const defaultModel = (agent) => { const ms = models(agent) || []; return (ms.find((m) => m.default) || ms[0])?.id || null; };
  function candidates(task, current) {
    const cur = { agent: current.agent, model: current.model || defaultModel(current.agent) };
    let view = null;
    try { view = metrics(); } catch {}
    const list = parseFallbacks(task.fallbacks);
    if (list) {
      const ok = new Set(available().map((m) => `${m.agent}/${m.model}`));
      return curatedCandidates({ current: cur, list, entries: rankingEntries(view), usable: (f) => ok.has(`${f.agent}/${f.model}`), category: taskCategory(task), cfg });
    }
    return rankCandidates({ current: cur, entries: rankingEntries(view), available: available(), category: taskCategory(task), cfg });
  }
  return { eligible, candidates, hasUsage, available };
}

// Auto Delegate preview (the composer summary): the start model plus the comparable models most likely used after it.
// all: [{agent, model, label}] every model of a connected agent, limited or not; usage(agent, model) → {status, until?, note?}
// where status is available | near | limited | unavailable. Limited candidates stay listed (the UI greys them) but rank
// after every usable one. → {category, start, fallbacks, candidates: [≤limit rankCandidates rows + usage + full metrics], suggested}
// With a curated `fallbacks` list, candidates are that whole list in the owner's order, each with its usage (a model
// that isn't listed for a connected agent is unavailable); `suggested` is always the automatic top `limit`.
export function previewDelegation({ current, entries = [], all = [], usage, category = 'coding', limit = 3, fallbacks = null, cfg = DELEGATE_CFG }) {
  const ranked = rankCandidates({ current, entries, available: all, category, cfg });
  const full = (a, m) => entries.find((e) => e.agent === a && e.model === m)?.scores || null;
  const usable = (s) => s === 'available' || s === 'near';
  const rows = ranked.candidates.map((c, i) => ({ ...c, i, used: c.metrics, metrics: full(c.agent, c.model), ...usage(c.agent, c.model) }));
  rows.sort((a, b) => usable(b.status) - usable(a.status) || a.i - b.i);
  const labelOf = (a, m) => all.find((x) => x.agent === a && x.model === m)?.label || entries.find((e) => e.agent === a && e.model === m)?.label || m;
  const suggested = rows.slice(0, limit).map(({ i, similarity, ...r }) => r);
  const list = parseFallbacks(fallbacks);
  const curated = list && curatedCandidates({ current, list, entries, category, cfg }).candidates.map((c) => {
    const u = usage(c.agent, c.model);
    const listed = all.some((m) => m.agent === c.agent && m.model === c.model);
    return { ...c, label: labelOf(c.agent, c.model), used: c.metrics, metrics: full(c.agent, c.model),
      ...(listed || u.status === 'unavailable' ? u : { status: 'unavailable', until: null, note: 'model not listed' }) };
  });
  return {
    category: ranked.category,
    start: { ...current, label: labelOf(current.agent, current.model), score: ranked.original?.score ?? null, metrics: full(current.agent, current.model), ...usage(current.agent, current.model) },
    fallbacks: list, candidates: curated || suggested, suggested,
  };
}
