// Stats: one read-only snapshot of everything the owner and the orchestrator have done, for the Stats sheet
// (public/stats.js). The server only collects; ranges, local-time buckets and insights are the browser's job, so
// every timestamp here is epoch ms and nothing is formatted.
//   GET /api/stats → { at, since, projects, tasks, runs, chat, you, owner, checks, moves, windows, limits, commits, machine }
// Sources: the orchestrator DB (own read-only connection), chat logs (<DATA>/logs/<convo>.jsonl), usage.jsonl,
// minutes.jsonl and each project's git log (cached per HEAD). Missing sources give empty lists, never an error.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readRecords } from './usage.mjs';

export const CACHE_MS = 30e3;
const TEXT_MAX = 600; // characters of each of your messages kept (the sheet mines them for words)
const FILES_MAX = 40; // files listed per commit
// Generated or vendored files: left out of line counts and hotspots.
export const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|node_modules\/|dist\/|\.agent-orch\/shots\/)|\.min\.(js|css)$|\.(png|jpe?g|gif|ico|mp3|woff2?)$/;

const ms = (s) => (s == null ? null : Math.round(s * 1000));
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const git = (cwd, args) => new Promise((resolve) => execFile('git', ['-C', cwd, ...args], { timeout: 20e3, maxBuffer: 64 << 20 },
  (err, out) => resolve(err ? null : out)));

