// Orchestrator Mode: agent-orch's agent orchestrator.
//
//   planner    your chat in Orchestrator Mode. Reads the project, keeps .agent-orch/BRIEF.md and CONTEXT.md
//              current, and turns what you want into small, chained, verifiable tasks.
//   workers    one fresh Claude Code session per task, several at once. Each does exactly one task,
//              is checked against its "Done when" command, and is committed to git.
//   reflector  when a project's queue is empty and "Keep improving" is on, it inspects the code,
//              rewrites ROADMAP.md and queues the next most valuable steps.
//
// Everything runs on the Claude subscription through the Claude Code SDK. A governor sleeps until
// usage limits reset and resumes the same session; pacing decides how hard to push from the
// 5-hour and weekly usage. State lives in SQLite; each project's memory lives in <project>/.agent-orch/.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { AGENTS, agentStatus, runAgentCli, toolInputSummary } from './agents.mjs';

// ---------------------------------------------------------------- config

const CFG = {
  concurrency: 2,               // agent slots (+1 while pacing pushes harder)
  maxAttempts: 3,               // non-limit failures before a task is marked failed
  maxContinuations: 4,          // times a worker may say "not finished yet"
  resetBufferSec: 20,           // added after a reported reset time
  unknownResetBackoffSec: [300, 600, 1200, 1800, 3600],
  idleReflectCooldownSec: 3600, // wait after a reflection that found nothing
  maxReflectCooldownSec: 12 * 3600,
  verifyTimeoutSec: 600,
  taskTimeoutSec: 3 * 3600,
  pollMs: 3000,
  autoCommit: true,
  reuseSessions: true,
  sessionReuseMaxIdleSec: 900,
  sessionMaxContextTokens: 120000,
  sessionMaxTasks: 6,
  contextBudgetBytes: 8000,
  // Tools a worker may use without full autonomy. Anything else is refused, never prompted.
  // File changes are limited to the project folder (./** is relative to the session's cwd).
  safeTools: [
    'Read', 'Glob', 'Grep', 'Edit(./**)', 'Write(./**)', 'MultiEdit(./**)', 'NotebookEdit(./**)', 'TodoWrite', 'WebSearch', 'WebFetch',
    'Bash(git:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(grep:*)',
    'Bash(find:*)', 'Bash(sort:*)', 'Bash(diff:*)', 'Bash(echo:*)', 'Bash(pwd)', 'Bash(which:*)', 'Bash(test:*)',
    'Bash(mkdir:*)', 'Bash(mv:*)', 'Bash(cp:*)', 'Bash(touch:*)', 'Bash(sed:*)', 'Bash(awk:*)',
    'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)', 'Bash(bun:*)', 'Bash(deno:*)',
    'Bash(python3:*)', 'Bash(python:*)', 'Bash(pip:*)', 'Bash(pip3:*)', 'Bash(pytest:*)', 'Bash(uv:*)',
    'Bash(make:*)', 'Bash(cargo:*)', 'Bash(go:*)', 'Bash(tsc:*)', 'Bash(jest:*)', 'Bash(vitest:*)',
  ],
};

const MEM_DIR = '.agent-orch'; // per-project memory dir

const PLANNER_TOOLS = [
  'Read', 'Glob', 'Grep', 'TodoWrite', 'WebSearch', 'WebFetch',
  'Write(.agent-orch/**)', 'Edit(.agent-orch/**)', 'MultiEdit(.agent-orch/**)',
  'Bash(git log:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(ls:*)', 'Bash(wc:*)',
];

const PRIORITY = { plan: 100, user: 60, planner: 50, reflection: 30, reflect: 25 };
const URGENCY = { urgent: 85, normal: 50, background: 20 };
const URGENCIES = ['urgent', 'normal', 'background'];
const PREEMPT_MARGIN = 20;
const PREEMPT_MIN_RUNTIME = 60;

// ---------------------------------------------------------------- prompts (from agent-orch)

const TASKS_FORMAT = `Emit work as a fenced block exactly like this (strict JSON inside, no comments):

\`\`\`agent-orch-tasks
{"project": {"priority": 50, "mode": "build"},
 "tasks": [
   {"title": "Short imperative title",
    "prompt": "Self-contained instructions: goal, the files involved, constraints, and how to check it works.",
    "done_when": "The single observable check that proves this task is finished (a command to run, a test that passes, a file that exists with X in it).",
    "urgency": "urgent | normal | background",
    "deadline": "2026-09-19T18:00 or null",
    "after": 0,
    "agent": "optional: claude | codex | antigravity",
    "model": "optional model id"}
 ],
 "routes": [{"match": "tests", "agent": "codex", "model": null, "scope": "project"}, {"remove": 3}]}
\`\`\`

**Break work into small, separately verifiable steps. This matters more than anything else here.**
- One deliverable per task. A task should change a handful of files and be provable by ONE check.
  Aim for 15–45 minutes of agent work. If you are tempted to write "and also", split it.
- Never emit a task like "build the app", "implement the feature end to end", or "set everything up".
  Emit the chain instead: skeleton that runs → one endpoint/screen/function → its tests → the next one.
- \`done_when\` must be checkable by a machine or by looking at one specific thing. No "works well".
  When a command proves it, put that command in backticks, e.g. \`npm test\`. Every command-like backticked
  snippet is run, joined with &&. Absence checks use \`! grep …\` (a bare grep exits 1 when nothing matches).
- \`after\` sequences the chain: the 0-based index of an earlier task in THIS block, or "#12" for an
  existing task id. A task only starts once the one it points at has finished. Use it liberally —
  later steps must not begin until the step they build on is actually done.
- Each task is run by a FRESH Claude Code session with no memory of this conversation. It will read
  .agent-orch/BRIEF.md and .agent-orch/CONTEXT.md, so put durable context there and keep each prompt self-contained.
- Never repeat work that is already queued, running, or done.

**Urgency decides what runs first, so set it honestly:**
- \`urgent\` — has a real deadline or someone is blocked (assignments due, broken production, a demo).
  Always set \`deadline\` when one exists; the orchestrator raises the task automatically as it approaches.
- \`normal\` — the active push on a project with no hard date.
- \`background\` — never-ending upkeep (SEO passes, refactors, polish, docs). It runs only when nothing
  more important is waiting, so it can wait days without harm.

\`project.priority\` (0–100, default 50) ranks this whole project against the others, and \`project.mode\`
is "build" (has an end) or "maintain" (ongoing upkeep). Only include \`project\` when it should change.

**Which agent and model run a task.** The context lists the coding agents, their suggested models and the
current routing rules. A task runs on, in order: its own \`agent\`/\`model\` (omit both unless this one task
needs something special), else the first matching project route, else the first matching global route, else
Claude on the chat's model. A route's \`match\` is a task kind (\`work\`, \`reflect\`, \`plan\`) or a keyword
looked for in task titles (\`tests\`, \`ui\`, \`docs\`, \`refactor\`, …), so title tasks with that word.
When the owner states a lasting preference ("use codex for writing tests", "use opus for planning", "gemini for
UI work"), save it in \`routes\`: \`agent\` and/or \`model\`, \`scope\` "project" (default) or "global" (every
project), optional \`note\`. A new route with the same match and scope replaces the old one; \`{"remove": id}\`
deletes one. A \`plan\` route may only pick a Claude model. Unavailable agents fall back to Claude.
A block may contain only \`routes\` (with \`"tasks": []\`).`;

const PLANNER_SYSTEM = `You are the planning mind of an agent orchestrator (agent-orch) running on the owner's server.
You talk with the owner, understand exactly what they want, and turn it into small, well-specified steps
for autonomous Claude Code agents that run around the clock within the owner's plan usage limits.

How to behave:
- Be concise and direct, like a sharp senior engineer. No fluff.
- Investigate the project yourself (read files, git log) before asking anything you could find out.
  You are already in the project root: run commands there directly (plain \`git log\`, no \`cd\` or \`git -C\`).
- Ask clarifying questions only when the answer materially changes the work; batch them (max ~4).
  If something is a routine judgment call, decide, and state the assumption.
- Catch urgency: if the owner mentions a deadline, an assignment, a demo or anything time-bound, set it
  as a real deadline and mark those tasks urgent. Ongoing upkeep is background work.
- Keep the project memory current: write/refresh .agent-orch/BRIEF.md (vision, goals, constraints, definition
  of done) and .agent-orch/CONTEXT.md (architecture, conventions, decisions). Only write inside .agent-orch/; code changes
  are the workers' job, so queue them as tasks rather than making them yourself.
- Queue a small first chain of steps as soon as the intent is clear — you don't need the whole plan up
  front, and you can add the next steps after these finish. Reply in one or two lines: why this chain,
  not what's in it — the owner sees the queued tasks as cards under your reply.
- Tokens are precious: don't queue speculative busywork, and don't re-read things you already know.

${TASKS_FORMAT}`;

const WORKER_SYSTEM = `You are an autonomous senior engineer working for an agent orchestrator (agent-orch). No human is watching
this session: never ask questions or wait for confirmation — make sound decisions and record notable ones.
Begin by reading .agent-orch/BRIEF.md and .agent-orch/CONTEXT.md in the project root.

Do exactly the one task you are given — not the next one, not a bigger version of it. Resist scope creep:
anything you notice but were not asked to do stays out of this change — the reflector picks up real gaps
on its own; note it in .agent-orch/CONTEXT.md only if it's a durable fact worth remembering.

Before you claim to be finished, actually verify it: run the command, the test, or the check named in
"Done when". Do not assume it works because the code looks right.

If you learn something future sessions must know (architecture, conventions, gotchas), add at most a
few lines of genuinely durable fact to .agent-orch/CONTEXT.md — not a running log. Prefer editing an existing
line over appending a new one. Do not create git commits — the orchestrator commits after you finish.

Your final message is exactly one line and nothing else:
  AGENT-ORCH-STATUS: done — <max 10 words on what is now true>
  AGENT-ORCH-STATUS: continue — <max 10 words on what remains>
Do not summarise the changes or list the files you touched — the diff, the commit, and JOURNAL.md already
record that. Use \`continue\` if the task is genuinely unfinished (including when you ran out of room); the
orchestrator will give the rest back to you in a new session. Never write \`done\` for work you could not verify.`;

const REFLECT_ASK = 'Look at this project and improve it — find the most valuable next steps and queue them.';

const REFLECT_SYSTEM = `You are the reflective mind of an agent orchestrator (agent-orch). The work queue for this project is empty, and
your job is to decide what would most improve the project next — thinking like its owner, a demanding
product lead, and a senior engineer at once. Do NOT modify source code in this session; you may only
update files in .agent-orch/.`;

const RESUME = 'You were interrupted before finishing (usage limit, timeout, or a restart). Continue the same task ' +
  'from where you left off: check the current state of the files first and do not redo completed work. ' +
  'Finish with just the AGENT-ORCH-STATUS line as instructed.';

const CONTINUE = 'Your previous session on this task reported it was not finished yet. Continue it now: check what ' +
  "is already in place, finish the remaining part, verify it against 'Done when', and end with just " +
  'the AGENT-ORCH-STATUS line.';

const CONTEXT_COMPACTION = `.agent-orch/CONTEXT.md is over its size budget — every session pays to read it in full, and it has grown past
what's durable. Before anything else, rewrite it down to only what a fresh session genuinely needs to know:
architecture, conventions, decisions, gotchas. Delete anything that reads like a changelog, restates what the
code already plainly says, or narrates finished work — that history belongs in .agent-orch/JOURNAL.md.`;

function retryAfterFailure(attempt, outcome, detail) {
  const label = { max_turns: 'ran out of turns', timeout: 'timed out', error: 'errored' }[outcome] || outcome;
  let text = `This is attempt ${attempt} at this task. The previous attempt ${label} before finishing. Diagnose ` +
    `exactly what went wrong from the captured output below before doing anything else — do not just start over.\n\n` +
    `Captured output from the previous attempt:\n${detail}\n\n`;
  text += ['max_turns', 'timeout'].includes(outcome)
    ? "That kind of ending usually means the work was in progress, not broken. Do the smallest remaining piece " +
      "toward 'Done when' and end with AGENT-ORCH-STATUS: continue rather than re-attempting everything."
    : 'Fix the actual root cause of that error, then verify it yourself before claiming done.';
  return text + " Check the current state of the files first — don't redo work that's already correct. " +
    'Finish with just the AGENT-ORCH-STATUS line as instructed.';
}

function verifyFailedPrompt(command, output) {
  return 'Your previous session reported AGENT-ORCH-STATUS: done, but the orchestrator does not trust that self-report — it ran ' +
    `the 'Done when' check itself, and the check failed:\n\nCommand:\n  ${command}\n\nOutput:\n${output}\n\n` +
    'Fix the actual underlying cause so this command genuinely passes. Do not weaken, skip, or delete the check ' +
    'itself to make it pass. Re-run the command yourself before claiming done again, then end with just the AGENT-ORCH-STATUS line.';
}

