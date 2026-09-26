// Parallel planning (BRIEF goal 9): which queued work tasks may run at the same time in one project, and which
// agent/model each runs on when several are ready.
//   A task declares the files it will modify (`tasks.files`: JSON [path or glob]). Two tasks may run together only
//   if no path can match both declarations. No declaration means "everything": the task runs alone.

// A task's declared files: trimmed, deduplicated relative paths/globs ('./' dropped), or null (= everything).
export function parseFiles(v) {
  if (v == null || v === '') return null;
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { a = [v]; } }
  if (!Array.isArray(a)) return null;
  const out = [...new Set(a.filter((f) => typeof f === 'string').map((f) => f.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/')).filter(Boolean))];
  return out.length ? out.slice(0, 100) : null;
}

// {a,b} alternatives, expanded (nested braces too); capped so a pathological pattern can't blow up.
function expandBraces(p, n = 0) {
  const m = /\{([^{}]*)\}/.exec(p);
  if (!m || n > 64) return [p];
  return m[1].split(',').flatMap((alt) => expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length), n + 1));
}

// Can some string match both wildcard patterns? `anyTok` matches any run of tokens (it may be empty), `oneTok` exactly
// one, `fits(x, y)` whether two other tokens can be the same. Used on characters within a path segment ('*', '?')
// and on segments within a path ('**').
function intersects(a, b, { anyTok, oneTok, fits }) {
  const memo = new Map();
  const go = (i, j) => {
    const key = i * (b.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, false);
    let r;
    if (i === a.length && j === b.length) r = true;
    else if (i < a.length && a[i] === anyTok) r = go(i + 1, j) || (j < b.length && go(i, j + 1));
    else if (j < b.length && b[j] === anyTok) r = go(i, j + 1) || (i < a.length && go(i + 1, j));
    else r = i < a.length && j < b.length && (a[i] === oneTok || b[j] === oneTok || fits(a[i], b[j])) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}
const segChars = (s) => [...s].map((c) => (c === '*' ? '\0*' : c === '?' ? '\0?' : c));
const segmentsMeet = (x, y) => x === y || intersects(segChars(x), segChars(y), { anyTok: '\0*', oneTok: '\0?', fits: (c, d) => c === d });
// A pattern's segments. Any path without wildcards ('src/', 'public', '.agent-orch', even 'src/a.mjs') may be a
// directory, so it also covers everything under it; a real file has no children, so this only costs parallelism.
function segs(p) {
  const s = p.split('/').filter((x) => x && x !== '.');
  return p.endsWith('/') || !/[*?]/.test(p) ? [...s, '**'] : s;
}
const pathsMeet = (a, b) => intersects(segs(a), segs(b), { anyTok: '**', oneTok: null, fits: segmentsMeet });

// Do two declarations overlap? null (undeclared) overlaps everything.
export function filesOverlap(a, b) {
  a = parseFiles(a); b = parseFiles(b);
  if (!a || !b) return true;
  const ea = a.flatMap((p) => expandBraces(p)), eb = b.flatMap((p) => expandBraces(p));
  return ea.some((x) => eb.some((y) => pathsMeet(x, y)));
}

// Agent spreading: `ready` work tasks (in queue order) each with `options` = [{agent, model}], its primary first, then
// its fallbacks. `slotsFree(agent)` → how many more tasks that agent may run now; `hasUsage(agent, model, option)` → bool.
// Every task takes its primary when the primary has a free slot and usage; only a task that would otherwise wait
// spills to its first fallback that has both. Returns [{task, agent, model, spilled}] for the tasks that can start.
export function spreadAssign(ready, { slotsFree, hasUsage }) {
  const used = new Map(), free = (a) => slotsFree(a) - (used.get(a) || 0);
  const out = [], waiting = [];
  const take = (task, o, spilled) => { used.set(o.agent, (used.get(o.agent) || 0) + 1); out.push({ task, agent: o.agent, model: o.model, spilled }); };
  for (const r of ready) {
    const [primary] = r.options;
    if (primary && free(primary.agent) > 0 && hasUsage(primary.agent, primary.model, primary)) take(r.task, primary, false);
    else waiting.push(r);
  }
  for (const r of waiting) {
    const o = r.options.slice(1).find((f) => free(f.agent) > 0 && hasUsage(f.agent, f.model, f));
    if (o) take(r.task, o, true);
  }
  return out;
}
