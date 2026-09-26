// Delegation (BRIEF goal 8): a queued task whose model is at its usage limit moves to the first entry of the owner's
// ordered fallback list that has usage left. No benchmarks, no automatic ranking: with no list (or an empty one) it waits.
//   eligible(task)  the policy: reflection tasks yes; the owner's chat tasks only when that message was sent with
//                   Auto Delegate (tasks.auto_delegate); never when the owner pinned a model for it (tasks.pinned_model).
//   createDelegator wires the owner's list to live state (connections, blocks, usage windows, model catalog).

export const DELEGATE_CFG = {
  maxWindowPct: 90,  // an agent with any plan window at or above this is treated as limited
};

// The policy matrix. Only work tasks move; plan/reflect runs belong to their agent.
export function eligible(task = {}) {
  if ((task.kind || 'work') !== 'work' || task.pinned_model) return false;
  const origin = task.origin || (task.source === 'reflection' ? 'reflection' : null);
  if (origin === 'reflection') return true;
  if (origin === 'chat') return Number(task.auto_delegate) === 1;
  return false;
}

// Owner fallbacks (a chat's `fallbacks`, snapshotted into tasks.fallbacks as JSON): [{agent, model}] in the owner's
// order, or null = none set. An empty array means the same: nothing to delegate to.
export function parseFallbacks(v) {
  if (v == null || v === '') return null;
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { return null; } }
  return Array.isArray(a) ? a.filter((f) => f && typeof f.agent === 'string' && typeof f.model === 'string').map(({ agent, model }) => ({ agent, model })) : null;
}

// Live wiring. agents() → ids; connected(id) → bool (installed, signed in, on the subscription);
// blockedUntil(id, model) → epoch s | 0; windows(id, model) → [{window, pct}] the plan windows that model counts against
// (antigravity: its group's); models(id) → [{id, default?}]. Any such window ≥ maxWindowPct makes the model unavailable,
// so a full Gemini window never hides antigravity's third-party models.
export function createDelegator({ agents, connected, blockedUntil, windows = () => [], models, cfg = DELEGATE_CFG }) {
  const hasUsage = (id, model) => connected(id) && !blockedUntil(id, model) && !(windows(id, model) || []).some((w) => Number(w.pct) >= cfg.maxWindowPct);
  const listed = (id, model) => (models(id) || []).some((m) => m.id === model);
  const available = () => agents().filter((a) => connected(a)).flatMap((a) => (models(a) || []).filter((m) => hasUsage(a, m.id)).map((m) => ({ agent: a, model: m.id })));
  // The model a route with no model runs: the agent's default (else its first) model.
  const defaultModel = (agent) => { const ms = models(agent) || []; return (ms.find((m) => m.default) || ms[0])?.id || null; };
  // The first fallback (other than the task's current model) whose agent is connected and not limited for that model,
  // with its 1-based position in the owner's list; else null.
  function nextModel(task, current = {}) {
    const cur = `${current.agent}/${current.model || defaultModel(current.agent)}`;
    const list = parseFallbacks(task.fallbacks) || [];
    for (const [i, f] of list.entries()) {
      if (`${f.agent}/${f.model}` === cur || !agents().includes(f.agent) || !listed(f.agent, f.model) || !hasUsage(f.agent, f.model)) continue;
      return { agent: f.agent, model: f.model, rank: i + 1, reason: `owner's fallback #${i + 1}` };
    }
    return null;
  }
  return { eligible, nextModel, hasUsage, available, defaultModel };
}

// Auto Delegate preview (the composer summary): the start model plus the owner's fallback list, each with its usage.
// all: [{agent, model, label}] every model of a connected agent; usage(agent, model) → {status, until?, note?} where
// status is available | near | limited | unavailable (a listed model its agent doesn't report is unavailable).
export function previewDelegation({ current, all = [], usage, fallbacks = null }) {
  const labelOf = (a, m) => all.find((x) => x.agent === a && x.model === m)?.label || m;
  const list = parseFallbacks(fallbacks);
  const key = (x) => `${x.agent}/${x.model}`;
  const candidates = (list || []).filter((f) => key(f) !== key(current)).map((f) => {
    const u = usage(f.agent, f.model);
    const known = all.some((m) => key(m) === key(f));
    return { agent: f.agent, model: f.model, label: labelOf(f.agent, f.model), rank: list.findIndex((x) => key(x) === key(f)) + 1,
      ...(known || u.status === 'unavailable' ? u : { status: 'unavailable', until: null, note: 'model not listed' }) };
  });
  return { start: { ...current, label: labelOf(current.agent, current.model), ...usage(current.agent, current.model) }, fallbacks: list, candidates };
}