const stamp = (sec) => {
  const d = sec ? new Date(sec * 1000) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const nowText = () => {
  const d = new Date();
  return `${stamp()} ${d.toLocaleDateString('en-US', { weekday: 'long' })}`;
};

function formatQueue(rows) {
  if (!rows.length) return '  (empty)';
  return rows.map((r) => {
    const bits = [`  #${r.id} [${r.status}] (${r.kind}) ${r.title}`];
    if (r.urgency && r.urgency !== 'normal') bits.push(`urgency=${r.urgency}`);
    if (r.deadline) bits.push(`due ${stamp(r.deadline)}`);
    if (r.depends_on) bits.push(`after #${r.depends_on}`);
    return bits.join(' · ');
  }).join('\n');
}

function plannerTurnPrompt(project, rows, text, environment) {
  return `[agent-orch context] Project: ${project.name} at ${project.path}\n` +
    `Project priority: ${project.priority}/100 · mode: ${project.mode}\n` +
    `Now: ${nowText()} (use this to turn 'tomorrow', 'by Friday' into real deadlines)\n` +
    `${environment}\n` +
    `Current queue:\n${formatQueue(rows)}\n\n[Owner says]\n${text}`;
}

function taskBody(task, header) {
  const parts = [...header, `# Task #${task.id}: ${task.title}`, '', task.prompt];
  if (task.done_when) parts.push('', '## Done when', task.done_when);
  if (task.deadline) parts.push('', `(Deadline: ${stamp(task.deadline)})`);
  return parts.join('\n') + '\n';
}
const workerTaskPrompt = (project, task, environment) => taskBody(task, [`Project: ${project.name} (${project.path})`, environment, '']);
const nextTaskPrompt = (task) => taskBody(task, [
  'The previous task in this session is finished and closed. Drop any of its files, plans, or working state ' +
  'from your mind — this is a new, unrelated task.', '']);

const until = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
};

function reflectPrompt(project, rows, journalTail, overage, limits, reason, failures, outcomes, environment) {
  const sections = [];
  const lines = [];
  for (const [type, label] of [['five_hour', '5h window'], ['seven_day', 'Weekly']]) {
    const r = limits.find((l) => l.limit_type === type);
    if (!r || (r.utilization == null && !r.resets_at)) continue;
    const used = r.utilization == null ? 'usage unknown' : `${Math.round(r.utilization * 100)}% used`;
    lines.push(`- ${label}: ${used}${r.resets_at ? `, resets in ${until(r.resets_at - now())}` : ''}`);
  }
  if (reason) lines.push(`- Pacing: ${reason}`);
  if (lines.length) {
    sections.push(`Capacity right now:\n${lines.join('\n')}\nSize your queue to this: if much of the 5h window will expire ` +
      'unused, queue enough valuable work (up to 5 steps) to use it; if weekly capacity is tight, queue only the ' +
      'highest-value steps, or none.\n');
  }
  if (failures.length) {
    sections.push('Recent failures (last 7 days):\n' + failures.map((r) => {
      let d = String(r.result || r.last_error || '(no detail)').replace(/\s+/g, ' ');
      if (d.length > 200) d = d.slice(0, 200) + '…';
      return `- #${r.id} [${r.status}] ${r.title}: ${d}`;
    }).join('\n') + '\nDo not re-propose a failed task unless the new task explicitly addresses its root cause. ' +
      'Where a previous step failed or needed several continuations, prefer smaller steps.\n');
  }
  if (outcomes.done + outcomes.failed >= 3) {
    sections.push(`Your recent reflection-queued work (last 7 days): ${outcomes.done} passed, ${outcomes.failed} failed. ` +
      (outcomes.failed > outcomes.done
        ? "Many of your steps failed: favour smaller, more verifiable steps with a concrete 'Done when' check.\n"
        : 'Keep sizing steps like the ones that passed.\n'));
  }
  return `Project: ${project.name} (${project.path})
Project priority: ${project.priority}/100 · mode: ${project.mode}
Now: ${nowText()}
${environment}
${overage ? `\n${CONTEXT_COMPACTION}\n` : ''}
Read .agent-orch/BRIEF.md, .agent-orch/CONTEXT.md and .agent-orch/ROADMAP.md, then inspect the actual code. Where cheap, run the
build/tests/linters to find real problems rather than guessing.

Recently completed work (tail of .agent-orch/JOURNAL.md):
${journalTail || '(nothing yet)'}

Recent task history:
${formatQueue(rows)}
${sections.map((s) => `\n${s}`).join('')}
Ask yourself: what else should be done? Consider, in rough order of value: broken things (failing
build/tests, bugs), gaps versus the brief's goals and definition of done, user-facing quality and UX,
reliability and error handling, security, performance, test coverage, documentation, and code health.

Then:
1. Rewrite .agent-orch/ROADMAP.md: a brief honest assessment, the prioritized next steps, and later ideas.
2. Queue the next 1–5 steps as small, separately verifiable tasks (chain them with \`after\`). Prefer
   finishing and hardening what exists over new scope unless the brief asks for it. If the project truly
   meets its brief and nothing valuable remains, return an empty task list rather than inventing busywork.
   Unless something is genuinely broken or time-bound, this upkeep work is \`background\` urgency.

Start your reply with one or two plain sentences for the owner on what you found and why these steps,
then the tasks block.

${TASKS_FORMAT}`;
}

// ---------------------------------------------------------------- parsing helpers (from agent-orch context.py / verify.py)

const TASKS_BLOCK_RE = /```(?:agent-orch|ao2)-tasks\s*\n([\s\S]*?)\n```/g;
const STATUS_RE = /^\s*(?:AGENT-ORCH|AO2)-STATUS:\s*(done|continue)\b[\s—:-]*(.*)$/gim;

// Parses JSONL text, skipping blank and corrupt lines (e.g. a partial write from a killed process).
export const parseJsonl = (text) => text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

export function parseStatus(text) {
  const matches = [...String(text || '').matchAll(STATUS_RE)];
  if (!matches.length) return ['done', ''];
  const m = matches[matches.length - 1];
  return [m[1].toLowerCase(), m[2].trim()];
}

// Removes the tasks block from text meant for the owner (also an unfinished one mid-stream).
export function stripTasksBlock(text) {
  const s = String(text || '');
  const i = s.search(/```(?:agent-orch|ao2)-tasks/);
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

// The DB was called ao2.db; move it (and its WAL/SHM sidecars) to agent-orch.db once.
export function migrateDbFile(dir) {
  const from = path.join(dir, 'ao2.db'), to = path.join(dir, 'agent-orch.db');
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(from + ext)) fs.renameSync(from + ext, to + ext);
  fs.renameSync(from, to);
  return true;
}

const TEMPLATES = {
  'BRIEF.md': '# Project Brief\n\n_Maintained by the orchestrator\'s planner from conversations with the owner._\n\n## Vision\n\n(not yet defined)\n\n## Goals\n\n## Constraints & Preferences\n\n## Definition of Done\n',
  'CONTEXT.md': '# Project Context\n\n_Durable knowledge for every agent session: architecture, conventions, decisions, gotchas._\n\n## Architecture\n\n## Conventions\n\n## Decisions\n\n## Gotchas\n',
  'ROADMAP.md': '# Roadmap\n\n_Maintained by the orchestrator\'s reflection loop._\n\n## Assessment\n\n## Next\n\n## Ideas / Later\n',
  'JOURNAL.md': '# Journal\n\n_Append-only record of completed work, written by the orchestrator._\n',
};

// The memory dir was called .ao2/; move it to .agent-orch/ once. If an old server recreated .ao2/ after the
// move, merge it in: missing entries move over, new JOURNAL.md entries are appended, a file that extends
// its counterpart replaces it, and untouched templates are dropped. Real conflicts stay in .ao2/.
export function migrateMemDir(p) {
  const from = path.join(p, '.ao2'), to = path.join(p, MEM_DIR);
  if (!fs.existsSync(from)) return false;
  if (!fs.existsSync(to)) { fs.renameSync(from, to); return true; }
  const merge = (a, b) => {
    for (const name of fs.readdirSync(a)) {
      const fa = path.join(a, name), fb = path.join(b, name);
      if (!fs.existsSync(fb)) { fs.renameSync(fa, fb); continue; }
      if (fs.statSync(fa).isDirectory()) { if (fs.statSync(fb).isDirectory()) merge(fa, fb); continue; }
      const ta = fs.readFileSync(fa, 'utf8'), tb = fs.readFileSync(fb, 'utf8'), top = a === from;
      if (top && name === 'JOURNAL.md') { const i = ta.indexOf('\n## '); if (i >= 0) fs.appendFileSync(fb, ta.slice(i)); }
      else if (ta.startsWith(tb)) fs.writeFileSync(fb, ta);
      else if (!tb.startsWith(ta) && !(top && ta === TEMPLATES[name])) continue;
      fs.rmSync(fa);
    }
    if (!fs.readdirSync(a).length) fs.rmdirSync(a);
  };
  merge(from, to);
  return true;
}

function clamp(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

export function extractTasks(text) {
  const all = [...String(text || '').matchAll(TASKS_BLOCK_RE)];
  if (!all.length) return [stripTasksBlock(text), null];
  const m = all[all.length - 1];
  let payload;
  try { payload = JSON.parse(m[1]); } catch { return [stripTasksBlock(text), null]; }
  if (Array.isArray(payload)) payload = { tasks: payload };
  const clean = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  const tasks = [];
  for (const t of payload.tasks || []) {
    if (!t || typeof t !== 'object' || !t.title || !t.prompt) continue;
    const u = String(t.urgency || 'normal').toLowerCase();
    tasks.push({
      title: String(t.title).slice(0, 200),
      prompt: String(t.prompt),
      done_when: t.done_when ? String(t.done_when).slice(0, 2000) : null,
      urgency: URGENCIES.includes(u) ? u : 'normal',
      deadline: parseDeadline(t.deadline),
      after: t.after ?? null,
      priority: t.priority != null ? clamp(t.priority, 1, 90, null) : null,
      agent: normalizeAgent(t.agent),
      model: t.model ? String(t.model).trim().slice(0, 100) || null : null,
    });
  }
  const routes = [];
  for (const r of Array.isArray(payload.routes) ? payload.routes : []) {
    if (!r || typeof r !== 'object') continue;
    if (r.remove != null) {
      const id = parseInt(String(r.remove).replace(/^#/, ''), 10);
      if (id > 0) routes.push({ remove: id });
      continue;
    }
    const match = String(r.match || '').trim().toLowerCase().slice(0, 100);
    const agent = normalizeAgent(r.agent), model = r.model ? String(r.model).trim().slice(0, 100) || null : null;
    if (!match || (!agent && !model)) continue;
    routes.push({ match, agent, model, scope: String(r.scope || '').toLowerCase() === 'global' ? 'global' : 'project',
      note: r.note ? String(r.note).slice(0, 300) : null });
  }
  let project = null;
  if (payload.project && typeof payload.project === 'object') {
    project = {};
    if (payload.project.priority != null) project.priority = clamp(payload.project.priority, 0, 100, 50);
    const mode = String(payload.project.mode || '').toLowerCase();
    if (mode === 'build' || mode === 'maintain') project.mode = mode;
    if (!Object.keys(project).length) project = null;
  }
  return [clean, { tasks, project, routes }];
}

// ---- routing: which agent/model runs a task

const AGENT_ALIASES = { claude: 'claude', 'claude-code': 'claude', codex: 'codex', openai: 'codex', antigravity: 'antigravity', agy: 'antigravity', gemini: 'antigravity' };
// A known agent id (accepting aliases such as 'gemini' → 'antigravity'), or null.
export function normalizeAgent(name) {
  const id = AGENT_ALIASES[String(name || '').trim().toLowerCase()];
  return id && AGENTS[id] ? id : null;
}
const agentForModel = (model) => (model ? Object.keys(AGENTS).find((id) => AGENTS[id].models?.includes(model)) || null : null);

// A route's `match` hits a task whose kind equals it or whose title contains it as a word (plural-tolerant:
// 'tests' matches "Add a test" and 'refactor' matches "Refactors").
const KIND_WORDS = { planning: 'plan', planner: 'plan', reflection: 'reflect', reflecting: 'reflect' };
export function routeMatches(match, task) {
  const m = String(match || '').trim().toLowerCase();
  if (!m) return false;
  if ((KIND_WORDS[m] || m) === String(task.kind || '').toLowerCase()) return true;
  const stem = m.replace(/(?<=\w{3})e?s$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${stem}(?:e?s|ing|ed)?\\b`, 'i').test(String(task.title || ''));
}

