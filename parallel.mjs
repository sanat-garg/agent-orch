// Parallel planning (BRIEF goal 9): which queued work tasks may run at the same time in one project, and which
// agent/model each runs on when several are ready.
//   A task declares the files it will modify (`tasks.files`: JSON [path or glob]). With Rapid development mode off, two
//   tasks may run together only if no path can match both declarations; no declaration means "everything": the task
//   runs alone. In Rapid mode overlap is only a preference (see FILE_CAP): edits meet at merge time.

import fs from 'node:fs';
import os from 'node:os';
import { slotTarget } from './placement.mjs';

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

// Per-file concurrency caps (Rapid development mode). In Rapid mode file overlap is a preference, not a gate: a ready task
// whose declared files overlap running work goes after disjoint work, but takes a free slot when nothing else is ready.
// What still holds it back is a cap on how many running tasks may touch one declared file at once (FILE_CAP.default),
// tuned per file from the last 24 h of merge outcomes: a rebase-conflict rate above `lowerAbove` lowers the cap by one
// (min 1); one below `raiseBelow` raises it by one (max 6). An undeclared task (null = everything) is never capped.
export const FILE_CAP = { default: 3, min: 1, max: 6, windowSec: 24 * 3600, lowerAbove: 0.3, raiseBelow: 0.1 };

// The next cap for a file after its recorded outcomes ({ conflicts, total } within the window). No outcomes: unchanged.
export function nextFileCap(cap, { conflicts = 0, total = 0 } = {}) {
  cap = Number.isInteger(cap) ? Math.min(FILE_CAP.max, Math.max(FILE_CAP.min, cap)) : FILE_CAP.default;
  if (!total) return cap;
  const rate = conflicts / total;
  if (rate > FILE_CAP.lowerAbove) return Math.max(FILE_CAP.min, cap - 1);
  if (rate < FILE_CAP.raiseBelow) return Math.min(FILE_CAP.max, cap + 1);
  return cap;
}

// How many of the running declarations (each a `files` value; null ones are skipped: undeclared never hard-blocks) touch `file`.
export function fileConcurrency(file, runningDecls) {
  return runningDecls.filter((d) => parseFiles(d) && filesOverlap([file], d)).length;
}

// Rapid mode's hard check for a ready task: null when it may start, else the first declared file whose cap is full
// (`capOf(file)` → its cap). Undeclared files never block.
export function fileCapFull(files, runningDecls, capOf) {
  const list = parseFiles(files);
  if (!list) return null;
  for (const f of list) if (fileConcurrency(f, runningDecls) >= capOf(f)) return f;
  return null;
}

// Agent spreading: `ready` work tasks (in queue order) each with `options` = [{agent, model}], its primary first, then
// its fallbacks. `slotsFree(agent)` → how many more tasks that agent may run now; `hasUsage(agent, model, option, task)` → bool.
// Every task takes its primary when the primary has a free slot and usage; only a task that would otherwise wait
// spills to its first fallback that has both. Returns [{task, agent, model, spilled}] for the tasks that can start.
export function spreadAssign(ready, { slotsFree, hasUsage }) {
  const used = new Map(), free = (a) => slotsFree(a) - (used.get(a) || 0);
  const out = [], waiting = [];
  const take = (task, o, spilled) => { used.set(o.agent, (used.get(o.agent) || 0) + 1); out.push({ task, agent: o.agent, model: o.model, spilled }); };
  for (const r of ready) {
    const [primary] = r.options;
    if (primary && free(primary.agent) > 0 && hasUsage(primary.agent, primary.model, primary, r.task)) take(r.task, primary, false);
    else waiting.push(r);
  }
  for (const r of waiting) {
    const o = r.options.slice(1).find((f) => free(f.agent) > 0 && hasUsage(f.agent, f.model, f, r.task));
    if (o) take(r.task, o, true);
  }
  return out;
}

// Server memory from /proc/meminfo: MemAvailable (free plus reclaimable) and the fraction of swap in use, in bytes.
// Unreadable (not Linux) → os.freemem() and no swap.
export function readMemInfo(file = '/proc/meminfo') {
  try {
    const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)?.[1]) * 1024;
    const text = fs.readFileSync(file, 'utf8'), avail = kb('MemAvailable'), swap = kb('SwapTotal');
    if (!Number.isFinite(avail)) throw new Error('no MemAvailable');
    return { avail, swapPct: swap > 0 ? (swap - (kb('SwapFree') || 0)) / swap : 0 };
  } catch { return { avail: os.freemem(), swapPct: 0 }; }
}

// The memory emergency brake only (BRIEF goal 9): RAM never gates a claim or sizes slots.
export const MEM = {
  pauseBelow: 300 * 1024 ** 2,   // sustained below this, the newest running task is paused (orchestrator memGuard)
  reapBelow: 1.5 * 1024 ** 3,    // below this the reaper (resources.mjs) runs right before claiming
};

// The controller's work-task slots (BRIEF goal 9): the setting (placement.mjs slotTarget by default), which pacing can
// still drop to one. Free memory plays no part.
export function taskSlots({ setting = 1, pacingLimit = Infinity }) {
  return Math.max(1, Math.min(setting, pacingLimit));
}

// Work slots follow cores (at least 4); controller-only work keeps its reserved slots on top.
export function headTarget(cores, reserve = 2) {
  const work = slotTarget(cores), reserved = Math.max(0, Math.floor(reserve));
  return { target: work + reserved, reserved, work };
}