// A commit subject → who made it: an orchestrator task ("agent-orch #12: …", older "AO2 #12: …"), a reflection's
// roadmap update, the owner's chat/manual edits swept in before a merge ("… uncommitted changes …", "Chat: …"), or other.
export function commitKind(subject) {
  const s = String(subject || '');
  if (/roadmap update \(reflection/i.test(s)) return { by: 'reflect', task: Number(/#(\d+)/.exec(s)?.[1]) || null };
  if (/uncommitted changes/i.test(s) || /^Chat:/i.test(s)) return { by: 'you', task: null };
  const m = /^[\w .-]{1,40}? #(\d+)(?: \(in progress\)| failed)?:/.exec(s);
  if (m) return { by: 'task', task: Number(m[1]) };
  return { by: 'other', task: null };
}

// `git log --numstat` → [{sha, t, by, task, add, del, files: [path]}], newest first.
export function parseGitLog(out) {
  const commits = [];
  for (const chunk of String(out || '').split('\x1e')) {
    const lines = chunk.split('\n');
    const head = lines.shift();
    if (!head?.trim()) continue;
    const [sha, at, subject] = head.split('\t');
    const c = { sha: sha.slice(0, 9), t: Number(at) * 1000, ...commitKind(subject), add: 0, del: 0, files: [] };
    for (const l of lines) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
      if (!m) continue;
      const file = m[3];
      if (GENERATED.test(file)) continue;
      c.add += Number(m[1]) || 0; c.del += Number(m[2]) || 0;
      if (c.files.length < FILES_MAX) c.files.push(file);
    }
    commits.push(c);
  }
  return commits;
}

// minutes.jsonl samples ({t, cpu, mem}) → hourly {t, cpu (mean), mem (mean), peak (max cpu)}.
export function hourlyMachine(samples) {
  const by = new Map();
  for (const s of samples) {
    if (!Number.isFinite(s?.t)) continue;
    const h = Math.floor(s.t / 3600e3) * 3600e3;
    const b = by.get(h) || { t: h, cpu: 0, mem: 0, peak: 0, n: 0 };
    b.cpu += Number(s.cpu) || 0; b.mem += Number(s.mem) || 0; b.peak = Math.max(b.peak, Number(s.cpu) || 0); b.n++;
    by.set(h, b);
  }
  return [...by.values()].sort((a, b) => a.t - b.t)
    .map((b) => ({ t: b.t, cpu: Math.round((b.cpu / b.n) * 10) / 10, mem: Math.round((b.mem / b.n) * 10) / 10, peak: b.peak }));
}

// Window readings → one row per plan window period (agent + window + reset time): its first/peak/last reading.
// A period is "closed" once its reset has passed; its peak is how much of that window was used.
export function windowPeriods(records, now = Date.now()) {
  const by = new Map();
  for (const r of records) {
    if (r.kind !== 'window' || r.resetsAt == null || !Number.isFinite(Number(r.pct))) continue;
    const k = `${r.agent}\n${r.window}\n${r.resetsAt}`;
    const t = r.at ?? r.t, pct = Number(r.pct);
    const p = by.get(k) || { agent: r.agent, window: r.window, resetsAt: r.resetsAt * 1000, first: t, last: t, peak: pct, end: pct, n: 0 };
    if (t < p.first) p.first = t;
    if (t >= p.last) { p.last = t; p.end = pct; }
    p.peak = Math.max(p.peak, pct); p.n++;
    by.set(k, p);
  }
  return [...by.values()].map((p) => ({ ...p, closed: p.resetsAt <= now })).sort((a, b) => a.resetsAt - b.resetsAt);
}

// Owner actions the orchestrator logged as events: what you steered, by kind.
export function ownerAction(message) {
  const m = String(message || '');
  if (/^#\d+ (\(\+\d+ dependents?\) )?moved (before|after)/.test(m)) return 'reorder';
  if (/^■ #\d+ cancelled/.test(m) || /^■ review break #\d+ removed/.test(m)) return 'cancel';
  if (/delegated by the owner/.test(m)) return 'delegate';
  if (/^#\d+ set to (background|normal|urgent)/.test(m)) return 'urgency';
  if (/^#\d+ retried/.test(m)) return 'retry';
  if (/^✔ #\d+ approved/.test(m) || /changes requested/i.test(m)) return 'review';
  if (/^project settings:/.test(m) || /^reflection settings:/.test(m)) return 'settings';
  if (/paused by the owner|^⏸ #\d+ paused|handed off|^▶ #\d+ resumed/i.test(m)) return 'pause';
  return null;
}

export function createStats({ dataDir, dbFile = path.join(dataDir, 'orchestrator', 'agent-orch.db'), convos = () => [], now = Date.now, log = () => {} }) {
  const gitCache = new Map(); // repo path -> { head, commits }
  let cached = null, cachedAt = 0, inflight = null;

  async function commitsFor(repo) {
    const head = (await git(repo, ['rev-parse', 'HEAD']))?.trim();
    if (!head) return [];
    const hit = gitCache.get(repo);
    if (hit?.head === head) return hit.commits;
    const out = await git(repo, ['log', '--no-merges', '--no-renames', '--numstat', '--format=%x1e%H%x09%at%x09%s']);
    const commits = out == null ? [] : parseGitLog(out);
    gitCache.set(repo, { head, commits });
    return commits;
  }

  function fromDb() {
    const empty = { projects: [], tasks: [], runs: [], events: [] };
    if (!fs.existsSync(dbFile)) return empty;
    let db;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
      const all = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
      return {
        projects: all('SELECT id, name, path, status, created_at FROM projects'),
        tasks: all('SELECT id, project_id, kind, title, status, urgency, source, origin, attempts, continuations, created_at, started_at, finished_at, agent, model, ran_agent, ran_model, commit_sha, moves, node_id, effort FROM tasks'),
        runs: all('SELECT id, task_id, purpose, outcome, agent, node_id, effort, input_tokens, output_tokens, cache_read_tokens, num_turns, started_at, finished_at FROM runs'),
        events: all('SELECT ts, level, project_id, task_id, message FROM events'),
      };
    } catch (e) { log(`db: ${e.message}`); return empty; }
    finally { try { db?.close(); } catch {} }
  }

  // Your messages, from every chat log: [{t, cwd, words, text (clipped)}].
  function yourMessages() {
    const out = [], byId = new Map(convos().map((c) => [c.id, c]));
    let files = [];
    try { files = fs.readdirSync(path.join(dataDir, 'logs')).filter((f) => f.endsWith('.jsonl')); } catch {}
    for (const f of files) {
      const id = f.slice(0, -6), cwd = byId.get(id)?.cwd || null;
      let text = '';
      try { text = fs.readFileSync(path.join(dataDir, 'logs', f), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.includes('"t":"user"')) continue;
        const e = safeJson(line);
        if (e?.t !== 'user' || !Number.isFinite(e.ts)) continue;
        const s = String(e.text || '');
        out.push({ t: e.ts, cwd, words: s.split(/\s+/).filter(Boolean).length, text: s.slice(0, TEXT_MAX) });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  async function build() {
    const { projects, tasks, runs, events } = fromDb();
    const usage = readRecords(path.join(dataDir, 'metrics', 'usage.jsonl'));
    const projByPath = new Map(projects.map((p) => [p.path, p.id]));
    const taskById = new Map(tasks.map((t) => [t.id, t]));

    // Runs carry uncached input only; usage.jsonl has the full split (Claude cache writes included), so a task run's
    // tokens come from its usage record when one matches (same task, logged within 2 min of the run ending).
    const tokenRecs = usage.filter((r) => r.kind === 'tokens');
    const taskTok = new Map();
    for (const r of tokenRecs) if (r.source === 'task' && r.ref != null) (taskTok.get(r.ref) || taskTok.set(r.ref, []).get(r.ref)).push(r);
    const runRows = runs.map((r) => {
      const task = taskById.get(r.task_id);
      const end = ms(r.finished_at);
      let tok = { in: r.input_tokens || 0, out: r.output_tokens || 0, cached: r.cache_read_tokens || 0 };
      const recs = taskTok.get(r.task_id);
      if (recs && end) {
        const i = recs.findIndex((u) => Math.abs(u.t - end) < 120e3);
        if (i >= 0) { const u = recs.splice(i, 1)[0]; tok = { in: u.input || 0, out: u.output || 0, cached: u.cached || 0 }; }
      }
      return {
        id: r.id, task: r.task_id, p: task?.project_id ?? null, purpose: r.purpose, outcome: r.outcome,
        // Runs from before the agent column were Claude's.
        agent: r.agent || 'claude', model: task?.ran_model || task?.model || null, node: r.node_id || 'controller', effort: r.effort || null,
        start: ms(r.started_at), end, turns: r.num_turns || 0, ...tok,
      };
    });

    const checks = [], owner = [], moves = [];
    for (const e of events) {
      const t = ms(e.ts), m = e.message;
      let x;
      if ((x = /^✔ #(\d+) done \(check passed\)/.exec(m))) checks.push({ t, task: +x[1], ok: true });
      else if ((x = /^↻ #(\d+) done-when check failed/.exec(m)) || (x = /^✖ #(\d+) failed \(verification\)/.exec(m))) checks.push({ t, task: +x[1], ok: false });
      const kind = ownerAction(m);
      if (kind) owner.push({ t, kind, p: e.project_id ?? null });
    }
    for (const t of tasks) {
      for (const mv of safeJson(t.moves) || []) {
        if (!mv?.from || !mv?.to) continue;
        moves.push({ t: ms(mv.at), task: t.id, by: mv.by || 'limit', from: `${mv.from.agent}/${mv.from.model || ''}`, to: `${mv.to.agent}/${mv.to.model || ''}` });
      }
    }

    const commits = [];
    for (const p of projects) {
      if (!fs.existsSync(path.join(p.path, '.git'))) continue;
      for (const c of await commitsFor(p.path)) commits.push({ ...c, p: p.id });
    }

    let machine = [];
    try { machine = hourlyMachine(readRecords(path.join(dataDir, 'metrics', 'minutes.jsonl'))); } catch {}

    const you = yourMessages().map((m) => ({ t: m.t, p: projByPath.get(m.cwd) ?? null, words: m.words, text: m.text }));
    const all = [...tasks.map((t) => ms(t.created_at)), ...you.map((m) => m.t), ...projects.map((p) => ms(p.created_at))].filter(Number.isFinite);
    return {
      at: now(),
      since: all.length ? Math.min(...all) : now(),
      projects: projects.map((p) => ({ id: p.id, name: p.name, status: p.status, created: ms(p.created_at) })),
      tasks: tasks.map((t) => ({
        id: t.id, p: t.project_id, kind: t.kind || 'work', title: t.title, status: t.status, urgency: t.urgency,
        // Who asked: you (chat or a direct task) or the orchestrator's own reflection.
        from: t.source === 'reflection' || t.origin === 'reflection' ? 'reflection' : 'you',
        created: ms(t.created_at), started: ms(t.started_at), finished: ms(t.finished_at), attempts: t.attempts || 0, continuations: t.continuations || 0,
        agent: t.ran_agent || t.agent || null, model: t.ran_model || t.model || null, sha: t.commit_sha || null, node: t.node_id || null, effort: t.effort || null,
      })),
      runs: runRows,
      chat: tokenRecs.filter((r) => r.source === 'chat').map((r) => ({ t: r.t, agent: r.agent, in: r.input || 0, out: r.output || 0, cached: r.cached || 0 })),
      you, owner, checks, moves,
      windows: windowPeriods(usage, now()),
      limits: usage.filter((r) => r.kind === 'limit').map((r) => ({ t: r.t, agent: r.agent, status: r.status, window: r.window || null, resetsAt: r.resetsAt ? r.resetsAt * 1000 : null })),
      commits: commits.sort((a, b) => a.t - b.t),
      machine,
    };
  }

  return {
    // Cached for CACHE_MS; concurrent callers share one build.
    async collect({ fresh = false } = {}) {
      if (!fresh && cached && now() - cachedAt < CACHE_MS) return cached;
      return (inflight ||= build().then((r) => { cached = r; cachedAt = now(); return r; }).finally(() => { inflight = null; }));
    },
  };
}