// Resolution order: the task's own agent/model, the first matching project route, the first matching
// global route, then the project default (Claude on project.model). An agent that isn't installed or
// logged in falls back to Claude; `fellBack` names it and `reason` says why, so the caller can log it.
// isAvailable(id) returns true, or false / a reason string.
export function resolveRoute(task, project, routes = [], isAvailable = agentStatus) {
  const pick = (agent, model, source) => {
    agent = normalizeAgent(agent) || agentForModel(model) || 'claude';
    return { agent, model: model || (agent === 'claude' ? project?.model || null : null), source };
  };
  let r;
  if (task.agent || task.model) r = pick(task.agent, task.model, 'task');
  else {
    const hit = (scope) => routes.find((x) => (scope === 'project' ? x.project_id != null && x.project_id === project?.id : x.project_id == null)
      && routeMatches(x.match, task));
    const route = hit('project') || hit('global');
    r = route ? { ...pick(route.agent, route.model, route.project_id == null ? 'global' : 'project'), routeId: route.id }
      : { agent: 'claude', model: project?.model || null, source: 'default' };
  }
  const ok = r.agent === 'claude' || isAvailable(r.agent);
  if (ok !== true) return { agent: 'claude', model: project?.model || null, source: r.source, fellBack: r.agent, reason: typeof ok === 'string' ? ok : 'not available' };
  return r;
}

// Accepts an epoch (seconds), an ISO timestamp, or everyday phrasing ("tomorrow 6pm", "in 3 days").
function parseDeadline(value, base = new Date()) {
  if (value == null || value === '' || value === 'null' || value === false) return null;
  if (typeof value === 'number') return value > 1e12 ? value / 1000 : value;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const t = Date.parse(text.replace('Z', ''));
    if (Number.isFinite(t)) return t / 1000;
  }
  const rel = text.match(/in\s+(\d+)\s*(hour|hr|day|week)s?/i);
  if (rel) {
    const hours = { hour: 1, hr: 1, day: 24, week: 168 }[rel[2].toLowerCase()] * parseInt(rel[1], 10);
    return base.getTime() / 1000 + hours * 3600;
  }
  const day = text.match(/\b(today|tonight|tomorrow)\b/i);
  if (day) {
    const d = new Date(base);
    if (day[1].toLowerCase() === 'tomorrow') d.setDate(d.getDate() + 1);
    let hour = 23, minute = 59;
    const t = text.slice(day.index + day[0].length).match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    if (t) {
      hour = parseInt(t[1], 10);
      if (t[3]) hour = (hour % 12) + (t[3].toLowerCase() === 'pm' ? 12 : 0);
      hour = Math.min(23, hour);
      minute = parseInt(t[2] || '0', 10);
    }
    d.setHours(hour, minute, 0, 0);
    return d.getTime() / 1000;
  }
  return null;
}

function resolveAfter(after, batchIds) {
  if (after == null) return null;
  const n = parseInt(String(after).trim().replace(/^#/, ''), 10);
  if (!Number.isFinite(n)) return null;
  if (n >= 0 && n < batchIds.length) return batchIds[n];
  return n > 0 ? n : null;
}

// Only ever returns a command when the done_when text clearly names one; anything ambiguous or
// risky returns null, because a false positive means running something unattended.
const RUNNERS = ['python3', 'python', 'pytest', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'make', 'cargo', 'go', 'uv', 'bun', 'deno', './'];
// A single-backtick snippet counts as a command only if it starts like one; `server.mjs` or `loggedIn` don't.
const CMD_START = /^(!|test\s|\[\s|grep\b|node\b|npm\b|bash\b|sh\s|curl\b|python)/;
const looksLikeCommand = (s) => RUNNERS.some((r) => s.startsWith(r)) || CMD_START.test(s);
export function extractCommand(doneWhen) {
  if (!doneWhen) return null;
  const triple = doneWhen.match(/```(?:\w+\n)?([\s\S]*?)```/);
  if (triple) return checkCommand(triple[1], doneWhen);
  const singles = [...doneWhen.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim().replace(/^\$\s+/, '')).filter(looksLikeCommand);
  if (singles.length) {
    // Every command-like snippet must be safe; dropping one silently would weaken the check.
    const cmds = singles.map((c) => checkCommand(c, doneWhen));
    if (cmds.some((c) => !c)) return null;
    return cmds.length === 1 ? cmds[0] : cmds.map((c) => (/;/.test(c) ? `{ ${c}; }` : c)).join(' && ');
  }
  if (/`/.test(doneWhen)) return null;
  for (let line of doneWhen.split('\n')) {
    line = line.trim().replace(/^\$\s+/, '');
    if (RUNNERS.some((r) => line.startsWith(r))) return checkCommand(line, doneWhen);
  }
  return null;
}

function checkCommand(cand, doneWhen) {
  cand = cand.trim().replace(/^\$\s+/, '');
  if (!cand || />|\brm\s|\bsudo\b|\bgit\s+push\b|\bcurl\b/.test(cand)) return null;
  if ((cand.match(/;/g) || []).length + (cand.match(/&&/g) || []).length > 1) return null;
  if (!RUNNERS.some((r) => cand.startsWith(r)) && !/^(test|ls|grep|cat|git|!|\[|bash|sh)(\s|\b)/.test(cand)) return null;
  // "`grep …` prints nothing": grep exits 1 when clean, so pass only on exit 1 (matches → 0, errors → 2 still fail).
  if (/^grep\b/.test(cand) && !/[;&|]/.test(cand)) {
    const after = doneWhen.slice(doneWhen.indexOf(cand) + cand.length).replace(/^[`\s]+/, '');
    if (/^(prints|outputs|returns|shows|produces|finds|gives)\s+(nothing|no\s+(output|match|matches|results|hits|lines))\b/i.test(after)) {
      return `${cand}; test $? -eq 1`;
    }
  }
  return cand;
}

// Resolves [ok, output, exitCode]. Runs without a login shell so the orchestrator's PATH (with its
// `python` → python3 alias) is the one used. Aborting `signal` kills the check's process group; the group is
// also killed when the check exits, so anything it started in the background doesn't outlive it.
export function runCheck(command, cwd, env, timeoutSec, signal) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawn('bash', ['-c', command], { cwd, env, detached: true });
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const onAbort = () => { killGroup(); finish(false, (out || '') + '\n(aborted)', null); };
    const finish = (ok, text, code) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      resolve([ok, text.slice(-3000), code]);
    };
    const timer = setTimeout(() => { killGroup(); finish(false, (out || '') + '\n(timed out)', null); }, timeoutSec * 1000);
    child.stdout.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); });
    child.stderr.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); });
    child.on('error', (e) => finish(false, String(e), null));
    child.on('exit', killGroup); // background jobs hold stdout open, so 'close' would wait for them
    child.on('close', (code) => { killGroup(); finish(code === 0, out || (code === 0 ? '(no output)' : `exit ${code}`), code); });
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  });
}

// What's installed on this machine, so plans and checks use commands that exist here.
const TOOL_PROBES = [
  ['python3', '--version'], ['node', '--version'], ['npm', '--version'], ['pnpm', '--version'], ['yarn', '--version'],
  ['bun', '--version'], ['deno', '--version'], ['go', 'version'], ['cargo', '--version'], ['rustc', '--version'],
  ['java', '-version'], ['ruby', '--version'], ['php', '--version'], ['gcc', '--version'], ['make', '--version'],
  ['docker', '--version'], ['pip3', '--version'], ['uv', '--version'], ['pytest', '--version'], ['sqlite3', '--version'],
];
function detectEnvironment(shimDir, basePath) {
  const env = { PATH: `${shimDir}:${basePath}` };
  const have = [], missing = [];
  for (const [bin, flag] of TOOL_PROBES) {
    try {
      const out = execFileSync(bin, [flag], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
      const v = (out.match(/\d+\.\d+(\.\d+)?/) || [''])[0];
      have.push(v ? `${bin} ${v}` : bin);
    } catch (e) {
      // `java -version` prints to stderr but still succeeds; anything else means not installed.
      if (e.code === 'ENOENT') missing.push(bin); else have.push(bin);
    }
  }
  return { have, missing };
}

// ---------------------------------------------------------------- pacing (from agent-orch budget.py)

const WEEK = 7 * 86400, FIVE_H = 5 * 3600, STALE = 15 * 60;
const hrs = (s) => (s >= 3600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 60)}m`);
const pct = (f) => `${Math.round(f * 100)}%`;

export function decide(limits, t, hasUrgent) {
  const get = (type) => limits.find((l) => l.limit_type === type) || {};
  let { utilization: wU = null, resets_at: wR = null, observed_at: wO = null } = get('seven_day');
  let { utilization: fU = null, resets_at: fR = null, observed_at: fO = null } = get('five_hour');
  const notes = [];
  if (fO != null && t - fO > FIVE_H) { notes.push('5h reading too old -- disregarded'); fU = fR = null; }
  if (wO != null && t - wO > WEEK) { notes.push('weekly reading too old -- disregarded'); wU = wR = null; }
  const withNotes = (r) => [r, ...notes].join('; ');
  const wStale = wO != null && t - wO > STALE;
  const fStale = fO != null && t - fO > STALE;
  const base = { allowed: URGENCIES, concurrency: CFG.concurrency, cooldown: CFG.idleReflectCooldownSec, pushHarder: false, scarce: false };
  if (wU == null && fU == null) return { ...base, reason: withNotes('no usage data yet -- running at default pace') };

  let bgStop = 0.75, normalStop = 0.90, ahead = false, useIt = false, wRemaining = null, staleNote = null;
  if (wU != null && wR) {
    wRemaining = Math.max(0, wR - t);
    const elapsed = Math.max(0, Math.min(1, 1 - wRemaining / WEEK));
    bgStop = Math.max(0.75, elapsed + 0.10);
    normalStop = Math.max(0.90, elapsed + 0.20);
    ahead = wU > elapsed + 0.10;
    useIt = wRemaining < 12 * 3600 && 1 - wU > 0.10;
    if (useIt && wStale) { useIt = false; staleNote = 'weekly reading is stale -- not pushing on it'; }
  }
  let tier, allowed, reason;
  if (useIt) {
    tier = 'use_it'; allowed = URGENCIES;
    reason = `weekly usage at ${pct(wU)} with the reset ${hrs(wRemaining)} away -- using the leftover ${pct(1 - wU)} before it expires`;
  } else if (wU != null && wU > normalStop) {
    tier = 'normal_stop';
    if (hasUrgent) { allowed = ['urgent']; reason = `weekly usage at ${pct(wU)} -- urgent work only while it waits`; }
    else { allowed = ['urgent', 'normal']; reason = `weekly usage at ${pct(wU)} -- reserving room; nothing urgent waits, so normal work continues`; }
  } else if (wU != null && wU > bgStop) {
    tier = 'background_stop'; allowed = ['urgent', 'normal'];
    reason = `weekly usage at ${pct(wU)} -- pausing background work to protect headroom`;
  } else {
    tier = 'none'; allowed = URGENCIES;
    reason = wU == null ? 'no weekly usage data yet'
      : wRemaining != null ? `weekly usage at ${pct(wU)} with ${hrs(wRemaining)} to go, on pace`
        : `weekly usage at ${pct(wU)}, plenty of headroom`;
  }
  if (staleNote) reason += `; ${staleNote}`;
  let concurrency = CFG.concurrency, cooldown = CFG.idleReflectCooldownSec, pushHarder = useIt;
  if (useIt) { concurrency = CFG.concurrency + 1; cooldown = 300; }
  if (fU != null && fR && !useIt) {
    const remaining = Math.max(0, fR - t);
    const elapsed = Math.max(0, Math.min(1, 1 - remaining / FIVE_H));
    if (fU < elapsed - 0.15 && fStale) reason += '; 5h reading is stale -- not pushing on it';
    else if (fU < elapsed - 0.15 && !ahead) {
      if (tier !== 'normal_stop') allowed = URGENCIES;
      concurrency = CFG.concurrency + 1; cooldown = 300; pushHarder = true;
      reason = `5h window only ${pct(fU)} used with ${Math.round(remaining / 60)}m left (should be near ${pct(elapsed)}) -- pushing harder so it isn't wasted`;
    } else if (fU < elapsed - 0.15) reason += '; not pushing the 5h window harder because the week is ahead of pace';
  }
  if (fU != null && fU > 0.9) {
    concurrency = 1; pushHarder = false; cooldown = CFG.idleReflectCooldownSec;
    reason = `5h window at ${pct(fU)} -- dropping to one slot so a run isn't cut off`;
  }
  concurrency = Math.max(1, Math.min(concurrency, CFG.concurrency + 1));
  return { allowed, concurrency, cooldown, pushHarder, scarce: tier === 'background_stop' || tier === 'normal_stop', reason: withNotes(reason) };
}

function reflectCooldown(decision, streak) {
  if (decision.pushHarder) return 300;
  let c = CFG.idleReflectCooldownSec * 2 ** Math.min(Math.max(0, streak), 32);
  if (decision.scarce) c *= 4;
  return Math.floor(Math.min(CFG.maxReflectCooldownSec, c));
}

// ---------------------------------------------------------------- database

const now = () => Date.now() / 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL, convo_id TEXT,
  status TEXT NOT NULL DEFAULT 'active', priority INTEGER NOT NULL DEFAULT 50, mode TEXT NOT NULL DEFAULT 'build',
  model TEXT, perpetual INTEGER NOT NULL DEFAULT 1, autonomous INTEGER NOT NULL DEFAULT 0,
  chat_session_id TEXT, next_reflect_at REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'work', title TEXT NOT NULL,
  prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', priority INTEGER NOT NULL DEFAULT 50,
  urgency TEXT NOT NULL DEFAULT 'normal', deadline REAL, depends_on INTEGER, done_when TEXT,
  continuations INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'user', session_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, not_before REAL NOT NULL DEFAULT 0, result TEXT, last_error TEXT,
  verify_output TEXT, commit_sha TEXT, created_at REAL NOT NULL, started_at REAL, finished_at REAL);
CREATE INDEX IF NOT EXISTS idx_tasks_pick ON tasks(status, priority, created_at);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, task_id INTEGER, purpose TEXT NOT NULL, session_id TEXT, outcome TEXT,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
  num_turns INTEGER DEFAULT 0, started_at REAL NOT NULL, finished_at REAL, log_path TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, ts REAL NOT NULL, level TEXT NOT NULL, project_id INTEGER, task_id INTEGER, message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS limits (
  limit_type TEXT PRIMARY KEY, status TEXT NOT NULL, resets_at REAL, utilization REAL, observed_at REAL);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, created_at REAL NOT NULL, last_used_at REAL NOT NULL,
  task_count INTEGER NOT NULL DEFAULT 0, total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_read_tokens INTEGER NOT NULL DEFAULT 0, last_task_id INTEGER, status TEXT NOT NULL DEFAULT 'warm', retire_reason TEXT);
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY, project_id INTEGER, match TEXT NOT NULL, agent TEXT, model TEXT, note TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL);
`;

const EFFECTIVE_SQL = `(t.priority + (p.priority - 50) / 2 +
  CASE WHEN t.deadline IS NULL THEN 0
       WHEN t.deadline - :now < 21600 THEN 40
       WHEN t.deadline - :now < 86400 THEN 30
       WHEN t.deadline - :now < 259200 THEN 15
       WHEN t.deadline - :now < 604800 THEN 5 ELSE 0 END)`;

// ---------------------------------------------------------------- the orchestrator

// Exclusive per-data-dir lock holding our PID. A lock whose PID is dead (or our own) is stale and taken over.
function takeLock(file) {
  for (let i = 0; i < 3; i++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      process.on('exit', () => { try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file); } catch {} });
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
    if (pid > 0 && pid !== process.pid) {
      try { process.kill(pid, 0); return { ok: false, pid }; } catch (e) { if (e.code === 'EPERM') return { ok: false, pid }; }
    }
    fs.rmSync(file, { force: true }); // stale
  }
  return { ok: false, pid: 'unknown' };
}

export function createOrchestrator({ query, claudeBin, claudeEnv, dataDir, getLimits, onSubscription, emitChat, broadcast, convoExists, refreshUsage,
  onCommit = () => {}, projectReady = () => true }) {
  const dir = path.join(dataDir, 'orchestrator');
  const runsDir = path.join(dir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const leader = takeLock(path.join(dir, 'lock'));

  // Agents and checks get `python`/`pip` as aliases for python3/pip3 when only the latter exist,
  // without touching anything system-wide.
  const shimDir = path.join(dir, 'bin');
  fs.mkdirSync(shimDir, { recursive: true });
  const basePath = claudeEnv.PATH || process.env.PATH || '/usr/bin:/bin';
  for (const [alias, target] of [['python', 'python3'], ['pip', 'pip3']]) {
    const shim = path.join(shimDir, alias);
    try {
      execFileSync('bash', ['-c', `command -v ${alias}`], { env: { PATH: basePath }, stdio: 'ignore' });
      fs.rmSync(shim, { force: true }); // the real one exists
    } catch {
      try {
        const real = execFileSync('bash', ['-c', `command -v ${target}`], { env: { PATH: basePath }, encoding: 'utf8' }).trim();
        if (real && !fs.existsSync(shim)) fs.symlinkSync(real, shim);
      } catch {}
    }
  }
  const agentEnv = { ...claudeEnv, PATH: `${shimDir}:${basePath}` };
  const envInfo = detectEnvironment(shimDir, basePath);
  const ENVIRONMENT = `Environment (this server, ${process.platform}/${process.arch}): installed — ${envInfo.have.join(', ') || 'unknown'}` +
    (fs.existsSync(path.join(shimDir, 'python')) ? ' (`python` also runs python3)' : '') +
    (envInfo.missing.length ? `; not installed — ${envInfo.missing.join(', ')}` : '') +
    '. This is a disposable server with full access: run any command, and install whatever a task needs ' +
    '(passwordless `sudo apt-get install -y …`, npm, pip). Prefer checks that use installed tools.';
  migrateDbFile(dir);
  const db = new DatabaseSync(path.join(dir, 'agent-orch.db'));
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA);
  // Columns added after release: tasks.agent/model (explicit per-task routing), tasks.ran_agent/ran_model (what its
  // latest run used, for the UI badge), runs.agent (who made the session).
  for (const [table, col] of [['tasks', 'agent'], ['tasks', 'model'], ['tasks', 'ran_agent'], ['tasks', 'ran_model'], ['runs', 'agent']]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
  }

  const q1 = (sql, p = {}) => db.prepare(sql).get(p);
  const qa = (sql, p = {}) => db.prepare(sql).all(p);
  const run = (sql, p = {}) => db.prepare(sql).run(p);
  const kvGet = (k, d = null) => q1('SELECT value FROM kv WHERE key=:k', { k })?.value ?? d;
  const kvSet = (k, v) => run('INSERT INTO kv(key,value) VALUES(:k,:v) ON CONFLICT(key) DO UPDATE SET value=:v', { k, v: String(v) });

  const getProject = (id) => q1('SELECT * FROM projects WHERE id=:id', { id });
  const getTask = (id) => q1('SELECT * FROM tasks WHERE id=:id', { id });
  const running = new Map(); // task id -> { abort: AbortController, projectId, startedAt, runId }
  const runSubs = new Map(); // task id -> Set<ws> watching its live output

  function logEvent(message, { level = 'info', projectId = null, taskId = null } = {}) {
    run('INSERT INTO events(ts,level,project_id,task_id,message) VALUES(:ts,:l,:p,:t,:m)',
      { ts: now(), l: level, p: projectId, t: taskId, m: message });
    console.log(`[orchestrator] ${message}`);
  }

  function updateProject(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    run(`UPDATE projects SET ${keys.map((k) => `${k}=:${k}`).join(', ')} WHERE id=:id`, { ...fields, id });
    pushProject(id);
  }

  function updateTask(id, fields, onlyIfRunning = false) {
    const keys = Object.keys(fields);
    const res = run(`UPDATE tasks SET ${keys.map((k) => `${k}=:${k}`).join(', ')} WHERE id=:id${onlyIfRunning ? " AND status='running'" : ''}`,
      { ...fields, id });
    if (res.changes) pushTask(id);
    return res.changes > 0;
  }
  const requeueIfRunning = (id, fields = {}) => updateTask(id, { status: 'queued', ...fields }, true);

  function effectivePriority(task, project) {
    let eff = task.priority + Math.trunc(((project?.priority ?? 50) - 50) / 2); // matches SQLite's integer division
    if (task.deadline) {
      const h = (task.deadline - now()) / 3600;
      for (const [limit, boost] of [[6, 40], [24, 30], [72, 15], [168, 5]]) if (h < limit) { eff += boost; break; }
    }
    return eff;
  }

  function addTask(projectId, { title, prompt, kind = 'work', source = 'user', priority = null, urgency = 'normal', deadline = null, dependsOn = null, doneWhen = null, agent = null, model = null }) {
    deadline = parseDeadline(deadline);
    if (priority == null) {
      priority = kind === 'plan' ? PRIORITY.plan : kind === 'reflect' ? PRIORITY.reflect
        : urgency !== 'normal' && URGENCY[urgency] ? URGENCY[urgency] : PRIORITY[source] ?? 50;
    }
    const r = run(`INSERT INTO tasks(project_id,kind,title,prompt,priority,urgency,deadline,depends_on,done_when,source,agent,model,created_at)
      VALUES(:p,:k,:ti,:pr,:pri,:u,:d,:dep,:dw,:s,:ag,:mo,:c)`,
      { p: projectId, k: kind, ti: title, pr: prompt, pri: priority, u: urgency, d: deadline, dep: dependsOn, dw: doneWhen, s: source, ag: agent, mo: model, c: now() });
    const id = Number(r.lastInsertRowid);
    pushTask(id);
    return id;
  }

  function findDuplicate(projectId, title) {
    const key = title.trim().toLowerCase();
    return qa(`SELECT * FROM tasks WHERE project_id=:p AND status IN ('queued','running','done') AND created_at>=:since ORDER BY id DESC`,
      { p: projectId, since: now() - 86400 }).find((r) => r.title.trim().toLowerCase() === key) || null;
  }

  function listTasks(projectId, limit = 25) {
    return qa(`SELECT * FROM tasks WHERE project_id=:p ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
      CASE WHEN status IN ('running','queued') THEN -priority ELSE -id END LIMIT :n`, { p: projectId, n: limit });
  }

  const RUNNABLE = `SELECT t.*, ${EFFECTIVE_SQL} AS eff FROM tasks t JOIN projects p ON p.id=t.project_id
    WHERE t.status='queued' AND p.status='active' AND t.not_before<=:now
      AND (t.depends_on IS NULL OR EXISTS(SELECT 1 FROM tasks d WHERE d.id=t.depends_on AND d.status='done'))`;
  function runnable(allowed, exclusive, limit) {
    let sql = RUNNABLE;
    const p = { now: now(), n: limit };
    if (allowed) {
      sql += ` AND (t.urgency IN (${allowed.map((_, i) => `:u${i}`).join(',')}) OR t.urgency='urgent')`;
      allowed.forEach((u, i) => (p[`u${i}`] = u));
    }
    // Never two running tasks in one project: they'd race on the same checkout and its git commits.
    if (exclusive) sql += " AND NOT EXISTS(SELECT 1 FROM tasks r WHERE r.project_id=t.project_id AND r.status='running')";
    return qa(sql + ' ORDER BY eff DESC, (t.session_id IS NOT NULL) DESC, t.created_at ASC LIMIT :n', p);
  }
  function claimNext(allowed) {
    // Mandatory GitHub protocol: a project's work only starts once its repo exists.
    // A plan task waits while the owner's chat turn holds the planner session (AUDIT #5).
    const row = runnable(allowed, true, 25).find((r) => !(r.kind === 'plan' && planningProjects.has(r.project_id)) && projectReady(getProject(r.project_id)?.path));
    if (!row) return null;
    run("UPDATE tasks SET status='running', started_at=:t WHERE id=:id", { t: now(), id: row.id });
    pushTask(row.id);
    return getTask(row.id);
  }

  function cascadeBlock(taskId, status, reason) {
    const blocked = [];
    for (const r of qa("SELECT id FROM tasks WHERE depends_on=:id AND status IN ('queued','running')", { id: taskId })) {
      run('UPDATE tasks SET status=:s, finished_at=:f, result=:r WHERE id=:id', { s: status, f: now(), r: reason, id: r.id });
      running.get(r.id)?.abort.abort();
      pushTask(r.id);
      blocked.push(r.id, ...cascadeBlock(r.id, status, reason));
    }
    return blocked;
  }
  const blockedPrefix = (root) => `blocked: #${root} `;
  function reviveBlocked(rootId) {
    const revived = [];
    const frontier = [rootId];
    while (frontier.length) {
      const parent = frontier.pop();
      for (const r of qa("SELECT id, result FROM tasks WHERE depends_on=:p AND status IN ('failed','cancelled')", { p: parent })) {
        const res = r.result || '';
        if (res.startsWith(blockedPrefix(rootId)) || res === `cancelled with #${rootId}`) {
          run("UPDATE tasks SET status='queued', result=NULL, finished_at=NULL, attempts=0, continuations=0, not_before=0 WHERE id=:id", { id: r.id });
          pushTask(r.id);
          revived.push(r.id);
          frontier.push(r.id);
        }
      }
    }
    return revived;
  }

  function startRun(taskId, purpose, agent = 'claude') {
    const r = run('INSERT INTO runs(task_id,purpose,agent,started_at) VALUES(:t,:p,:a,:s)', { t: taskId, p: purpose, a: agent, s: now() });
    const id = Number(r.lastInsertRowid);
    const logPath = path.join(runsDir, `run-${String(id).padStart(6, '0')}.jsonl`);
    run('UPDATE runs SET log_path=:l WHERE id=:id', { l: logPath, id });
    return { runId: id, logPath };
  }
  function finishRun(runId, res) {
    run(`UPDATE runs SET session_id=:s, outcome=:o, input_tokens=:i, output_tokens=:out, cache_read_tokens=:c, num_turns=:n, finished_at=:f WHERE id=:id`, {
      s: res.sessionId, o: res.outcome, i: res.usage.input_tokens || 0, out: res.usage.output_tokens || 0,
      c: res.usage.cache_read_input_tokens || 0, n: res.numTurns || 0, f: now(), id: runId,
    });
  }
  const lastRunAgent = (taskId) => q1('SELECT agent FROM runs WHERE task_id=:t ORDER BY id DESC LIMIT 1', { t: taskId })?.agent || 'claude';
  const lastRunOutcome = (taskId) => q1('SELECT outcome FROM runs WHERE task_id=:t AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1', { t: taskId })?.outcome || null;

  // ---- warm session reuse (agent-orch sessions.py): a new task may continue a recent, healthy session
  function recordSessionUse(res, projectId, taskId) {
    if (!res.sessionId) return;
    const t = now();
    run(`INSERT INTO sessions(session_id,project_id,created_at,last_used_at,task_count,total_input_tokens,total_cache_read_tokens,last_task_id)
      VALUES(:s,:p,:t,:t,1,:i,:c,:task) ON CONFLICT(session_id) DO UPDATE SET last_used_at=:t,
      task_count=task_count+(CASE WHEN last_task_id=:task THEN 0 ELSE 1 END),
      total_input_tokens=total_input_tokens+:i, total_cache_read_tokens=total_cache_read_tokens+:c, last_task_id=:task`,
    { s: res.sessionId, p: projectId, t, i: res.usage.input_tokens || 0, c: res.usage.cache_read_input_tokens || 0, task: taskId });
    const row = q1('SELECT * FROM sessions WHERE session_id=:s', { s: res.sessionId });
    if (['error', 'timeout', 'max_turns'].includes(res.outcome)) retireSession(res.sessionId, res.outcome);
    else if (row && row.total_input_tokens + row.total_cache_read_tokens >= CFG.sessionMaxContextTokens) retireSession(res.sessionId, 'context_ceiling');
  }
  const retireSession = (s, reason) => s && run("UPDATE sessions SET status='retired', retire_reason=:r WHERE session_id=:s", { s, r: reason });
  function pickSession(task) {
    if (!CFG.reuseSessions || task.session_id) return null;
    const t = now();
    const eligible = qa("SELECT * FROM sessions WHERE project_id=:p AND status='warm' ORDER BY last_used_at DESC", { p: task.project_id }).filter((c) => {
      if (t - c.last_used_at > CFG.sessionReuseMaxIdleSec) return false;
      if (c.total_input_tokens + c.total_cache_read_tokens >= CFG.sessionMaxContextTokens) return false;
      if (c.task_count >= CFG.sessionMaxTasks) return false;
      if (['error', 'timeout', 'max_turns'].includes(lastRunOutcome(c.last_task_id))) return false;
      const last = c.last_task_id && getTask(c.last_task_id);
      return !(last && last.verify_output != null);
    });
    if (!eligible.length) return null;
    return (eligible.find((c) => task.depends_on && c.last_task_id === task.depends_on) || eligible[0]).session_id;
  }

  // ---- limits & governor
  function upsertLimit(type, status, resetsAt, utilization, observedAt = now()) {
    run(`INSERT INTO limits(limit_type,status,resets_at,utilization,observed_at) VALUES(:t,:s,:r,:u,:o)
      ON CONFLICT(limit_type) DO UPDATE SET status=:s, resets_at=COALESCE(:r, resets_at), utilization=COALESCE(:u, utilization), observed_at=:o`,
    { t: type, s: status, r: resetsAt, u: utilization, o: observedAt });
  }
  // The usage card's reading (the same numbers as Claude Code's /usage) feeds pacing.
  function syncUsageLimits() {
    for (const l of getLimits() || []) upsertLimit(l.limit_type, l.status || 'allowed', l.resets_at, l.utilization, l.observed_at);
  }
  const limitsRows = () => qa('SELECT * FROM limits');
  function blockedUntil() {
    const u = parseFloat(kvGet('blocked_until', '0')) || 0;
    return u > now() ? u : null;
  }
  function recordGovernor(res) {
    // Status and reset time only: pacing takes utilization from the verified /usage reading,
    // whose scale is known, rather than from these live events.
    for (const l of res.limits || []) { // only the Claude adapter reports these
      upsertLimit(l.rateLimitType || 'unknown', l.status || 'allowed', l.resetsAt ? Number(l.resetsAt) : null, null);
    }
    if (res.outcome === 'rate_limited') {
      let resetsAt = res.resetsAt;
      if (resetsAt) kvSet('unknown_limit_streak', 0);
      else {
        const streak = parseInt(kvGet('unknown_limit_streak', '0'), 10) || 0;
        resetsAt = now() + CFG.unknownResetBackoffSec[Math.min(streak, CFG.unknownResetBackoffSec.length - 1)];
        kvSet('unknown_limit_streak', streak + 1);
      }
      kvSet('blocked_until', resetsAt + CFG.resetBufferSec);
      kvSet('blocked_reason', res.limitType || 'usage limit');
      logEvent(`usage limit reached (${res.limitType || 'unknown'}); resuming at ${new Date((resetsAt + CFG.resetBufferSec) * 1000).toLocaleTimeString()}`, { level: 'warn' });
      pushState();
    } else if (res.outcome === 'ok') {
      kvSet('unknown_limit_streak', 0);
      if (blockedUntil()) { kvSet('blocked_until', 0); pushState(); }
    }
  }

  let decisionCache = null;
  function decision() {
    if (decisionCache && Date.now() - decisionCache.at < 30000) return decisionCache.d;
    syncUsageLimits();
    const hasUrgent = runnable(['urgent'], false, 1).length > 0;
    let d;
    try { d = decide(limitsRows(), now(), hasUrgent); }
    catch (e) { d = { allowed: URGENCIES, concurrency: CFG.concurrency, cooldown: CFG.idleReflectCooldownSec, pushHarder: false, scarce: false, reason: `pacing failed (${e.message}); running unrestricted` }; }
    if (kvGet('budget_reason') !== d.reason) { kvSet('budget_reason', d.reason); logEvent(`pacing: ${d.reason}`); }
    decisionCache = { d, at: Date.now() };
    return d;
  }

  // ---- running a coding agent (agents.mjs; Claude Code through the SDK)
  // Task drawer Output entries: public messages, commands and tool results (logged as k:'result').
  const logEntryOf = (e) => (e.k === 'tool_result' ? { ...e, k: 'result' } : e.k === 'text' || e.k === 'tool' ? e : null);

  async function runAgent({ agent = 'claude', prompt, cwd, resume, model, append, tools, autonomous, signal, timeoutSec, taskId, runId, logPath, onMessage, partial }) {
    const ac = new AbortController();
    let stopped = null;
    const onAbort = () => { stopped = stopped || 'aborted'; ac.abort(); };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = timeoutSec ? setTimeout(() => { stopped = 'timeout'; ac.abort(); }, timeoutSec * 1000) : null;
    const log = logPath ? fs.createWriteStream(logPath, { flags: 'a' }) : null;
    const writeEntry = (e) => {
      log?.write(JSON.stringify(e) + '\n');
      const subs = runSubs.get(taskId);
      if (subs?.size) {
        const msg = JSON.stringify({ t: 'orun', taskId, runId, e });
        for (const ws of subs) if (ws.readyState === 1) ws.send(msg);
      }
    };
    if (taskId) writeEntry({ k: 'start', at: now(), resumed: !!resume, agent, model: model || null });
    let res;
    try {
      res = await runAgentCli({
        agent, model, prompt, cwd, resume, systemAppend: append, autonomous, signal: ac.signal,
        onEvent: taskId ? (e) => { const l = logEntryOf(e); if (l) writeEntry(l); } : null,
        query, bin: agent === 'claude' ? claudeBin : undefined, env: agentEnv, partial, onMessage,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (stopped) res.outcome = stopped;
    if (taskId) writeEntry({ k: 'end', at: now(), outcome: res.outcome, turns: res.numTurns });
    log?.end();
    return res;
  }

  // ---- project memory (.agent-orch/)
  const memDir = (p) => path.join(p, MEM_DIR);
  function initProject(p) {
    try { migrateMemDir(p); } catch (e) { console.error('[orch] memory dir migration failed:', p, e.message); }
    fs.mkdirSync(path.join(memDir(p), 'tasks'), { recursive: true });
    for (const [name, body] of Object.entries(TEMPLATES)) {
      const f = path.join(memDir(p), name);
      if (!fs.existsSync(f)) fs.writeFileSync(f, body);
    }
  }
  const slug = (t) => (t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'task');
  const taskFile = (p, task) => path.join(memDir(p), 'tasks', `${String(task.id).padStart(4, '0')}-${slug(task.title)}.md`);
  function writeTaskSpec(p, task) {
    initProject(p);
    const f = taskFile(p, task);
    if (fs.existsSync(f)) return;
    const meta = [`- kind: ${task.kind}`, `- source: ${task.source}`, `- priority: ${task.priority} (${task.urgency})`, `- created: ${stamp(task.created_at)}`];
    if (task.deadline) meta.push(`- deadline: ${stamp(task.deadline)}`);
    if (task.depends_on) meta.push(`- starts after: #${task.depends_on}`);
    let body = `# Task #${task.id}: ${task.title}\n\n${meta.join('  \n')}\n\n## Prompt\n\n${task.prompt}\n`;
    if (task.done_when) body += `\n## Done when\n\n${task.done_when}\n`;
    fs.writeFileSync(f, body);
  }
  function recordResult(p, task, status, text) {
    writeTaskSpec(p, task);
    fs.appendFileSync(taskFile(p, task), `\n## Result — ${status} (${stamp()})\n\n${String(text || '').trim() || '(no report)'}\n`);
    if (task.kind === 'work') {
      const summary = parseStatus(text)[1] || (String(text || '').split('\n').find((l) => l.trim()) || '(no report)').slice(0, 200);
      fs.appendFileSync(path.join(memDir(p), 'JOURNAL.md'), `\n## ${stamp()} — #${task.id} ${task.title} [${status}]\n\n${summary}\n`);
    }
  }
  function recentJournal(p) {
    try { return fs.readFileSync(path.join(memDir(p), 'JOURNAL.md'), 'utf8').slice(-4000); } catch { return ''; }
  }
  function contextOverage(p) {
    try { const s = fs.statSync(path.join(memDir(p), 'CONTEXT.md')).size; return s > CFG.contextBudgetBytes ? s - CFG.contextBudgetBytes : null; } catch { return null; }
  }
  const GIT_ID = ['-c', 'user.name=agent-orch Orchestrator', '-c', 'user.email=orchestrator@agent-orch.local'];
  const execFileP = promisify(execFile);
  // Async so a slow `git add -A` or commit hook doesn't freeze HTTP/WS traffic; calls on one repo are
  // chained so concurrent finishes don't collide on .git/index.lock.
  async function git(p, args) {
    return (await execFileP('git', args, { cwd: p, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  }
  const gitChains = new Map(); // repo path -> tail promise of queued git work
  function serialGit(p, fn) {
    const next = (gitChains.get(p) || Promise.resolve()).then(fn, fn);
    const tail = next.catch(() => {});
    gitChains.set(p, tail);
    tail.then(() => { if (gitChains.get(p) === tail) gitChains.delete(p); });
    return next;
  }
  function gitCommit(p, message) {
    if (!CFG.autoCommit || !fs.existsSync(path.join(p, '.git'))) return Promise.resolve('');
    return serialGit(p, async () => {
      try {
        if (!(await git(p, ['status', '--porcelain'])).trim()) return '';
        await git(p, ['add', '-A']);
        await git(p, [...GIT_ID, 'commit', '-q', '-m', message]);
        const sha = (await git(p, ['rev-parse', '--short', 'HEAD'])).trim();
        onCommit(p, sha, message); // pushed to GitHub by the owner's protocol
        return sha;
      } catch { return ''; }
    });
  }
  function ensureGit(p) {
    if (fs.existsSync(path.join(p, '.git'))) return Promise.resolve();
    return serialGit(p, async () => {
      try {
        await git(p, ['rev-parse', '--show-toplevel']);
        return; // already inside a repository
      } catch {}
      try {
        await git(p, ['init', '-q']);
        await git(p, ['add', '-A']);
        await git(p, [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'Orchestrator: starting point']);
      } catch {}
    });
  }

  // ---- routing rules (routes table): project routes first, then global ones (project_id NULL)
  const listRoutes = (projectId) => qa('SELECT * FROM routes WHERE project_id=:p OR project_id IS NULL ORDER BY project_id IS NULL, id', { p: projectId ?? -1 });
  function applyRoute(project, r) {
    if (r.remove) {
      const res = run('DELETE FROM routes WHERE id=:id AND (project_id=:p OR project_id IS NULL)', { id: r.remove, p: project.id });
      if (res.changes) { logEvent(`route #${r.remove} removed`, { projectId: project.id }); pushRoutes(); }
      return;
    }
    const pid = r.scope === 'global' ? null : project.id;
    const same = q1('SELECT id FROM routes WHERE match=:m AND project_id IS :p', { m: r.match, p: pid });
    if (same) run('UPDATE routes SET agent=:a, model=:mo, note=:n, created_at=:t WHERE id=:id', { a: r.agent, mo: r.model, n: r.note, t: now(), id: same.id });
    else run('INSERT INTO routes(project_id,match,agent,model,note,created_at) VALUES(:p,:m,:a,:mo,:n,:t)', { p: pid, m: r.match, a: r.agent, mo: r.model, n: r.note, t: now() });
    logEvent(`route (${r.scope}): '${r.match}' → ${[r.agent, r.model].filter(Boolean).join(' / ')}`, { projectId: project.id });
    pushRoutes();
  }
  // A global route shows in every project's view.
  const pushRoutes = () => { for (const p of qa('SELECT id FROM projects')) pushProject(p.id); };
  function routeFor(task, project) {
    const r = resolveRoute(task, project, listRoutes(project.id));
    if (r.fellBack) logEvent(`${r.fellBack} is ${r.reason}; #${task.id || task.kind} runs on Claude instead`, { level: 'warn', projectId: project.id, taskId: task.id || null });
    return r;
  }
  function routesText(projectId) {
    const agents = Object.values(AGENTS).map((a) => {
      const st = a.id === 'claude' || agentStatus(a.id);
      return `  - ${a.id} (${a.label})${st === true ? '' : ` [${st.toUpperCase()}: falls back to Claude]`}: models ${a.models.join(', ')}`;
    });
    const routes = listRoutes(projectId).map((r) => `  #${r.id} [${r.project_id == null ? 'global' : 'project'}] '${r.match}' → ${[r.agent, r.model].filter(Boolean).join(' / ')}${r.note ? ` (${r.note})` : ''}`);
    return `Coding agents:\n${agents.join('\n')}\nRouting rules:\n${routes.join('\n') || '  (none: everything runs on Claude with the chat model)'}`;
  }

  // ---- queueing a planner/reflector reply
  function queuePayload(project, payload, source) {
    if (!payload) return [];
    if (payload.project) updateProject(project.id, payload.project);
    for (const r of payload.routes || []) applyRoute(project, r);
    const ids = [], batch = [];
    for (const t of payload.tasks) {
      const dup = findDuplicate(project.id, t.title);
      if (dup) { logEvent(`skipped duplicate: ${t.title} (already #${dup.id})`, { projectId: project.id }); batch.push(dup.id); continue; }
      let dependsOn = resolveAfter(t.after, batch);
      if (dependsOn != null && !getTask(dependsOn)) dependsOn = null;
      const id = addTask(project.id, { title: t.title, prompt: t.prompt, kind: 'work', source, priority: t.priority, urgency: t.urgency, deadline: t.deadline, dependsOn, doneWhen: t.done_when, agent: t.agent, model: t.model });
      writeTaskSpec(project.path, getTask(id));
      ids.push(id);
      batch.push(id);
    }
    if (ids.length) logEvent(`${source} queued ${ids.length} task(s): ${ids.map((i) => `#${i}`).join(', ')}`, { projectId: project.id });
    return ids;
  }

  // ---- chat → planner (streams into the chat like a normal Claude reply)
  function chatStreamer(convoId) {
    let acc = '', hidden = false;
    return (m) => {
      if (m.type === 'stream_event' && !m.parent_tool_use_id) {
        const e = m.event;
        if (e?.type === 'message_start') { acc = ''; hidden = false; }
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          acc += e.delta.text;
          if (hidden) return;
          if (/```(?:agent-orch|ao2)/.test(acc)) { hidden = true; return; }
          // Hold back a trailing backtick run in case it's the start of the tasks block.
          emitChat(convoId, { t: 'delta', text: e.delta.text }, { persist: false });
        }
        return;
      }
      if (m.type === 'assistant' && !m.parent_tool_use_id) {
        for (const b of m.message?.content || []) {
          if (b.type === 'text') {
            const shown = stripTasksBlock(b.text);
            if (shown) emitChat(convoId, { t: 'text', text: shown });
            else emitChat(convoId, { t: 'text_end' }, { persist: false });
          } else if (b.type === 'tool_use') emitChat(convoId, { t: 'tool_use', id: b.id, name: b.name, input: toolInputSummary(b.name, b.input) });
        }
      } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const e of AGENTS.claude.events(m)) if (e.k === 'tool_result') emitChat(convoId, { t: 'tool_result', id: e.id, text: e.text, isError: e.isError });
      }
    };
  }

  function ensureProject(convo) {
    let p = q1('SELECT * FROM projects WHERE path=:p', { p: convo.cwd });
    if (!p) {
      const r = run('INSERT INTO projects(path,name,convo_id,model,created_at) VALUES(:p,:n,:c,:m,:t)',
        { p: convo.cwd, n: path.basename(convo.cwd), c: convo.id, m: convo.model || null, t: now() });
      p = getProject(Number(r.lastInsertRowid));
      logEvent(`project added: ${p.name}`, { projectId: p.id });
    } else if (p.convo_id !== convo.id || (convo.model || null) !== p.model) {
      run('UPDATE projects SET convo_id=:c, model=:m WHERE id=:id', { c: convo.id, m: convo.model || null, id: p.id });
      p = getProject(p.id);
    }
    initProject(p.path);
    return p;
  }

  const planAborts = new Map(); // convo id -> AbortController for a planner turn in progress
  // project id -> 'chat' | 'task': who holds the planner session. Two `--resume` runs must never share it.
  const planningProjects = new Map();
  // Save a chat message for later and make sure one plan task (other than `selfId`) is waiting to answer it.
  function deferMessage(projectId, text, selfId = 0) {
    if (text != null) run("INSERT INTO messages(project_id,content,created_at) VALUES(:p,:c,:t)", { p: projectId, c: text, t: now() });
    if (!q1("SELECT 1 AS x FROM tasks WHERE project_id=:p AND kind='plan' AND status IN ('queued','running') AND id!=:s", { p: projectId, s: selfId })) {
      addTask(projectId, { title: "Answer owner's message", prompt: '(pending chat messages)', kind: 'plan', source: 'user' });
    }
  }
  async function planTurn(convo, text) {
    const project = ensureProject(convo);
    await ensureGit(project.path);
    if (project.status !== 'active') updateProject(project.id, { status: 'active' });
    // A plan task is answering saved messages on this session: queue behind it.
    if (planningProjects.get(project.id) === 'task') {
      deferMessage(project.id, text);
      emitChat(convo.id, { t: 'notice', text: 'Saved. The planner is busy answering earlier messages; it answers this right after.' });
      return;
    }
    // While limited, save the message; a plan task answers it the moment capacity returns.
    const blocked = blockedUntil();
    if (blocked) {
      deferMessage(project.id, text);
      emitChat(convo.id, { t: 'notice', text: `Saved. You're at your usage limit until ${new Date(blocked * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}; the orchestrator answers then.` });
      return;
    }
    const ac = new AbortController();
    planAborts.set(convo.id, ac);
    planningProjects.set(project.id, 'chat');
    try { await plannerRun(project, text, convo.id, ac.signal, true); }
    finally { planAborts.delete(convo.id); planningProjects.delete(project.id); }
  }
  const abortPlan = (convoId) => planAborts.get(convoId)?.abort();

  async function plannerRun(project, text, convoId, signal, fromChat = false) {
    const prompt = plannerTurnPrompt(project, listTasks(project.id, 25), text, `${ENVIRONMENT}\n${routesText(project.id)}`);
    // The planner streams Claude messages into the chat, so a 'plan' route can only change its Claude model.
    const route = resolveRoute({ kind: 'plan', title: '' }, project, listRoutes(project.id), () => true);
    const attempt = (resume) => runAgent({
      prompt, cwd: project.path, resume, model: route.agent === 'claude' ? route.model : project.model, append: resume ? null : PLANNER_SYSTEM,
      tools: PLANNER_TOOLS, autonomous: false, signal, timeoutSec: 30 * 60, partial: !!convoId,
      onMessage: convoId ? chatStreamer(convoId) : null,
    });
    let res = await attempt(project.chat_session_id);
    if (res.outcome === 'error' && project.chat_session_id && /no conversation found/i.test(res.text + res.stderr)) {
      updateProject(project.id, { chat_session_id: null });
      res = await attempt(null);
    }
    recordGovernor(res);
    if (res.sessionId && ['ok', 'max_turns'].includes(res.outcome)) updateProject(project.id, { chat_session_id: res.sessionId });
    if (!['ok'].includes(res.outcome)) {
      if (convoId) {
        const why = res.outcome === 'rate_limited' ? 'You hit your usage limit. The message is saved and will be answered after the reset.'
          : res.outcome === 'aborted' ? 'Stopped.' : `The planner couldn't finish (${res.outcome}). ${String(res.stderr || res.text).trim().slice(-300)}`;
        emitChat(convoId, { t: res.outcome === 'aborted' ? 'notice' : 'error', text: why });
        // A plan task's messages are still pending and the task itself is requeued.
        if (res.outcome === 'rate_limited' && fromChat) deferMessage(project.id, text);
      }
      return { res, ids: [] };
    }
    const [, payload] = extractTasks(res.text);
    const ids = queuePayload(getProject(project.id), payload, 'planner');
    if (convoId && ids.length) emitChat(convoId, { t: 'tasks', ids, source: 'planner' });
    return { res, ids };
  }

  // ---- the scheduler (agent-orch's daemon, as timers inside this process)
  let ticking = false;
  async function tick() {
    if (ticking || !leader.ok) return;
    ticking = true;
    try {
      if (kvGet('paused_all') === '1') return;
      if (blockedUntil()) return;
      if (!onSubscription()) {
        if (kvGet('announced_auth') !== '1') { kvSet('announced_auth', 1); logEvent('waiting: Claude Code is not signed in with the subscription', { level: 'warn' }); }
        return;
      }
      kvSet('announced_auth', 0);
      const d = decision();
      considerPreemption(d);
      while (running.size < d.concurrency) {
        const task = claimNext(d.allowed);
        if (!task) { if (scheduleReflections()) continue; break; }
        startTask(task);
      }
    } catch (e) {
      console.error('[orchestrator] tick failed', e);
    } finally {
      ticking = false;
    }
  }

  function startTask(task) {
    const abort = new AbortController();
    running.set(task.id, { abort, projectId: task.project_id, startedAt: now() });
    pushState();
    execute(task, abort.signal)
      .catch((e) => console.error('[orchestrator] task crashed', e))
      .finally(() => { running.delete(task.id); pushState(); setTimeout(tick, 200); });
  }

  function scheduleReflections() {
    let added = false;
    const t = now();
    for (const p of qa("SELECT * FROM projects WHERE status='active' AND perpetual=1")) {
      if (p.next_reflect_at > t) continue;
      if (planningProjects.has(p.id)) continue; // the owner is mid-conversation with the planner
      if (!projectReady(p.path)) continue;
      if (q1("SELECT 1 AS x FROM tasks WHERE project_id=:p AND status IN ('queued','running')", { p: p.id })) continue;
      // Nothing to improve until the owner has said what the project is and some work has landed.
      if (!q1("SELECT 1 AS x FROM tasks WHERE project_id=:p AND kind='work' AND status='done' LIMIT 1", { p: p.id })) continue;
      run('UPDATE projects SET next_reflect_at=:u WHERE id=:id', { u: t + 120, id: p.id });
      const id = addTask(p.id, { title: 'Reflect: what else should be done?', prompt: '(reflection)', kind: 'reflect', source: 'reflection' });
      if (p.convo_id) emitChat(p.convo_id, { t: 'reflect', taskId: id, text: REFLECT_ASK });
      logEvent(`queue empty → reflecting (task #${id})`, { projectId: p.id, taskId: id });
      added = true;
    }
    return added;
  }

  function considerPreemption(d) {
    if (running.size < Math.max(1, d.concurrency)) return;
    const best = runnable(d.allowed, false, 1)[0];
    if (!best) return;
    const runningRows = qa(`SELECT t.*, ${EFFECTIVE_SQL} AS eff FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.status='running' ORDER BY eff ASC`, { now: now() });
    const lowest = runningRows[0];
    if (!lowest || lowest.kind === 'plan' || now() - (lowest.started_at || 0) < PREEMPT_MIN_RUNTIME) return;
    if (best.eff - lowest.eff < PREEMPT_MARGIN || best.project_id === lowest.project_id) return;
    const r = running.get(lowest.id);
    if (!r || r.preempted) return;
    r.preempted = true;
    logEvent(`⇅ pausing #${lowest.id} (${lowest.title}) for more urgent #${best.id} (${best.title})`, { projectId: lowest.project_id, taskId: lowest.id });
    r.abort.abort();
  }

  async function execute(task, signal) {
    const project = getProject(task.project_id);
    logEvent(`started #${task.id}: ${task.title}`, { projectId: project.id, taskId: task.id });
    try {
      let res;
      if (task.kind === 'plan') {
        const pending = qa("SELECT * FROM messages WHERE project_id=:p AND status='pending' ORDER BY id", { p: project.id });
        if (!pending.length) return updateTask(task.id, { status: 'done', finished_at: now(), result: 'nothing pending' });
        let text = pending.map((m) => m.content).join('\n\n');
        if (pending.length > 1) text = '(Several messages arrived while you were rate-limited:)\n\n' + text;
        planningProjects.set(project.id, 'task');
        try { res = (await plannerRun(project, text, project.convo_id && convoExists(project.convo_id) ? project.convo_id : null, signal)).res; }
        finally { if (planningProjects.get(project.id) === 'task') planningProjects.delete(project.id); }
        if (res.outcome === 'ok') {
          for (const m of pending) run("UPDATE messages SET status='done' WHERE id=:id", { id: m.id });
          // Messages the owner sent while this ran get their own turn.
          if (q1("SELECT 1 AS x FROM messages WHERE project_id=:p AND status='pending'", { p: project.id })) deferMessage(project.id, null, task.id);
        }
      } else {
        res = await runTask(task, project, signal);
      }
      await handle(getTask(task.id), getProject(project.id), res, signal);
    } catch (e) {
      logEvent(`#${task.id} crashed: ${e?.message || e}`, { level: 'error', projectId: project.id, taskId: task.id });
      const attempts = task.attempts + 1;
      if (attempts >= CFG.maxAttempts) await fail(getTask(task.id), project, 'crash', String(e?.message || e));
      else requeueIfRunning(task.id, { attempts, not_before: now() + Math.min(300 * 2 ** (attempts - 1), 3600), last_error: `[crash] ${e?.message || e}`.slice(0, 2000) });
    }
  }

  async function runTask(task, project, signal) {
    initProject(project.path);
    writeTaskSpec(project.path, task);
    const route = routeFor(task, project);
    // A session id only resumes on the agent that created it.
    let resume = task.session_id && lastRunAgent(task.id) === route.agent ? task.session_id : null, reused = false, body, system, tools, autonomous;
    if (task.kind === 'reflect') {
      const failures = qa("SELECT * FROM tasks WHERE project_id=:p AND status IN ('failed') AND finished_at>=:s ORDER BY finished_at DESC LIMIT 8",
        { p: project.id, s: now() - 7 * 86400 });
      const oc = q1(`SELECT SUM(status='done') AS done, SUM(status='failed') AS failed FROM tasks WHERE project_id=:p AND source='reflection' AND kind='work' AND finished_at>=:s`,
        { p: project.id, s: now() - 7 * 86400 }) || {};
      body = reflectPrompt(project, listTasks(project.id, 20), recentJournal(project.path), contextOverage(project.path),
        limitsRows(), decision().reason, failures, { done: oc.done || 0, failed: oc.failed || 0 }, ENVIRONMENT);
      system = REFLECT_SYSTEM;
      tools = [...PLANNER_TOOLS, ...CFG.safeTools.filter((t) => t.startsWith('Bash('))];
      autonomous = false;
    } else {
      if (!resume && route.agent === 'claude') { resume = pickSession(task); reused = !!resume; }
      body = reused ? nextTaskPrompt(task) : workerTaskPrompt(project, task, ENVIRONMENT);
      system = WORKER_SYSTEM;
      tools = CFG.safeTools;
      autonomous = !!project.autonomous;
    }
    let prompt = body;
    if (resume && !reused) {
      if (task.verify_output != null) prompt = verifyFailedPrompt(extractCommand(task.done_when) || '(the done-when check)', task.verify_output || '(no output)');
      else if (task.last_error != null) prompt = retryAfterFailure(task.attempts + 1, lastRunOutcome(task.id) || 'error', task.last_error);
      else if (task.continuations) prompt = CONTINUE;
      else prompt = RESUME;
    }
    const { runId, logPath } = startRun(task.id, task.kind, route.agent);
    updateTask(task.id, { ran_agent: route.agent, ran_model: route.model || null });
    const r = running.get(task.id);
    if (r) r.runId = runId;
    const res = await runAgent({
      agent: route.agent, prompt, cwd: project.path, resume, model: route.model, append: resume ? null : system, tools, autonomous,
      signal, timeoutSec: CFG.taskTimeoutSec, taskId: task.id, runId, logPath,
    });
    finishRun(runId, res);
    if (res.outcome === 'error' && resume && /no conversation found/i.test(res.text + res.stderr)) {
      updateTask(task.id, { session_id: null });
      res.outcome = 'aborted';
    }
    if (task.kind === 'work' && route.agent === 'claude') recordSessionUse(res, project.id, task.id);
    return res;
  }

  async function handle(task, project, res, signal) {
    if (task.kind !== 'plan') recordGovernor(res);
    const tid = task.id, pid = project.id;
    if (task.status !== 'running') return; // cancelled while it ran
    if (res.outcome === 'ok') {
      if (task.last_error != null) updateTask(tid, { last_error: null });
      if (task.kind === 'reflect') return finishReflection(task, project, res);
      if (task.kind === 'plan') return updateTask(tid, { status: 'done', finished_at: now(), result: (res.text || '').slice(0, 4000) });
      return finishWork(task, project, res, signal);
    }
    if (res.outcome === 'rate_limited') {
      requeueIfRunning(tid, { session_id: res.sessionId || task.session_id });
      const u = blockedUntil();
      return logEvent(`⏸ #${tid} hit the ${res.limitType || 'usage'} limit; resumes ${u ? new Date(u * 1000).toLocaleTimeString() : 'soon'}`, { level: 'warn', projectId: pid, taskId: tid });
    }
    if (res.outcome === 'auth_error') {
      requeueIfRunning(tid);
      kvSet('blocked_until', now() + 600);
      kvSet('blocked_reason', 'Claude Code is not signed in');
      pushState();
      return logEvent('Claude Code is not authenticated; rechecking every 10 min', { level: 'error', projectId: pid, taskId: tid });
    }
    if (res.outcome === 'aborted') {
      requeueIfRunning(tid, { session_id: res.sessionId || task.session_id, not_before: now() + 5 });
      return logEvent(`#${tid} interrupted; will continue later`, { projectId: pid, taskId: tid });
    }
    // max_turns, timeout, error: retry with bounded attempts, resuming the same session.
    const attempts = task.attempts + 1;
    const detail = String(res.text || res.stderr || res.outcome).trim();
    if (attempts >= CFG.maxAttempts) return fail(task, project, res.outcome, detail.slice(0, 500));
    const backoff = ['max_turns', 'timeout'].includes(res.outcome) ? 0 : 60 * 2 ** attempts;
    const prefix = `[${res.outcome}] `;
    requeueIfRunning(tid, { attempts, not_before: now() + backoff, session_id: res.sessionId || task.session_id, last_error: prefix + detail.slice(-(2000 - prefix.length)) });
    logEvent(`↻ #${tid} ${res.outcome} (attempt ${attempts}): ${detail.slice(0, 200)}`, { level: 'warn', projectId: pid, taskId: tid });
  }

  async function finishWork(task, project, res, signal) {
    const tid = task.id;
    const [status, note] = parseStatus(res.text);
    if (status === 'continue' && task.continuations < CFG.maxContinuations) {
      recordResult(project.path, task, `in progress (${task.continuations + 1})`, res.text);
      await gitCommit(project.path, `agent-orch #${tid} (in progress): ${task.title}`);
      requeueIfRunning(tid, { continuations: task.continuations + 1, session_id: res.sessionId || task.session_id, result: res.text });
      return logEvent(`↻ #${tid} not finished yet: ${note.slice(0, 160) || 'continuing'}`, { projectId: project.id, taskId: tid });
    }
    if (status === 'continue') return fail(task, project, 'unfinished', `still not done after ${CFG.maxContinuations} sessions: ${note}`);
    const command = extractCommand(task.done_when);
    let checked = '';
    if (command) {
      logEvent(`checking #${tid}: ${command}`, { projectId: project.id, taskId: tid });
      let ok, output, code;
      try { [ok, output, code] = await runCheck(command, project.path, agentEnv, CFG.verifyTimeoutSec, signal); }
      catch (e) { ok = false; output = `verification crashed: ${e?.message || e}`; }
      if (getTask(tid)?.status !== 'running') return;
      if (signal?.aborted) { // paused or preempted mid-check: same as an interrupted run
        requeueIfRunning(tid, { session_id: res.sessionId || task.session_id, not_before: now() + 5 });
        return logEvent(`#${tid} interrupted during its check; will continue later`, { projectId: project.id, taskId: tid });
      }
      if (!ok && code === 127 && /command not found/i.test(output)) {
        // The check names a program this machine doesn't have; the worker can't fix that, so its
        // own verification stands and the gap is logged instead of looping on it.
        logEvent(`check for #${tid} couldn't run (${output.trim().split('\n').pop()}); accepting the worker's own verification`,
          { level: 'warn', projectId: project.id, taskId: tid });
        checked = ' (check unavailable)';
      } else if (!ok) return verifyFailed(task, project, res, command, output);
      else checked = ' (check passed)';
    }
    recordResult(project.path, task, `done${checked}`, res.text);
    const sha = await gitCommit(project.path, `agent-orch #${tid}: ${task.title}`);
    if (!updateTask(tid, { status: 'done', finished_at: now(), result: res.text, session_id: res.sessionId, verify_output: null, commit_sha: sha || null }, true)) return;
    logEvent(`✔ #${tid} done${checked}: ${task.title}${sha ? ` (commit ${sha})` : ''}`, { projectId: project.id, taskId: tid });
  }

  async function verifyFailed(task, project, res, command, output) {
    const tid = task.id;
    retireSession(res.sessionId, 'verify_failed');
    if (task.continuations >= CFG.maxContinuations) {
      return fail(task, project, 'verification', `\`${command}\` still failing after ${CFG.maxContinuations} sessions:\n${output.slice(-1500)}`);
    }
    recordResult(project.path, task, `verify failed (${task.continuations + 1})`, `Command: ${command}\n\n${output}`);
    await gitCommit(project.path, `agent-orch #${tid} (in progress): ${task.title}`);
    requeueIfRunning(tid, { continuations: task.continuations + 1, session_id: res.sessionId || task.session_id, result: res.text, verify_output: output });
    logEvent(`↻ #${tid} done-when check failed: ${command}\n${output.slice(0, 300)}`, { projectId: project.id, taskId: tid });
  }

  async function fail(task, project, outcome, detail) {
    const tid = task.id;
    if (!updateTask(tid, { status: 'failed', attempts: task.attempts + 1, finished_at: now(), result: detail }, true)) return;
    if (task.kind === 'work') {
      recordResult(project.path, task, `failed (${outcome})`, detail);
      await gitCommit(project.path, `agent-orch #${tid} failed: ${task.title} (partial work)`);
    }
    const blocked = cascadeBlock(tid, 'failed', `${blockedPrefix(tid)}(${outcome})`);
    logEvent(`✖ #${tid} failed (${outcome}): ${String(detail).slice(0, 200)}${blocked.length ? `; blocked ${blocked.map((b) => `#${b}`).join(', ')}` : ''}`,
      { level: 'error', projectId: project.id, taskId: tid });
  }

  async function finishReflection(task, project, res) {
    const [clean, payload] = extractTasks(res.text);
    const ids = queuePayload(getProject(project.id), payload, 'reflection');
    const key = `reflect_empty_streak:${project.id}`;
    const streak = ids.length ? 0 : (parseInt(kvGet(key, '0'), 10) || 0) + 1;
    kvSet(key, streak);
    const cooldown = ids.length ? 0 : reflectCooldown(decision(), streak);
    updateProject(project.id, { next_reflect_at: now() + cooldown });
    updateTask(task.id, { status: 'done', finished_at: now(), result: (clean || '').slice(0, 4000) }, true);
    await gitCommit(project.path, `agent-orch: roadmap update (reflection #${task.id})`);
    const summary = (clean || '').trim();
    if (project.convo_id && convoExists(project.convo_id)) {
      if (summary) emitChat(project.convo_id, { t: 'text', text: summary });
      if (ids.length) emitChat(project.convo_id, { t: 'tasks', ids, source: 'reflection' });
      else emitChat(project.convo_id, { t: 'notice', text: `Nothing valuable to add right now. Next look in ${Math.round(cooldown / 60)} min.` });
    }
    logEvent(ids.length ? `reflection queued ${ids.length} step(s): ${ids.map((i) => `#${i}`).join(', ')}`
      : `reflection found nothing valuable; next check in ${Math.round(cooldown / 60)} min`, { projectId: project.id, taskId: task.id });
  }

  // ---- owner actions from the task drawer
  function taskAction(id, action, value) {
    const task = getTask(id);
    if (!task) return { error: 'No such task' };
    switch (action) {
      case 'urgency': {
        if (!URGENCIES.includes(value)) return { error: 'Unknown urgency' };
        updateTask(id, { urgency: value, priority: URGENCY[value] });
        logEvent(`#${id} set to ${value}`, { projectId: task.project_id, taskId: id });
        return { ok: true };
      }
      case 'next': {
        // "Do next" is the owner speaking: it outranks everything waiting, deadlines included.
        const top = Math.max(0, ...runnable(null, false, 200).map((t) => t.eff));
        const own = effectivePriority(task, getProject(task.project_id)) - task.priority;
        updateTask(id, { priority: Math.max(task.priority, top - own + 5), urgency: 'urgent', not_before: 0 });
        logEvent(`#${id} moved to the front`, { projectId: task.project_id, taskId: id });
        setTimeout(tick, 100);
        return { ok: true };
      }
      case 'deadline': {
        if (!value) { updateTask(id, { deadline: null }); return { ok: true }; }
        const d = parseDeadline(value);
        if (!d) return { error: 'Try "tomorrow 6pm", "in 3 days" or 2026-10-01T18:00' };
        updateTask(id, { deadline: d });
        logEvent(`#${id} due ${stamp(d)}`, { projectId: task.project_id, taskId: id });
        return { ok: true };
      }
      case 'cancel': {
        if (!['queued', 'running'].includes(task.status)) return { error: 'Only waiting or running tasks can be cancelled' };
        updateTask(id, { status: 'cancelled', finished_at: now() });
        running.get(id)?.abort.abort();
        const blocked = cascadeBlock(id, 'cancelled', `cancelled with #${id}`);
        logEvent(`■ #${id} cancelled${blocked.length ? `; also ${blocked.map((b) => `#${b}`).join(', ')}` : ''}`, { projectId: task.project_id, taskId: id });
        return { ok: true };
      }
      case 'retry': {
        const res = run("UPDATE tasks SET status='queued', attempts=0, continuations=0, not_before=0, result=NULL, finished_at=NULL WHERE id=:id AND status IN ('failed','cancelled')", { id });
        if (!res.changes) return { error: 'Only failed or cancelled tasks can be retried' };
        pushTask(id);
        reviveBlocked(id);
        logEvent(`#${id} retried`, { projectId: task.project_id, taskId: id });
        setTimeout(tick, 100);
        return { ok: true };
      }
    }
    return { error: 'Unknown action' };
  }

  function projectAction(id, fields) {
    const p = getProject(id);
    if (!p) return { error: 'No such project' };
    if ('removeRoute' in fields) {
      applyRoute(p, { remove: Number(fields.removeRoute) || 0 });
      return { ok: true };
    }
    const allowed = {};
    if ('perpetual' in fields) allowed.perpetual = fields.perpetual ? 1 : 0;
    if ('autonomous' in fields) allowed.autonomous = fields.autonomous ? 1 : 0;
    if ('priority' in fields) allowed.priority = clamp(fields.priority, 0, 100, p.priority);
    if ('mode' in fields && ['build', 'maintain'].includes(fields.mode)) allowed.mode = fields.mode;
    if ('status' in fields && ['active', 'paused'].includes(fields.status)) allowed.status = fields.status;
    if (allowed.perpetual === 1 && !p.perpetual) allowed.next_reflect_at = 0;
    updateProject(id, allowed);
    if (allowed.status === 'paused') pauseProject(id);
    logEvent(`project settings: ${JSON.stringify(allowed)}`, { projectId: id });
    setTimeout(tick, 100);
    return { ok: true };
  }
  function pauseProject(id) {
    for (const [tid, r] of running) if (r.projectId === id) r.abort.abort(); // sessions are kept and resumed
  }

  // Leaving Orchestrator Mode pauses the project's background work; returning resumes it.
  function setConvoMode(convo, mode) {
    const p = q1('SELECT * FROM projects WHERE path=:p', { p: convo.cwd });
    if (mode === 'orchestrator') {
      const project = ensureProject(convo);
      ensureGit(project.path); // never rejects; planTurn awaits it before any task can commit
      if (project.status !== 'active') updateProject(project.id, { status: 'active' });
      return getProject(project.id);
    }
    if (p && p.convo_id === convo.id && p.status === 'active') {
      updateProject(p.id, { status: 'paused' });
      pauseProject(p.id);
    }
    return null;
  }
  function detachConvo(convoId) {
    for (const p of qa('SELECT * FROM projects WHERE convo_id=:c', { c: convoId })) {
      updateProject(p.id, { status: 'paused', convo_id: null });
      pauseProject(p.id);
    }
  }

  // ---- views for the UI
  function taskView(t) {
    if (!t) return null;
    return {
      id: t.id, project_id: t.project_id, kind: t.kind, title: t.title, status: t.status, urgency: t.urgency,
      priority: t.priority, deadline: t.deadline, depends_on: t.depends_on, attempts: t.attempts,
      continuations: t.continuations, not_before: t.not_before, source: t.source, created_at: t.created_at,
      started_at: t.started_at, finished_at: t.finished_at, commit_sha: t.commit_sha,
      agent: t.agent, model: t.model, ran_agent: t.ran_agent, ran_model: t.ran_model, has_verify_failure: t.verify_output != null,
      summary: t.status === 'done' ? parseStatus(t.result)[1] || null : t.status === 'failed' || t.status === 'cancelled' ? String(t.result || '').slice(0, 200) : null,
    };
  }
  function projectView(p) {
    if (!p) return null;
    const c = q1(`SELECT SUM(status='queued') AS queued, SUM(status='running') AS running, SUM(status='done') AS done,
      SUM(status='failed') AS failed FROM tasks WHERE project_id=:p AND kind!='plan'`, { p: p.id }) || {};
    return {
      id: p.id, name: p.name, path: p.path, convo_id: p.convo_id, status: p.status, priority: p.priority, mode: p.mode,
      perpetual: !!p.perpetual, autonomous: !!p.autonomous, next_reflect_at: p.next_reflect_at, ready: !!projectReady(p.path),
      counts: { queued: c.queued || 0, running: c.running || 0, done: c.done || 0, failed: c.failed || 0 },
      routes: listRoutes(p.id).map((r) => ({ id: r.id, scope: r.project_id == null ? 'global' : 'project', match: r.match, agent: r.agent, model: r.model, note: r.note })),
    };
  }
  function stateView() {
    const d = decisionCache?.d;
    return { blockedUntil: blockedUntil(), blockedReason: kvGet('blocked_reason'), pacing: d?.reason || kvGet('budget_reason'), slots: d?.concurrency ?? CFG.concurrency, running: running.size, subscription: onSubscription() };
  }
  function pushTask(id) {
    const t = taskView(getTask(id));
    if (!t) return;
    broadcast({ t: 'otask', task: t });
    pushProject(t.project_id);
  }
  let projectPush = new Set(), projectTimer = null;
  function pushProject(id) {
    projectPush.add(id);
    if (projectTimer) return;
    projectTimer = setTimeout(() => {
      projectTimer = null;
      for (const pid of projectPush) broadcast({ t: 'oproject', project: projectView(getProject(pid)) });
      projectPush = new Set();
    }, 50);
  }
  const pushState = () => broadcast({ t: 'ostate', state: stateView() });

  function convoSnapshot(convo) {
    const p = q1('SELECT * FROM projects WHERE path=:p', { p: convo.cwd });
    if (!p) return { project: null, tasks: [], state: stateView() };
    return { project: projectView(p), tasks: qa('SELECT * FROM tasks WHERE project_id=:p ORDER BY id DESC LIMIT 400', { p: p.id }).map(taskView), state: stateView() };
  }

  function taskDetail(id) {
    const t = getTask(id);
    if (!t) return null;
    const project = getProject(t.project_id);
    const runs = qa('SELECT * FROM runs WHERE task_id=:t ORDER BY id', { t: id }).map((r) => {
      let entries = [];
      try {
        entries = parseJsonl(fs.readFileSync(r.log_path, 'utf8')).filter((e) => e.k !== 'start' && e.k !== 'end');
      } catch {}
      if (entries.length > 1500) entries = entries.slice(-1500);
      return { id: r.id, outcome: r.outcome, started_at: r.started_at, finished_at: r.finished_at, turns: r.num_turns, output_tokens: r.output_tokens, entries };
    });
    return {
      task: { ...taskView(t), prompt: t.prompt, done_when: t.done_when, result: t.result, last_error: t.last_error, verify_output: t.verify_output, check: extractCommand(t.done_when) },
      eff: effectivePriority(t, project),
      project: projectView(project),
      dependsOn: t.depends_on ? taskView(getTask(t.depends_on)) : null,
      followers: qa('SELECT * FROM tasks WHERE depends_on=:id', { id }).map(taskView),
      events: qa('SELECT ts, level, message FROM events WHERE task_id=:id ORDER BY id DESC LIMIT 40', { id }).reverse(),
      runs,
      running: running.has(id),
    };
  }

  function watchTask(ws, taskId, on) {
    for (const set of runSubs.values()) set.delete(ws);
    if (!on || !taskId) return;
    if (!runSubs.has(taskId)) runSubs.set(taskId, new Set());
    runSubs.get(taskId).add(ws);
  }

  // ---- start (only the lock holder schedules; a second instance on the same data dir stays inert)
  if (leader.ok) {
    const orphans = run("UPDATE tasks SET status='queued' WHERE status='running'").changes;
    run("UPDATE runs SET outcome='error', finished_at=:t WHERE finished_at IS NULL", { t: now() });
    if (orphans) logEvent(`requeued ${orphans} interrupted task(s) after a restart`);
    setInterval(tick, CFG.pollMs);
    setTimeout(tick, 5000);
    // A limit that has passed: capacity is back, so refresh usage for pacing.
    setInterval(() => { if (!blockedUntil() && kvGet('blocked_until', '0') !== '0') { kvSet('blocked_until', 0); pushState(); refreshUsage?.(); } }, 15000);
  } else {
    console.warn(`[orchestrator] WARNING: data dir is locked by live process ${leader.pid} (${path.join(dir, 'lock')}); ` +
      'not requeueing or scheduling tasks in this instance');
  }

  // Work that finished after `since` (epoch seconds), newest first, for "while you were away".
  function finishedSince(since) {
    return qa(`SELECT t.id, t.title, t.status, t.kind, t.result, t.commit_sha, t.finished_at, p.name AS project, p.path
      FROM tasks t JOIN projects p ON p.id=t.project_id
      WHERE t.finished_at>:s AND t.kind='work' AND t.status IN ('done','failed') ORDER BY t.finished_at DESC LIMIT 200`, { s: since })
      .map((t) => ({ id: t.id, title: t.title, status: t.status, commit: t.commit_sha, finished_at: t.finished_at, project: t.project, path: t.path,
        summary: t.status === 'done' ? parseStatus(t.result)[1] || null : String(t.result || '').slice(0, 160) }));
  }
  function readMemory(p) {
    try { migrateMemDir(p); } catch {}
    const read = (f) => { try { return fs.readFileSync(path.join(memDir(p), f), 'utf8').slice(0, 6000); } catch { return ''; } };
    return { brief: read('BRIEF.md'), context: read('CONTEXT.md') };
  }

  return {
    finishedSince, initMemory: initProject, readMemory, refreshProjects: () => { for (const p of qa('SELECT id FROM projects')) pushProject(p.id); },
    planTurn, abortPlan, taskAction, projectAction, setConvoMode, detachConvo, convoSnapshot, taskDetail, watchTask,
    stateView, projectFor: (convo) => projectView(q1('SELECT * FROM projects WHERE path=:p', { p: convo.cwd })),
    unwatch: (ws) => { for (const set of runSubs.values()) set.delete(ws); },
  };
}
