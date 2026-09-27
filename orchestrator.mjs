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
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { AGENTS, agentEfforts, agentStatus, clampEffort, codexExhausted, codexLatestSnapshot, isMissingSession, limitScope, limitScopes, modelCatalog, modelNames, runAgentCli, toolInputSummary, windowLabel } from './agents.mjs';
import { mediaCollector } from './media.mjs';
import { createUsageLog } from './usage.mjs';
import { DELEGATE_CFG, createDelegator, parseFallbacks } from './delegate.mjs';
import { filesOverlap, parseFiles, spreadAssign, readMemInfo, taskSlots, MEM } from './parallel.mjs';
import { registerPid, withOwner } from './resources.mjs';
import { LOCAL_NODE } from './cluster.mjs';
import { MSG, graceMs, isRepoUrl } from './cluster-protocol.mjs';
import { commitAll, ensureWorktree, isMerged, listWorktrees, mergeBack, parkWorktree, removeWorktree, repoInfo, startIntegration, taskBranch, unresolvedFiles, worktreesRoot } from './worktrees.mjs';

// ---------------------------------------------------------------- config

const CFG = {
  concurrency: 2,               // pacing reference (pacing may drop work to one slot)
  parallelTasks: 1,             // work tasks at once unless the owner's setting says 2 (parallel.mjs taskSlots)
  agentSlots: 1,                // concurrent tasks per connected account (or map by agent)
  meminfo: process.env.AGENT_ORCH_MEMINFO || '/proc/meminfo', // the memory guard's source (tests point it at a fixture)
  memCheckMs: 5000,             // memory guard interval while tasks run
  memLowPauseSec: 30,           // MemAvailable under MEM.pauseBelow this long → pause the newest running task
  maxAttempts: 3,               // non-limit failures before a task is marked failed
  maxContinuations: 4,          // times a worker may say "not finished yet"
  resetBufferSec: 20,           // added after a reported reset time
  usageClearTrustSec: 900,      // a Claude limit hit this soon after /usage cleared one keeps its block until the reset
  unknownResetBackoffSec: [300, 600, 1200, 1800, 3600],
  idleReflectCooldownSec: 3600, // wait after a reflection that found nothing
  maxReflectCooldownSec: 12 * 3600,
  verifyTimeoutSec: 600,
  taskTimeoutSec: 3 * 3600,
  stopWaitMs: 20000,            // pause/handoff answer once the run has stopped, or after this long (it still applies later)
  pollMs: 3000,
  autoCommit: true,
  worktrees: true,             // work tasks in git projects run in their own worktree (worktrees.mjs) and merge back
  reuseSessions: true,
  sessionReuseMaxIdleSec: 900,
  sessionMaxContextTokens: 120000,
  sessionMaxTasks: 6,
  contextBudgetBytes: 8000,
  delegate: { ...DELEGATE_CFG }, // maxWindowPct
  // Cluster placement (BRIEF goal 11). footprint: an agent run's memory on a node, kept free above MEM.claimFloor
  // (a constant until #209 measures the per-agent p90). controllerWork: whether the controller also runs work tasks that
  // an online worker could run (default: no, it keeps its CPU/RAM for chat and the planner); the owner's kv
  // parallel_settings overrides it. offerMs: a job.offer unanswered this long counts as a reject.
  footprint: { claude: 1.2 * 1024 ** 3, codex: 0.8 * 1024 ** 3 },
  controllerWork: false,
  offerMs: 10_000,
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

export const TASKS_FORMAT = `Emit work as a fenced block exactly like this (strict JSON inside, no comments):

\`\`\`agent-orch-tasks
{"project": {"priority": 50, "mode": "build"},
 "tasks": [
   {"title": "Short imperative title",
    "prompt": "Self-contained instructions: goal, the files involved, constraints, and how to check it works.",
    "done_when": "The single observable check that proves this task is finished (a command to run, a test that passes, a file that exists with X in it).",
    "urgency": "urgent | normal | background",
    "deadline": "2026-09-19T18:00 or null",
    "after": [0],
    "files": ["src/api/users.mjs", "test/users.test.mjs", "public/css/*.css"],
    "agent": "optional: claude | codex",
    "model": "optional model id"}
 ],
 "routes": [{"match": "tests", "agent": "codex", "model": null, "scope": "project"}, {"remove": 3}]}
\`\`\`

**Break work into small, separately verifiable steps. This matters more than anything else here.**
- One deliverable per task. A task should change a handful of files and be provable by ONE check.
  Aim for 15–45 minutes of agent work. If you are tempted to write "and also", split it.
- Never emit a task like "build the app", "implement the feature end to end", or "set everything up".
- \`done_when\` must be checkable by a machine or by looking at one specific thing. No "works well".
  When a command proves it, put that command in backticks, e.g. \`npm test\`. Every command-like backticked
  snippet is run, joined with &&. Absence checks use \`! grep …\` (a bare grep exits 1 when nothing matches).
- \`after\` is for TRUE prerequisites only: tasks whose output this task needs. It is one reference or an array
  of them: the 0-based index of an earlier task in THIS block, or "#12" for an existing task id. The task starts
  only once ALL of them have finished, and cancelling or failing one cancels everything after it. Never chain
  tasks just to keep them in order: tasks already run in queue order. Omit \`after\` when nothing is needed first.
- Plan sequential chains; use \`after\` only for true prerequisites; the machine runs one task at a time.
- \`files\` (optional metadata) lists the paths or globs (\`src/**/*.css\`, \`test/\`) the task will create or modify.
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
When the owner states a lasting preference ("use codex for writing tests", "use opus for planning"), save it in \`routes\`: \`agent\` and/or \`model\`, \`scope\` "project" (default) or "global" (every
project), optional \`note\`. A new route with the same match and scope replaces the old one; \`{"remove": id}\`
deletes one. A \`plan\` route may only pick a Claude model. Unavailable agents fall back to Claude.
While a task's agent is at its usage limit, it moves down the owner's fallback list for that chat (or, for
reflection tasks, the project's list); with an empty list it waits for the reset.
A block may contain only \`routes\` (with \`"tasks": []\`).

**Review breaks.** \`{"kind": "review", "title": "Review the new data model", "after": 2}\` is a checkpoint, not work: no agent
runs it. Once the task(s) in its \`after\` finish, it waits for the owner to approve them (or request changes, which
queues a fix first), and every task that needed them waits too; later tasks in the block can also list it in \`after\`.
Add one after important, risky or direction-setting tasks (a new architecture, a UI redesign, a data migration), where
going on in the wrong direction would waste the work after it. Don't add them after routine steps.`;

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
- Queue a short first chain of steps as soon as the intent is clear — you don't need the whole plan up
  front, and you can add the next steps after these finish. Reply in one or two lines: why these steps,
  not what's in it — the owner sees the queued tasks as cards under your reply.
- Tokens are precious: don't queue speculative busywork, and don't re-read things you already know.

${TASKS_FORMAT}`;

// Absolute path, so agents working in any project can run it.
const SHOT_BIN = new URL('./bin/shot.mjs', import.meta.url).pathname;
export const SHOT_HINT = `When a task changes anything visual, capture before/after screenshots of the affected pages with
\`node ${SHOT_BIN} <url> [--full] [--mobile]\` (it saves into .agent-orch/shots/ and prints the path); every
image saved there shows up in the owner's chat. Run the app on a spare port to shoot it.`;

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

${SHOT_HINT}

Your final message is exactly one line and nothing else:
  AGENT-ORCH-STATUS: done — <max 10 words on what is now true>
  AGENT-ORCH-STATUS: continue — <max 10 words on what remains>
Do not summarise the changes or list the files you touched — the diff, the commit, and JOURNAL.md already
record that. Use \`continue\` if the task is genuinely unfinished (including when you ran out of room); the
orchestrator will give the rest back to you in a new session. Never write \`done\` for work you could not verify.`;

const REFLECT_ASK = 'Look at this project and improve it — find the most valuable next steps and queue them.';
const REFLECT_DIRECTION_MAX = 1000; // characters of the owner's reflection direction kept

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
    const deps = r.deps || (r.depends_on ? [r.depends_on] : []);
    if (deps.length) bits.push(`after ${deps.map((d) => `#${d}`).join(', ')}`);
    const files = parseFiles(r.files);
    if (files && ['queued', 'running'].includes(r.status)) bits.push(`files ${files.join(', ')}`);
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
// A task whose machine vanished continues elsewhere from its pushed branch (CLUSTER.md, Failure modes): the new agent
// gets the original task plus what the previous one left: the branch's diff stat and its last messages and tool calls.
function handoffPrompt(project, task, environment, { node, sha, stat, texts, tools }) {
  const parts = [`A previous session on the machine ${node} was interrupted (the machine disappeared), so the task moved here. ` +
    `Its work up to ${sha ? sha.slice(0, 12) : 'its last push'} is on this branch (${taskBranch(task.id)}), which you are on now. ` +
    'Its session can\'t be resumed (it lives on the other machine): read `git log` and the changes, check what is already done, then finish the task.',
  '', '## Changed so far (git diff --stat against the main branch)', stat || '(nothing pushed yet)'];
  if (texts.length) parts.push('', "## The previous agent's last messages", ...texts.map((t) => `> ${t.replace(/\n/g, '\n> ')}`));
  if (tools.length) parts.push('', '## Its last tool calls', ...tools.map((t) => `- ${t}`));
  return taskBody(task, [`Project: ${project.name} (${project.path})`, environment, '', ...parts, '']);
}
// The owner moved a running task to another agent (POST /api/orch/tasks/:id/handoff): same worktree, uncommitted
// changes and all. The new agent gets the task plus the previous session's last messages and tool calls and the
// worktree's state, and continues from there.
function ownerHandoffPrompt(project, task, environment, { from, texts, tools, status, stat, log }) {
  const parts = [`The owner moved this task to you from ${from} while it was in progress. That session was stopped; its work so far is ` +
    'in this checkout (committed and uncommitted). Continue from the current state: check what is already done, do not redo it, then finish the task.',
  '', '## git status', status || '(clean)', '', '## git diff --stat (uncommitted changes)', stat || '(none)'];
  if (log) parts.push('', '## Commits on this branch so far', log);
  if (texts.length) parts.push('', "## The previous agent's last messages", ...texts.map((t) => `> ${t.replace(/\n/g, '\n> ')}`));
  if (tools.length) parts.push('', '## Its last tool calls', ...tools.map((t) => `- ${t}`));
  return taskBody(task, [`Project: ${project.name} (${project.path})`, environment, '', ...parts, '']);
}
// A requeued task that lost its machine (and so its session) starts with a handoff prompt.
const lostHandoff = (task) => task.kind === 'work' && !task.session_id && /^\[lost\]/.test(task.last_error || '');
// "Edit · src/app.js": a tool call in one line (lane activity, handoff prompts).
const toolLine = (e) => {
  const input = e.input || {};
  const detail = input.command || input.file_path || input.pattern || input.url || input.query || input.path || input.description || '';
  return `${e.name || 'Tool'} · ${String(detail).replace(/\s+/g, ' ').slice(0, 240)}`;
};
const worktreeNote = (wt, project) => `You are in an isolated git worktree of ${project.path} (branch ${wt.branch}), so tasks running at ` +
  `the same time can't clobber your edits. Work only in ${wt.cwd}, never in ${project.path}: the orchestrator merges this branch back when you finish.`;
const nextTaskPrompt = (task) => taskBody(task, [
  'The previous task in this session is finished and closed. Drop any of its files, plans, or working state ' +
  'from your mind — this is a new, unrelated task.', '']);

const until = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
};

function reflectPrompt(project, rows, journalTail, overage, limits, reason, failures, outcomes, environment) {
  const direction = String(project.reflect_direction || '').trim();
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
${direction ? `The owner's direction for this reflection:
${direction.split('\n').map((l) => `> ${l}`).join('\n')}
Look at the project through this lens first: most of the steps you queue should serve it, and it outranks the
general order below (new features or scope included, if that's what it asks for). Still put anything genuinely
broken (failing build/tests, bugs that block the owner) first, and if nothing valuable remains in this direction,
say so and queue fewer steps rather than stretching it.

` : ''}Ask yourself: what else should be done? Consider, in rough order of value: broken things (failing
build/tests, bugs), gaps versus the brief's goals and definition of done, user-facing quality and UX,
reliability and error handling, security, performance, test coverage, documentation, and code health.

Then:
1. Rewrite .agent-orch/ROADMAP.md: a brief honest assessment, the prioritized next steps, and later ideas.
2. Queue the next 1–5 steps as small, separately verifiable tasks (\`after\` only for true prerequisites; \`files\` for each). Prefer
   finishing and hardening what exists over new scope unless the brief${direction ? ' or the direction above' : ''} asks for it. If the project truly
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
  const tasks = [], dropped = [];
  // An explicit agent paired with another agent's model keeps the agent; the model is stripped with a reason.
  const fitModel = (agent, model, what) => {
    const fam = foreignModel(agent, model);
    if (!fam) return model;
    dropped.push(`${what}: dropped model ${model} (belongs to ${fam}) for agent ${agent}`);
    return null;
  };
  for (const t of payload.tasks || []) {
    if (t && typeof t === 'object' && String(t.kind || '').toLowerCase() === 'review') {
      tasks.push({ kind: 'review', title: String(t.title || 'Review').slice(0, 200), after: t.after ?? null });
      continue;
    }
    if (!t || typeof t !== 'object' || !t.title || !t.prompt) continue;
    const u = String(t.urgency || 'normal').toLowerCase();
    tasks.push({
      title: String(t.title).slice(0, 200),
      prompt: String(t.prompt),
      done_when: t.done_when ? String(t.done_when).slice(0, 2000) : null,
      urgency: URGENCIES.includes(u) ? u : 'normal',
      deadline: parseDeadline(t.deadline),
      after: t.after ?? null,
      files: parseFiles(t.files),
      priority: t.priority != null ? clamp(t.priority, 1, 90, null) : null,
      agent: normalizeAgent(t.agent),
      model: t.model ? String(t.model).trim().slice(0, 100) || null : null,
    });
    const last = tasks[tasks.length - 1];
    last.model = fitModel(last.agent, last.model, `task '${last.title}'`);
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
    const agent = normalizeAgent(r.agent);
    if (!match) continue;
    const model = fitModel(agent, r.model ? String(r.model).trim().slice(0, 100) || null : null, `route '${match}'`);
    if (!agent && !model) continue;
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
  return [clean, { tasks, project, routes, dropped }];
}

// ---- routing: which agent/model runs a task

const AGENT_ALIASES = { claude: 'claude', 'claude-code': 'claude', codex: 'codex', openai: 'codex' };
// A known agent id (accepting aliases such as 'openai' → 'codex'), or null.
export function normalizeAgent(name) {
  const id = AGENT_ALIASES[String(name || '').trim().toLowerCase()];
  return id && AGENTS[id] ? id : null;
}
// The agent a model belongs to: the agent whose discovered list names it, else its family by name; null if unknown.
const MODEL_FAMILIES = [[/^(gpt|o\d|codex)/i, 'codex'], [/^(claude|opus|sonnet|haiku)/i, 'claude']];
function agentForModel(model) {
  if (!model) return null;
  const listed = Object.keys(AGENTS).find((id) => modelNames(id).includes(model));
  if (listed) return listed;
  const fam = MODEL_FAMILIES.find(([re]) => re.test(String(model).trim()))?.[1];
  return fam && AGENTS[fam] ? fam : null;
}
// An explicit agent paired with another agent's model keeps the agent and drops the model (null when they fit).
// The agent's own list wins when another agent's list names the same model.
const foreignModel = (agent, model) => {
  if (agent && modelNames(agent).includes(model)) return null;
  const fam = agentForModel(model);
  return agent && fam && fam !== agent ? fam : null;
};
// A model the agent's discovered list doesn't name (only judged once the list is known).
const unlistedModel = (agent, model) => { const names = modelNames(agent); return !!model && names.length > 0 && !names.includes(model); };

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
// isAvailable(id, model) returns true, or false / a reason string.
export function resolveRoute(task, project, routes = [], isAvailable = agentStatus) {
  // A model from another agent's family is dropped (`dropped` names it) in favour of the agent's default.
  const pick = (agent, model, source) => {
    const named = normalizeAgent(agent);
    let dropped = foreignModel(named, model) ? model : null;
    if (dropped) model = null;
    agent = named || agentForModel(model) || 'claude';
    if (unlistedModel(agent, model)) { dropped = model; model = null; }
    return { agent, model: model || (agent === 'claude' ? project?.model || null : null), source, ...(dropped && { dropped }) };
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
  const ok = r.agent === 'claude' || isAvailable(r.agent, r.model);
  // The fallback always runs Claude's default model, never the unavailable agent's (e.g. a codex model).
  if (ok !== true) return { agent: 'claude', model: project?.model || null, source: r.source, fellBack: r.agent, reason: typeof ok === 'string' ? ok : 'not available',
    ...(r.dropped && { dropped: r.dropped }) };
  return r;
}

// tasks.route_note: why the run didn't use the agent/model its route asked for (null when it did).
export const routeNote = (r) => [r.dropped && `model ${r.dropped} is not a ${r.fellBack || r.agent} model, used the default`,
  r.fellBack && `${r.fellBack} ${r.reason}, ran on Claude`].filter(Boolean).join('; ') || null;

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

// `after`: one reference or an array of them (the task starts once ALL are done). A number below the batch length is a
// 0-based index into this block, "#12" (or a larger number) an existing task id. Returns the task ids, deduplicated.
export function resolveAfter(after, batchIds) {
  if (after == null) return [];
  const out = [];
  for (const a of Array.isArray(after) ? after : [after]) {
    if (a == null) continue;
    const str = String(a).trim(), n = parseInt(str.replace(/^#/, ''), 10);
    if (!Number.isFinite(n)) continue;
    const id = !str.startsWith('#') && n >= 0 && n < batchIds.length ? batchIds[n] : n > 0 ? n : null;
    if (id != null && !out.includes(id)) out.push(id);
  }
  return out;
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
  // A backslash-escaped backtick (\`) stays inside the snippet: it's a literal backtick for the shell.
  const singles = [...doneWhen.matchAll(/`((?:\\.|[^`\\\n])+)`/g)].map((m) => m[1].trim().replace(/^\$\s+/, '')).filter(looksLikeCommand);
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

// ---------------------------------------------------------------- usage-limit reset

// When the current usage limit really resets (epoch s), for display. Most specific first: the rejected limit's
// own row (limit_type = blocked_reason), then the latest reset among exhausted windows (SDK 'rejected' rows and
// /usage windows at 100%), then blocked_until minus the buffer if it came from a reported reset. Otherwise only
// the backoff retry time is known: { at: blockedUntil, known: false }.
export function limitReset(limits, { reason, blockedUntil, known, bufferSec = 0, t }) {
  const live = (limits || []).filter((l) => l.resets_at && l.resets_at > t);
  const own = live.find((l) => l.limit_type === reason);
  if (own) return { at: own.resets_at, known: true };
  const hit = live.filter((l) => l.status === 'rejected' || l.utilization >= 1);
  if (hit.length) return { at: Math.max(...hit.map((l) => l.resets_at)), known: true };
  if (known) return { at: blockedUntil - bufferSec, known: true };
  return { at: blockedUntil, known: false };
}
// A Claude limit ends early when a /usage reading taken after the hit (`since`, epoch s) shows every window under
// 100%: a plan upgrade, or a reset that came sooner than reported. Returns those windows, or null (no such reading).
export function usageHeadroom(limits, since) {
  const fresh = (limits || []).filter((l) => l.utilization != null && l.observed_at > since);
  return fresh.length && fresh.every((l) => l.utilization < 1) ? fresh : null;
}
// Server-side time for log lines: includes the date and timezone, since the viewer may be elsewhere.
const fmtAt = (sec) => new Date(sec * 1000).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

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
  convoFallbacks = () => null, convoEffort = () => null, convoPersona = () => null, onCommit = () => {}, projectReady = () => true, disabled = false, usageLog = createUsageLog(dataDir),
  codexSnapshot = () => codexLatestSnapshot(), reap = null, config = {} }) {
  Object.assign(CFG, config); // tests tune slots (concurrency, parallelTasks, agentSlots, meminfo)
  const dir = path.join(dataDir, 'orchestrator');
  const runsDir = path.join(dir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  // disabled (CW_NO_ORCHESTRATOR=1): migrate and serve views, but never lock, requeue or schedule.
  const leader = disabled ? { ok: false } : takeLock(path.join(dir, 'lock'));

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
  // latest run used, for the UI badge), tasks.route_note (why that run fell back to Claude), runs.agent (who made the session).
  for (const [table, col] of [['tasks', 'agent'], ['tasks', 'model'], ['tasks', 'ran_agent'], ['tasks', 'ran_model'], ['tasks', 'route_note'], ['runs', 'agent'],
    // Cluster: the node a task last ran on (and each run's), and the last WIP sha a worker pushed for it.
    ['tasks', 'node_id'], ['tasks', 'wip_sha'], ['runs', 'node_id'],
    // Reasoning effort: tasks.effort is the owner's per-task override (drawer only; NULL = the chat's live effort), and
    // runs.effort the level a run actually started with (NULL = the agent's default). See taskEffort.
    ['tasks', 'effort'], ['runs', 'effort'],
    // tasks.handoff: JSON {agent, model, reason} of the session the owner moved the task off (POST .../handoff); its next
    // fresh session starts with ownerHandoffPrompt. Cleared once the new agent has a session of its own.
    ['tasks', 'handoff']]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
  }
  // Delegation (delegate.mjs): tasks.origin ('reflection' | 'chat' | null), tasks.category (legacy, unused),
  // tasks.delegated_from ("agent/model" it was moved off), tasks.delegated_reason and tasks.fallbacks (JSON [{agent, model}]:
  // the chat's or project's fallback list when the task was queued; NULL/[] = wait). Existing rows get an origin from source.
  if (!db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'origin')) {
    db.exec('ALTER TABLE tasks ADD COLUMN origin TEXT');
    db.exec("UPDATE tasks SET origin=CASE source WHEN 'reflection' THEN 'reflection' WHEN 'planner' THEN 'chat' END");
  }
  // tasks.moves: JSON [{at, from: {agent, model}, to: {agent, model}, until, by: 'limit' | 'owner'}], one per delegation.
  for (const col of ['category', 'delegated_from', 'delegated_reason', 'fallbacks', 'moves']) {
    if (!db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
  }
  // #153 removed Auto Delegate and model pins: a task's fallbacks snapshot alone decides whether it moves.
  for (const col of ['auto_delegate', 'pinned_model']) {
    if (db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE tasks DROP COLUMN ${col}`);
  }
  // projects.reflect_fallbacks: JSON [{agent, model}] the owner curates for reflection-queued tasks (NULL = none);
  // queuePayload snapshots it into their tasks.fallbacks.
  if (!db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'reflect_fallbacks')) db.exec('ALTER TABLE projects ADD COLUMN reflect_fallbacks TEXT');
  // projects.reflect_direction: the owner's optional steer for reflection ("polish the look and feel", "harden security");
  // NULL = the reflector decides what matters most. reflectPrompt puts it first.
  if (!db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'reflect_direction')) db.exec('ALTER TABLE projects ADD COLUMN reflect_direction TEXT');
  // tasks.worktree: the task's live git worktree (worktrees.mjs), NULL once merged or parked. tasks.integrates: the
  // 'needs_integration' task whose worktree this integrator task resolves and merges.
  if (!db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'worktree')) db.exec('ALTER TABLE tasks ADD COLUMN worktree TEXT');
  if (!db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'integrates')) db.exec('ALTER TABLE tasks ADD COLUMN integrates INTEGER');
  // Multi-dependencies (#156): task_deps(task_id, depends_on) holds every prerequisite; a task starts once ALL are done.
  // tasks.depends_on stays the first one (single-dep readers and older rows); all_deps is the union of both.
  // tasks.files: JSON [path or glob] the task will modify (parallel.mjs); NULL = everything, so it runs alone.
  db.exec(`CREATE TABLE IF NOT EXISTS task_deps (task_id INTEGER NOT NULL, depends_on INTEGER NOT NULL, PRIMARY KEY(task_id, depends_on));
    CREATE INDEX IF NOT EXISTS idx_task_deps_up ON task_deps(depends_on);
    CREATE VIEW IF NOT EXISTS all_deps AS SELECT task_id, depends_on FROM task_deps UNION SELECT id, depends_on FROM tasks WHERE depends_on IS NOT NULL;`);
  if (!db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'files')) {
    db.exec('ALTER TABLE tasks ADD COLUMN files TEXT');
    db.exec('INSERT OR IGNORE INTO task_deps(task_id, depends_on) SELECT id, depends_on FROM tasks WHERE depends_on IS NOT NULL');
  }
  // messages.task_id: the plan task that took a saved message (status 'taken'); it is 'done' once answered.
  if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'task_id')) db.exec('ALTER TABLE messages ADD COLUMN task_id INTEGER');
  // tasks.position: the owner's manual queue order within a project (lower runs first; see `runnable`). Existing rows
  // start in the order the scheduler used before: effective priority, then age.
  if (!db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'position')) {
    db.exec('ALTER TABLE tasks ADD COLUMN position REAL');
    db.exec(`UPDATE tasks SET position=(SELECT rn FROM (SELECT t.id, ROW_NUMBER() OVER (PARTITION BY t.project_id
      ORDER BY ${EFFECTIVE_SQL.replaceAll(':now', String(Date.now() / 1000))} DESC, t.created_at ASC, t.id ASC) AS rn
      FROM tasks t JOIN projects p ON p.id=t.project_id) o WHERE o.id=tasks.id)`);
  }
  // Keep improving was removed from Settings: Orchestrator Mode itself means "keep improving", so every project reflects
  // when its queue empties (projects.perpetual stays for the API). Once, turn it back on where the old toggle was off.
  if (!db.prepare("SELECT 1 FROM kv WHERE key='perpetual_always'").get()) {
    db.exec("UPDATE projects SET perpetual=1, next_reflect_at=0 WHERE perpetual=0; INSERT INTO kv(key,value) VALUES('perpetual_always','1')");
  }
  // Reflection is set per project (Settings → This project): projects.reflect_agent/reflect_model run its reflect tasks
  // (NULL = routes, else Claude); projects.reflect_fallbacks is where they, and the work they queue, move at a limit.
  // The old global kv reflect_settings is copied into every project once, then dropped.
  for (const col of ['reflect_agent', 'reflect_model']) {
    if (!db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT`);
  }
  {
    const row = db.prepare("SELECT value FROM kv WHERE key='reflect_settings'").get();
    if (row) {
      let g = {};
      try { g = JSON.parse(row.value || '{}') || {}; } catch {}
      if (g.agent) db.prepare('UPDATE projects SET reflect_agent=?, reflect_model=? WHERE reflect_agent IS NULL').run(g.agent, g.model || null);
      if (Array.isArray(g.fallbacks)) db.prepare('UPDATE projects SET reflect_fallbacks=?').run(JSON.stringify(g.fallbacks));
      db.exec("DELETE FROM kv WHERE key='reflect_settings'");
    }
  }
  // Parallel tasks: the owner no longer picks the controller's 1 or 2 slots; Settings shows what can run and caps it
  // (maxTasks). Once, an existing install that ran one at a time keeps doing so as a cap of 1.
  if (!db.prepare("SELECT 1 FROM kv WHERE key='parallel_cap_migrated'").get()) {
    const row = db.prepare("SELECT value FROM kv WHERE key='parallel_settings'").get();
    let s = {};
    try { s = JSON.parse(row?.value || '{}') || {}; } catch {}
    const existing = !!db.prepare('SELECT 1 FROM tasks LIMIT 1').get();
    if ((existing || 'parallelTasks' in s) && s.maxTasks == null && s.parallelTasks !== 2) s.maxTasks = 1;
    delete s.parallelTasks;
    db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('parallel_settings', ?)").run(JSON.stringify(s));
    db.exec("INSERT INTO kv(key,value) VALUES('parallel_cap_migrated','1')");
  }
  // projects.position: the owner's sidebar order (1 = top = highest priority; see reorderProjects). Existing rows
  // start in the order the scheduler already ranked them: priority, then age.
  if (!db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'position')) {
    db.exec('ALTER TABLE projects ADD COLUMN position REAL');
    db.exec(`UPDATE projects SET position=(SELECT rn FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY priority DESC, created_at, id) AS rn
      FROM projects) o WHERE o.id=projects.id)`);
  }

  const q1 = (sql, p = {}) => db.prepare(sql).get(p);
  const qa = (sql, p = {}) => db.prepare(sql).all(p);
  const run = (sql, p = {}) => db.prepare(sql).run(p);
  const kvGet = (k, d = null) => q1('SELECT value FROM kv WHERE key=:k', { k })?.value ?? d;
  const kvSet = (k, v) => run('INSERT INTO kv(key,value) VALUES(:k,:v) ON CONFLICT(key) DO UPDATE SET value=:v', { k, v: String(v) });

  const getProject = (id) => q1('SELECT * FROM projects WHERE id=:id', { id });
  const getTask = (id) => q1('SELECT * FROM tasks WHERE id=:id', { id });
  const running = new Map(); // task id -> { abort: AbortController, projectId, startedAt, runId, wt: runs in its own worktree }
  const taskWts = new Map(); // task id -> its worktree while it runs: { dir, cwd, branch, info, owner }
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

  // dependsOn: a task id or an array of them (all must be done first). files: [path or glob] it will modify, or null.
  function addTask(projectId, { title, prompt, kind = 'work', source = 'user', priority = null, urgency = 'normal', deadline = null, dependsOn = null, doneWhen = null, agent = null, model = null,
    origin = source === 'reflection' ? 'reflection' : null, fallbacks = null, files = null, position = null }) {
    const deps = [...new Set((Array.isArray(dependsOn) ? dependsOn : [dependsOn]).filter((d) => d != null).map(Number))];
    files = parseFiles(files);
    deadline = parseDeadline(deadline);
    if (priority == null) {
      priority = kind === 'plan' ? PRIORITY.plan : kind === 'reflect' ? PRIORITY.reflect
        : urgency !== 'normal' && URGENCY[urgency] ? URGENCY[urgency] : PRIORITY[source] ?? 50;
    }
    const pos = position ?? insertPosition(projectId, effectivePriority({ priority, deadline }, getProject(projectId)), deps);
    const r = run(`INSERT INTO tasks(project_id,kind,title,prompt,priority,urgency,deadline,depends_on,done_when,source,agent,model,origin,fallbacks,files,position,created_at)
      VALUES(:p,:k,:ti,:pr,:pri,:u,:d,:dep,:dw,:s,:ag,:mo,:or,:fb,:fi,:pos,:c)`,
      { p: projectId, k: kind, ti: title, pr: prompt, pri: priority, u: urgency, d: deadline, dep: deps[0] ?? null, dw: doneWhen, s: source, ag: agent, mo: model,
        or: origin, fb: fallbacks ? JSON.stringify(fallbacks) : null, fi: files ? JSON.stringify(files) : null, pos, c: now() });
    const id = Number(r.lastInsertRowid);
    for (const d of deps) run('INSERT OR IGNORE INTO task_deps(task_id, depends_on) VALUES(:t,:d)', { t: id, d });
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
      CASE WHEN status IN ('running','queued') THEN -priority ELSE -id END LIMIT :n`, { p: projectId, n: limit }).map((r) => ({ ...r, deps: depsOf(r.id) }));
  }

  const RUNNABLE = `SELECT t.*, ${EFFECTIVE_SQL} AS eff, p.position AS project_position FROM tasks t JOIN projects p ON p.id=t.project_id
    WHERE t.status='queued' AND t.kind!='review' AND p.status='active' AND t.not_before<=:now
      AND NOT EXISTS(SELECT 1 FROM all_deps x LEFT JOIN tasks d ON d.id=x.depends_on WHERE x.task_id=t.id AND d.status IS NOT 'done')`;
  function runnable(allowed, exclusive, limit) {
    let sql = RUNNABLE;
    const p = { now: now() };
    if (allowed) {
      sql += ` AND (t.urgency IN (${allowed.map((_, i) => `:u${i}`).join(',')}) OR t.urgency='urgent')`;
      allowed.forEach((u, i) => (p[`u${i}`] = u));
    }
    let rows = queueOrder(qa(sql, p));
    // Two tasks share a project only if both are work tasks in their own worktrees and their declared files don't
    // overlap (parallel.mjs; undeclared = everything); anything else would race on the same checkout, its commits or
    // the same lines. A waiting plan/reflect task also stops more work from starting in its project.
    if (exclusive) {
      const busy = qa("SELECT id, project_id, files FROM tasks WHERE status='running'");
      const blocked = new Set();
      rows = rows.filter((r) => {
        if (blocked.has(r.project_id)) return false;
        const others = busy.filter((b) => b.project_id === r.project_id);
        const ok = !others.length || (r.kind === 'work' && worktreeCapable(getProject(r.project_id))
          && others.every((b) => running.get(b.id)?.wt && !filesOverlap(filesOf(r), filesOf(b))));
        if (!ok && r.kind !== 'work') blocked.add(r.project_id);
        return ok;
      });
    }
    return rows.slice(0, limit);
  }

  // ---- queue order. Within a project the owner's manual `position` is the primary order and effective priority
  // (urgency, deadline, project priority) only breaks ties. Three things still go first regardless of position:
  // plan/reflect tasks and anything the owner queued directly (source 'user'), and tasks a deadline under 24 h away
  // promotes to urgent. Across projects the scheduler takes each project's head in effective-priority order
  // (only one task per project runs at a time anyway), the owner's sidebar order breaking ties. Rows need `eff`
  // (EFFECTIVE_SQL) and `project_position`.
  const goesFirst = (r) => r.kind !== 'work' || r.source === 'user' || (r.deadline != null && r.deadline - now() < 86400);
  const byPosition = (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || 0;
  const withinProject = (a, b) => goesFirst(b) - goesFirst(a) || byPosition(a, b) || b.eff - a.eff
    || (b.session_id != null) - (a.session_id != null) || a.created_at - b.created_at || a.id - b.id;
  function queueOrder(rows) {
    const groups = new Map();
    for (const r of rows) (groups.get(r.project_id) || groups.set(r.project_id, []).get(r.project_id)).push(r);
    const lists = [...groups.values()].map((g) => g.sort(withinProject));
    lists.sort((a, b) => goesFirst(b[0]) - goesFirst(a[0]) || b[0].eff - a[0].eff
      || (a[0].project_position ?? Infinity) - (b[0].project_position ?? Infinity) || a[0].created_at - b[0].created_at);
    return lists.flat();
  }
  // A project's queued tasks in manual order (the list the UI reorders).
  const queuedInOrder = (projectId) => qa("SELECT * FROM tasks WHERE project_id=:p AND status='queued' ORDER BY position IS NULL, position, id", { p: projectId });
  function renumber(rows) {
    rows.forEach((r, i) => { r.position = i + 1; run('UPDATE tasks SET position=:pos WHERE id=:id', { pos: i + 1, id: r.id }); });
    return rows;
  }
  // Where a new task lands: after its queued prerequisites, before the first queued task it outranks.
  function insertPosition(projectId, eff, dependsOn) {
    let rows = queuedInOrder(projectId).filter((r) => r.position != null);
    if (!rows.length) return (q1('SELECT MAX(position) AS m FROM tasks WHERE project_id=:p', { p: projectId })?.m ?? 0) + 1;
    const project = getProject(projectId);
    const ups = new Set(prereqIds(dependsOn));
    let i = Math.max(0, ...rows.map((r, j) => (ups.has(r.id) ? j + 1 : 0)));
    while (i < rows.length && effectivePriority(rows[i], project) >= eff) i++;
    if (i === rows.length) return rows[i - 1].position + 1;
    const prev = i ? rows[i - 1].position : rows[0].position - 1;
    if (rows[i].position - prev < 1e-6) { rows = renumber(rows); return i + 0.5; }
    return (prev + rows[i].position) / 2;
  }
  // A task's direct prerequisites (all_deps: task_deps plus the legacy depends_on), first-declared first.
  const depsOf = (id) => qa(`SELECT x.depends_on AS d FROM all_deps x JOIN tasks t ON t.id=x.task_id WHERE x.task_id=:id
    ORDER BY x.depends_on IS NOT t.depends_on, x.depends_on`, { id }).map((r) => r.d);
  // Declared files of a task row: null = everything. An integrator touches what the task it integrates declared.
  const filesOf = (t) => parseFiles(t.files) ?? (t.integrates ? parseFiles(getTask(t.integrates)?.files) : null);
  // The prerequisite graph upward from `ids` (a task id or array, inclusive) that hasn't finished yet: what must finish first.
  function prereqIds(ids) {
    const out = [], seen = new Set(), todo = (Array.isArray(ids) ? ids : [ids]).filter((i) => i != null);
    while (todo.length) {
      const t = getTask(todo.shift());
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      if (t.status !== 'done') out.push(t.id);
      todo.push(...depsOf(t.id));
    }
    return out;
  }
  // Every queued task whose prerequisites lead to `id`, in queue order: they move with it.
  const dependentIds = (id) => qa(`WITH RECURSIVE d(id) AS (SELECT task_id FROM all_deps WHERE depends_on=:id UNION SELECT x.task_id FROM all_deps x JOIN d ON x.depends_on=d.id)
    SELECT t.id FROM tasks t JOIN d ON d.id=t.id WHERE t.status='queued' ORDER BY t.position IS NULL, t.position, t.id`, { id }).map((r) => r.id);

  // Owner reorder: move a queued task and its queued dependent subtree as one block (relative order kept) to just
  // before `before` or just after `after` (queued tasks of the same project). Rejected (409) if any block member
  // would end up ahead of a queued prerequisite outside the block. One transaction; broadcasts the new order.
  function moveTask(id, { before = null, after = null } = {}) {
    const task = getTask(id);
    if (!task) return { error: 'No such task', status: 404 };
    if (task.status !== 'queued') return { error: `#${id} is ${task.status}; only queued tasks can move`, status: 409 };
    if ((before == null) === (after == null)) return { error: 'Give exactly one of before or after', status: 400 };
    const targetId = Number(before ?? after);
    const target = getTask(targetId);
    if (!target || target.project_id !== task.project_id || target.status !== 'queued') return { error: `#${targetId} is not a queued task in this project`, status: 400 };
    const blockIds = new Set([id, ...dependentIds(id)]);
    if (blockIds.has(targetId)) return { error: `#${targetId} moves with #${id}; pick a task outside its dependents`, status: 409 };
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = queuedInOrder(task.project_id);
      const block = rows.filter((r) => blockIds.has(r.id)), rest = rows.filter((r) => !blockIds.has(r.id));
      const at = rest.findIndex((r) => r.id === targetId) + (after != null ? 1 : 0);
      const order = [...rest.slice(0, at), ...block, ...rest.slice(at)];
      const index = new Map(order.map((r, i) => [r.id, i]));
      for (const r of block) {
        for (const up of prereqIds(depsOf(r.id))) {
          if (index.has(up) && index.get(up) > index.get(r.id)) {
            db.exec('ROLLBACK');
            return { error: up === id || blockIds.has(up) ? `#${r.id} can't go before #${up}, which it depends on`
              : `#${r.id} can't go before its prerequisite #${up}: #${up} must finish first`, status: 409 };
          }
        }
      }
      renumber(order);
      db.exec('COMMIT');
      const view = order.map((r) => ({ id: r.id, position: r.position }));
      broadcast({ t: 'oorder', project_id: task.project_id, order: view });
      logEvent(`#${id}${block.length > 1 ? ` (+${block.length - 1} dependent)` : ''} moved ${after != null ? 'after' : 'before'} #${targetId}`, { projectId: task.project_id, taskId: id });
      setTimeout(tick, 100);
      return { ok: true, order: view };
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  }
  // ---- project order. The owner drags projects in the sidebar; the top one matters most. Positions become 1..n and
  // priority is spread evenly from 90 (top) to 10 (bottom), so the scheduler's cross-project ranking (effective
  // priority, then position) follows the list. kv projects_ordered = '1' once the owner has set an order: from then on
  // new projects join at the bottom and the planner no longer changes project priority.
  const projectsInOrder = () => qa('SELECT * FROM projects ORDER BY position IS NULL, position, priority DESC, created_at, id');
  const rankPriority = (i, n) => (n > 1 ? Math.round(90 - (80 * i) / (n - 1)) : 90);
  const projectOrderView = (rows = projectsInOrder()) => rows.map((p) => ({ id: p.id, path: p.path, position: p.position, priority: p.priority }));
  const projectsOrdered = () => kvGet('projects_ordered') === '1';
  function applyProjectOrder(order) {
    db.exec('BEGIN IMMEDIATE');
    try {
      order.forEach((p, i) => {
        p.position = i + 1;
        p.priority = rankPriority(i, order.length);
        run('UPDATE projects SET position=:pos, priority=:pri WHERE id=:id', { pos: p.position, pri: p.priority, id: p.id });
      });
      db.exec('COMMIT');
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
    const view = projectOrderView(order);
    broadcast({ t: 'oprojects', order: view });
    for (const p of order) pushProject(p.id);
    return view;
  }
  // `ids`: project ids, top (highest priority) first. Projects left out (no sidebar chat) keep their order below them.
  function reorderProjects(ids) {
    if (!Array.isArray(ids) || !ids.length || !ids.every((x) => Number.isInteger(x) && x > 0)) return { error: 'ids must be a non-empty list of project ids', status: 400 };
    if (new Set(ids).size !== ids.length) return { error: 'ids lists a project twice', status: 400 };
    const all = projectsInOrder(), byId = new Map(all.map((p) => [p.id, p]));
    const missing = ids.find((id) => !byId.has(id));
    if (missing) return { error: `No such project #${missing}`, status: 404 };
    const listed = new Set(ids);
    const order = applyProjectOrder([...ids.map((id) => byId.get(id)), ...all.filter((p) => !listed.has(p.id))]);
    kvSet('projects_ordered', '1');
    logEvent(`project order: ${order.map((p) => `${path.basename(p.path)} (${p.priority})`).join(' > ')}`);
    setTimeout(tick, 100);
    return { ok: true, order };
  }
  // kv parallel_settings { parallelTasks: 1 | 2 (the controller's own work slots), controllerWork: bool (see
  // CFG.controllerWork), maxTasks: null | n (owner cap on work tasks across every node) }. Older shapes read as defaults.
  function parallelSettings() {
    let s = {};
    try { s = JSON.parse(kvGet('parallel_settings') || '{}') || {}; } catch {}
    return { parallelTasks: [1, 2].includes(s.parallelTasks) ? s.parallelTasks : CFG.parallelTasks,
      controllerWork: typeof s.controllerWork === 'boolean' ? s.controllerWork : CFG.controllerWork,
      maxTasks: Number.isInteger(s.maxTasks) && s.maxTasks > 0 ? s.maxTasks : null };
  }
  const slotsFor = (a) => typeof CFG.agentSlots === 'number' ? CFG.agentSlots : CFG.agentSlots[a] ?? 1;
  // Read fresh before every claim: the second slot and claiming at all depend on the memory available right now.
  function slotCount(d, mem = readMemInfo(CFG.meminfo)) {
    return taskSlots({ setting: parallelSettings().parallelTasks, mem,
      pacingLimit: d && (d.scarce || d.concurrency < CFG.concurrency) ? d.concurrency : Infinity });
  }
  function setParallelSettings(value) {
    const v = value && typeof value === 'object' ? value : {};
    let next = {};
    try { next = JSON.parse(kvGet('parallel_settings') || '{}') || {}; } catch {} // only what the owner set is stored
    if (!['parallelTasks', 'controllerWork', 'maxTasks'].some((k) => k in v)) return { error: 'Expected parallelTasks 1 or 2' };
    if ('parallelTasks' in v) { if (![1, 2].includes(v.parallelTasks)) return { error: 'Expected parallelTasks 1 or 2' }; next.parallelTasks = v.parallelTasks; }
    if ('controllerWork' in v) { if (typeof v.controllerWork !== 'boolean') return { error: 'controllerWork must be true or false' }; next.controllerWork = v.controllerWork; }
    if ('maxTasks' in v) { if (v.maxTasks !== null && !(Number.isInteger(v.maxTasks) && v.maxTasks >= 1 && v.maxTasks <= 64)) return { error: 'maxTasks must be null or 1-64' }; next.maxTasks = v.maxTasks; }
    kvSet('parallel_settings', JSON.stringify(next));
    pushState(); setTimeout(tick, 0);
    return { ok: true, state: stateView() };
  }
  // What can run right now (Settings shows it; the owner can only cap it): the controller's slots (memory-guarded; none
  // while workers are online unless controllerWork), each usable worker's max_slots, pacing's limit, the owner's cap.
  function capacityView(d = decisionCache?.d, mem = readMemInfo(CFG.meminfo)) {
    const settings = parallelSettings();
    const workers = nodesNow().filter((n) => !n.local && n.status === 'online' && n.connected && n.enabled !== false && !n.draining);
    const controller = workers.length && !settings.controllerWork ? 0 : taskSlots({ setting: settings.parallelTasks, mem });
    const pacing = d && (d.scarce || d.concurrency < CFG.concurrency) ? Math.max(1, d.concurrency) : null;
    const max = controller + workers.reduce((sum, n) => sum + (n.maxSlots || 0), 0);
    // controllerMax: what the controller takes when memory allows (controller < controllerMax: memory is holding it back).
    return { controller, controllerMax: workers.length && !settings.controllerWork ? 0 : settings.parallelTasks, workers: max - controller, max, pacing, cap: settings.maxTasks, running: workEverywhere(),
      effective: Math.min(max, pacing ?? Infinity, settings.maxTasks ?? Infinity) };
  }
  // Slots and agentSlots count the controller's own runs; each worker has its own (nodes.max_slots, headroom).
  const runningOn = (agent) => [...running.values()].filter((r) => r.agent === agent && r.node === LOCAL_NODE).length;
  // Work slots hold work, reflect and integrator tasks; plan tasks (the owner's messages) run beside them as before.
  const workRunning = () => [...running.values()].filter((r) => r.kind !== 'plan' && r.node === LOCAL_NODE).length;
  const workEverywhere = () => [...running.values()].filter((r) => r.kind !== 'plan').length;
  const listedModel = (agent, model) => !!AGENTS[agent] && (modelCatalog(agent).models || []).some((m) => m.id === model);
  // A ready task whose agent has no free slot moves to the fallback spreadAssign picked (recorded like a delegation).
  function spread(task, to) {
    const from = intendedRoute(task, getProject(task.project_id));
    const fromModel = from.model || delegator.defaultModel(from.agent), fromName = `${from.agent}/${fromModel || 'default'}`;
    updateTask(task.id, { agent: to.agent, model: to.model, session_id: null, delegated_from: task.delegated_from || fromName,
      delegated_reason: `spread: ${agentName(from.agent)} already runs ${runningOn(from.agent)} task(s)`,
      moves: addMove(task, { from: { agent: from.agent, model: fromModel }, to: { agent: to.agent, model: to.model }, until: null, by: 'spread' }) });
    logEvent(`#${task.id} spread from ${fromName} (busy) to ${to.agent}/${to.model} to run in parallel`, { projectId: task.project_id, taskId: task.id });
  }
  // ---- cluster placement (cluster.mjs hub, worker.mjs daemons; .agent-orch/CLUSTER.md). Without a hub or with no
  // worker online, every task lands on the controller exactly as before.
  let cluster = null;
  const jobs = new Map(); // task id -> the remote job in flight: { node, next (event index), check, accept, reject, event, done }
  const rejected = new Map(); // `${node}/${task}` -> until (ms): a worker that declined a task isn't asked again for a minute
  const nodeOf = (id) => running.get(id)?.node || LOCAL_NODE;
  let nodesAt = 0, nodesList = [];
  function nodesNow() {
    if (!cluster) return [];
    if (Date.now() - nodesAt > 1000) { try { nodesList = cluster.listNodes(); } catch { nodesList = []; } nodesAt = Date.now(); }
    return nodesList;
  }
  const nodeName = (id) => nodesNow().find((n) => n.id === id)?.name || id;
  // Workers that could run `agent`: connected, enabled, not draining, with the agent installed and signed in.
  const workerNodes = (agent) => nodesNow().filter((n) => !n.local && n.status === 'online' && n.connected
    && (n.inventory?.agents || []).some((a) => a.id === agent && a.installed && a.signedIn));
  const footprint = (agent) => CFG.footprint[agent] ?? CFG.footprint.claude;
  const nodeRuns = (id) => [...running.values()].filter((r) => r.node === id);
  // A worker's headroom for one more `agent` run: its last MemAvailable, less the footprint of runs placed on it since
  // that reading and of the new run. It must stay at or above the same floor the controller keeps (MEM.claimFloor).
  function headroom(n, agent) {
    const res = n.resources || {}, fresh = nodeRuns(n.id).filter((r) => r.startedAt * 1000 > (res.at || 0));
    return (res.memAvailable || 0) - fresh.reduce((sum, r) => sum + footprint(r.agent), 0) - footprint(agent);
  }
  const freeWorkers = (agent, taskId) => workerNodes(agent).filter((n) => nodeRuns(n.id).length < n.maxSlots
    && headroom(n, agent) >= MEM.claimFloor && !(rejected.get(`${n.id}/${taskId}`) > Date.now()));
  const workerSlots = (agent) => freeWorkers(agent).reduce((sum, n) => sum + n.maxSlots - nodeRuns(n.id).length, 0);
  // The project's GitHub clone URL (never with credentials), or null: remote nodes need one, and a project that is a
  // subfolder of its repo stays local (a worker checks out the whole repo). Cached for a minute.
  const repoCache = new Map();
  function remoteRepo(project) {
    const hit = repoCache.get(project.path);
    if (hit && Date.now() - hit.at < 60_000) return hit.url;
    let url = null;
    try {
      const o = { cwd: project.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'], o).trim();
      const raw = execFileSync('git', ['config', '--get', 'remote.origin.url'], o).trim().replace(/^(https:\/\/)[^@/]+@/, '$1');
      if (fs.realpathSync(top) === fs.realpathSync(project.path) && isRepoUrl(raw)) url = raw;
    } catch {}
    repoCache.set(project.path, { at: Date.now(), url });
    return url;
  }
  // Work tasks may run remotely; plan/reflect tasks, integrators (they need the controller's conflicted worktree) and
  // tasks with a live worktree here (a verify-failed or interrupted run keeps it) stay on the controller.
  const remoteCapable = (task, project) => !!cluster && task.kind === 'work' && !task.integrates && !task.worktree
    && worktreeCapable(project) && !!remoteRepo(project);
  const localAgentOk = (agent) => (agent === 'claude' ? onSubscription() : agentStatus(agent) === true && !(kvTime(`agent_auth_failed:${agent}`) > now()));
  // Where a claimed task runs: the free worker with the most headroom (the node that last ran it first), else the
  // controller when it has a free slot. While some worker could run a work task, the controller leaves it to the
  // workers (it waits for one to free up) unless the owner's controllerWork setting says otherwise. null = not now.
  function place(task, agent, { localFree, localOk, cap }) {
    if (task.kind === 'plan') return localOk ? LOCAL_NODE : null;
    if (workEverywhere() >= cap) return null;
    const remote = remoteCapable(task, getProject(task.project_id));
    if (remote) {
      const free = freeWorkers(agent, task.id).sort((a, b) => (b.id === task.node_id) - (a.id === task.node_id) || headroom(b, agent) - headroom(a, agent));
      if (free.length) return free[0].id;
    }
    if (!localOk || !localFree || !localAgentOk(agent) || slotsFor(agent) - runningOn(agent) <= 0) return null;
    if (remote && !parallelSettings().controllerWork && workerNodes(agent).length) return null;
    return LOCAL_NODE;
  }

  // Claims the next task and its node: { task, node, prevNode }. localFree: the controller has a free work slot;
  // localOk: it may claim at all (memory); cap: work tasks allowed across all nodes (owner cap, pacing).
  function claimNext(allowed, localFree = true, localOk = true, cap = Infinity) {
    // Mandatory GitHub protocol: a project's work only starts once its repo exists.
    // A plan task waits while the owner's chat turn holds the planner session (AUDIT #5).
    // A task whose agent is at its usage limit waits; others (e.g. codex-routed while Claude is limited) still run.
    // A waiting task that may be delegated moves to the owner's first fallback with usage left (delegate.mjs) and runs now.
    // Agent spreading (parallel.mjs spreadAssign): each task takes its own route while that agent has a free slot
    // (CFG.agentSlots here, plus free worker slots); one that would otherwise wait spills to its first fallback with a free slot and usage left.
    let rows = runnable(allowed, true, 25).filter((r) => !(r.kind === 'plan' && planningProjects.has(r.project_id)) && projectReady(getProject(r.project_id)?.path));
    for (const r of rows) if (waitsForLimit(r)) delegate(r);
    rows = rows.map((r) => getTask(r.id));
    const ready = rows.filter((r) => !waitsForLimit(r)).map((r) => {
      const route = routeNow(r, getProject(r.project_id)), primary = { agent: route.agent, model: route.model || delegator.defaultModel(route.agent), primary: true };
      const fallbacks = r.kind === 'work' ? (parseFallbacks(r.fallbacks) || []).filter((f) => listedModel(f.agent, f.model) && `${f.agent}/${f.model}` !== `${primary.agent}/${primary.model}`) : [];
      return { task: r, options: [primary, ...fallbacks] };
    });
    const picks = spreadAssign(ready, {
      slotsFree: (a) => Math.max(0, slotsFor(a) - runningOn(a)) + workerSlots(a),
      hasUsage: (a, m) => delegator.hasUsage(a, m),
    });
    for (const pick of picks) {
      const node = place(pick.task, pick.agent, { localFree, localOk, cap });
      if (!node) continue;
      if (pick.spilled) spread(pick.task, pick);
      const row = pick.task;
      run("UPDATE tasks SET status='running', started_at=:t, node_id=:n WHERE id=:id", { t: now(), n: node, id: row.id });
      pushTask(row.id);
      return { task: getTask(row.id), node, prevNode: row.node_id || null };
    }
    return null;
  }

  function cascadeBlock(taskId, status, reason) {
    const blocked = [];
    for (const r of qa("SELECT t.id FROM all_deps x JOIN tasks t ON t.id=x.task_id WHERE x.depends_on=:id AND t.status IN ('queued','running','paused')", { id: taskId })) {
      run('UPDATE tasks SET status=:s, finished_at=:f, result=:r WHERE id=:id', { s: status, f: now(), r: reason, id: r.id });
      running.get(r.id)?.abort.abort();
      pushTask(r.id);
      blocked.push(r.id, ...cascadeBlock(r.id, status, reason));
    }
    return blocked;
  }
  const blockedPrefix = (root) => `blocked: #${root} `;
  // An integrator that ends failed or cancelled takes the task it integrates along: the owner leaves 'needs_integration'
  // with the same status (so it can be retried), its worktree is parked on its branch and its dependents are blocked.
  function releaseOwner(integ, status, why) {
    const owner = integ.integrates ? getTask(integ.integrates) : null;
    if (owner?.status !== 'needs_integration') return;
    const result = status === 'failed' ? `integrator #${integ.id} failed: ${String(why).slice(0, 1500)}` : `cancelled with integrator #${integ.id}`;
    updateTask(owner.id, { status, finished_at: now(), result });
    const blocked = cascadeBlock(owner.id, status, status === 'failed' ? `${blockedPrefix(owner.id)}(integration)` : `cancelled with #${owner.id}`);
    logEvent(`${status === 'failed' ? '✖' : '■'} #${owner.id} ${status}: its integrator #${integ.id} ${status}${blocked.length ? `; blocked ${blocked.map((b) => `#${b}`).join(', ')}` : ''}`,
      { level: status === 'failed' ? 'error' : 'warn', projectId: owner.project_id, taskId: owner.id });
    // A running integrator's worktree is parked by execute() once it stops.
    const project = getProject(owner.project_id);
    if (!running.has(integ.id) && worktreeCapable(project)) parkTask(project, owner.id, `agent-orch #${owner.id} ${status}: ${owner.title} (partial work)`);
  }
  function reviveBlocked(rootId) {
    const revived = [];
    const frontier = [rootId];
    while (frontier.length) {
      const parent = frontier.pop();
      for (const r of qa("SELECT t.id, t.result FROM all_deps x JOIN tasks t ON t.id=x.task_id WHERE x.depends_on=:p AND t.status IN ('failed','cancelled')", { p: parent })) {
        // Only tasks blocked by a prerequisite come back, and only once no prerequisite is still down. The result names the
        // task whose failure first blocked it, which may be another prerequisite (retried earlier) or an ancestor of one.
        const cause = Number(/^(?:blocked: #(\d+) |cancelled with #(\d+)$)/.exec(r.result || '')?.slice(1).find(Boolean));
        const down = (id) => ['failed', 'cancelled'].includes(getTask(id)?.status);
        if (cause && !down(cause) && !depsOf(r.id).some(down)) {
          run("UPDATE tasks SET status='queued', result=NULL, finished_at=NULL, attempts=0, continuations=0, not_before=0 WHERE id=:id", { id: r.id });
          pushTask(r.id);
          revived.push(r.id);
          frontier.push(r.id);
        }
      }
    }
    return revived;
  }

  function startRun(taskId, purpose, agent = 'claude', node = LOCAL_NODE, effort = null) {
    const r = run('INSERT INTO runs(task_id,purpose,agent,node_id,effort,started_at) VALUES(:t,:p,:a,:n,:e,:s)', { t: taskId, p: purpose, a: agent, n: node, e: effort, s: now() });
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
  // The effort a task's run starts with, read fresh at every session boundary (start, resume, retry, handoff), never
  // snapshotted at queue time: the owner's per-task override if set, else its project chat's CURRENT effort; clamped to
  // what `route` (agent and model) accepts. null = the agent's default (and always for an agent without efforts).
  const taskEffort = (task, project, route) =>
    clampEffort(route.agent, getTask(task.id)?.effort || (project.convo_id ? convoEffort(project.convo_id) : null), route.model || null);
  const lastRunAgent = (taskId) => q1('SELECT agent FROM runs WHERE task_id=:t ORDER BY id DESC LIMIT 1', { t: taskId })?.agent || 'claude';
  // A session resumes only on the node that made it (runs before the cluster have no node: the controller's).
  const lastRunNode = (taskId) => q1('SELECT node_id FROM runs WHERE task_id=:t ORDER BY id DESC LIMIT 1', { t: taskId })?.node_id || LOCAL_NODE;
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
    const deps = depsOf(task.id);
    return (eligible.find((c) => deps.includes(c.last_task_id)) || eligible[0]).session_id;
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
  // Every agent's usage limit is independent (agents.mjs limitScope). Claude keeps the original kv keys (blocked_until,
  // blocked_known, blocked_reason); other agents use the same keys suffixed with :<agent> (blocked_until:codex).
  const limitKey = (k, scope) => (scope === 'claude' ? k : `${k}:${scope}`);
  const blockedUntilOf = (scope) => { const u = parseFloat(kvGet(limitKey('blocked_until', scope), '0')) || 0; return u > now() ? u : null; };
  const blockedUntilFor = (agent = 'claude', model) => blockedUntilOf(limitScope(agent, model));
  const blockedUntil = () => blockedUntilFor('claude');
  const agentName = (agent) => (agent === 'claude' ? 'Claude' : AGENTS[agent]?.label || agent);
  const scopeName = (scope) => agentName(scope);
  const limitName = (agent, model) => scopeName(limitScope(agent, model));
  // When `agent`'s current limit really resets, for display: { at, known, reason }, or null when it isn't blocked.
  function limitResetFor(agent = 'claude', model) {
    const scope = limitScope(agent, model), until = blockedUntilOf(scope);
    if (!until) return null;
    if (agent === 'claude') syncUsageLimits();
    const reason = kvGet(limitKey('blocked_reason', scope));
    const r = limitReset(agent === 'claude' ? limitsRows() : [], { reason, blockedUntil: until, known: kvGet(limitKey('blocked_known', scope), '0') === '1', bufferSec: CFG.resetBufferSec, t: now() });
    return { ...r, reason: reason || 'usage limit', name: scopeName(scope), notice: 'usage limit' };
  }
  // Only a Claude limit blocks Claude; a codex limit sets kv blocked_until:<scope>, and while that is in the
  // future routeFor sends the scope's tasks to Claude (or they wait if Claude is blocked too). An ok run clears only
  // its own scope's block.
  function recordGovernor(res, agent = 'claude', model) {
    // Status and reset time only: pacing takes utilization from the verified /usage reading,
    // whose scale is known, rather than from these live events.
    for (const l of res.limits || []) { // only the Claude adapter reports these
      upsertLimit(l.rateLimitType || 'unknown', l.status || 'allowed', l.resetsAt ? Number(l.resetsAt) : null, null);
    }
    const scope = limitScope(agent, model);
    const key = (k) => limitKey(k, scope);
    if (res.outcome === 'rate_limited') usageLog.limitHit(agent, res.resetsAt, res.limitType || undefined);
    else if (res.outcome === 'ok') usageLog.limitCleared(agent);
    if (res.outcome === 'rate_limited') {
      let resetsAt = res.resetsAt;
      if (resetsAt) kvSet(key('unknown_limit_streak'), 0);
      else {
        const streak = parseInt(kvGet(key('unknown_limit_streak'), '0'), 10) || 0;
        resetsAt = now() + CFG.unknownResetBackoffSec[Math.min(streak, CFG.unknownResetBackoffSec.length - 1)];
        kvSet(key('unknown_limit_streak'), streak + 1);
      }
      kvSet(key('blocked_until'), resetsAt + CFG.resetBufferSec);
      kvSet(key('blocked_known'), res.resetsAt ? 1 : 0);
      // Only /usage readings after the hit can end it early; hit again right after one did, it runs to the reset.
      if (agent === 'claude') kvSet('blocked_at', now() - kvTime('usage_cleared_at') < CFG.usageClearTrustSec ? resetsAt + CFG.resetBufferSec : now());
      // Claude's reason names its limit row (limitReset matches it); other agents' is the window's display name.
      kvSet(key('blocked_reason'), res.limitType || 'usage limit');
      if (agent !== 'claude') logEvent(`${scopeName(scope)} usage limit reached; its tasks run on Claude until ${fmtAt(resetsAt + CFG.resetBufferSec)}`, { level: 'warn' });
      else logEvent(`Claude usage limit reached (${res.limitType || 'unknown'}); ${res.resetsAt ? 'resuming' : 'reset time unknown, retrying'} at ${fmtAt(resetsAt + CFG.resetBufferSec)}`, { level: 'warn' });
      pushState();
    } else if (res.outcome === 'ok') {
      kvSet(key('unknown_limit_streak'), 0);
      if (kvGet(key('blocked_until'), '0') !== '0') { kvSet(key('blocked_until'), 0); pushState(); }
    }
  }

  // A Claude limit with headroom on a later /usage reading (reconcileCodexLimit's counterpart, run every 15 s):
  // tasks start as soon as capacity is back instead of waiting out the old reset time.
  function reconcileClaudeLimit() {
    if (!blockedUntilOf('claude')) return false;
    const free = usageHeadroom(getLimits() || [], kvTime('blocked_at'));
    if (!free) return false;
    kvSet('blocked_until', 0); kvSet('unknown_limit_streak', 0); kvSet('usage_cleared_at', now());
    usageLog.limitCleared('claude');
    decisionCache = null;
    logEvent(`Claude usage limit cleared early: /usage now shows ${free.map((l) => `${windowLabel(l.limit_type)} ${Math.round(l.utilization * 100)}%`).join(', ')}`);
    pushState();
    return true;
  }

  // A codex limit held without a reset time (e.g. an unparsed 'try again at'): the newest rollout decides at startup.
  // A usage-limit error after its last snapshot confirms the hit and gives the reset ('try again at', else the
  // exhausted window's resets_at); otherwise, with every window under 100% (or reset since), the block is dropped.
  function reconcileCodexLimit() {
    const hit = usageLog.lastLimit?.('codex');
    const unknown = (hit?.status === 'hit' && hit.resetsAt == null) || (blockedUntilFor('codex') && kvGet(limitKey('blocked_known', 'codex'), '0') !== '1');
    if (!unknown) return null;
    let s = null;
    try { s = codexSnapshot(); } catch {}
    if (!s?.windows) return null;
    const full = codexExhausted(s.windows), resetsAt = s.limit && (s.limit.resetsAt ?? full?.resetsAt);
    if (resetsAt > now()) {
      recordGovernor({ outcome: 'rate_limited', resetsAt, limitType: full?.window || null }, 'codex');
      return 'confirmed';
    }
    if (!s.windows.every((w) => w.pct < 100 || (w.resetsAt && w.resetsAt <= now()))) return null;
    kvSet(limitKey('blocked_until', 'codex'), 0);
    kvSet(limitKey('unknown_limit_streak', 'codex'), 0);
    usageLog.limitCleared('codex');
    logEvent(`Cleared a Codex usage limit with no reset time: its latest snapshot shows ${s.windows.map((w) => `${w.window} ${Math.round(w.pct)}%`).join(', ')}`);
    pushState();
    return 'cleared';
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

  // A run log writer: appends entries to the run's log and mirrors them to the task drawer (orun) and lanes (olane).
  // Local runs and remote ones (job.event from a worker) write through the same path, so the UI can't tell them apart.
  function runLog(taskId, runId, logPath) {
    const log = logPath ? fs.createWriteStream(logPath, { flags: 'a' }) : null;
    const writeEntry = (e) => {
      log?.write(JSON.stringify(e) + '\n');
      if (e.k === 'tool' && taskId) {
        const activity = toolLine(e);
        const lane = running.get(taskId);
        if (lane) lane.activity = activity;
        broadcast({ t: 'olane', taskId, activity });
      }
      const subs = runSubs.get(taskId);
      if (subs?.size) {
        const msg = JSON.stringify({ t: 'orun', taskId, runId, e });
        for (const ws of subs) if (ws.readyState === 1) ws.send(msg);
      }
    };
    writeEntry.end = () => log?.end();
    return writeEntry;
  }

  async function runAgent({ agent = 'claude', prompt, cwd, resume, model, append, tools, autonomous, signal, timeoutSec, taskId, runId, logPath, onMessage, onEvent, partial, effort }) {
    const ac = new AbortController();
    let stopped = null;
    const onAbort = () => { stopped = stopped || 'aborted'; ac.abort(); };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = timeoutSec ? setTimeout(() => { stopped = 'timeout'; ac.abort(); }, timeoutSec * 1000) : null;
    const writeEntry = runLog(taskId, runId, logPath);
    if (taskId) writeEntry({ k: 'start', at: now(), resumed: !!resume, agent, model: model || null, effort: effort || null });
    // Screenshots: tool-result images, plus new/changed files in .agent-orch/shots/ after each tool result and at the end.
    const media = taskId ? mediaCollector(dataDir, cwd) : null;
    const writeShots = () => { for (const img of media.shots()) writeEntry({ k: 'image', ...img }); };
    let res;
    try {
      res = await runAgentCli({
        agent, model, prompt, cwd, resume, systemAppend: append, autonomous, effort, signal: ac.signal,
        onEvent: taskId ? (e) => {
          onEvent?.(e);
          if (e.k === 'image') { const img = media.image(e); if (img) writeEntry({ k: 'image', ...img, tool: e.tool }); return; }
          const l = logEntryOf(e);
          if (l) writeEntry(l);
          if (e.k === 'tool_result') writeShots();
        } : onEvent,
        query, bin: agent === 'claude' ? claudeBin : undefined, partial, onMessage,
        // Ownership for resources.mjs: the task's agent tree is tagged, so it's never reaped while the task runs.
        env: taskId ? withOwner(agentEnv, 'task', taskId) : agentEnv,
        onSpawn: taskId ? ({ pid, pgid }) => registerPid({ pid, pgid, kind: 'task', id: taskId }) : undefined,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (stopped) res.outcome = stopped;
    usageLog.tokens(agent, res.usage, taskId ? 'task' : 'chat', taskId ?? null);
    usageLog.windows(agent, res.windows);
    if (taskId) writeShots();
    if (taskId) writeEntry({ k: 'end', at: now(), outcome: res.outcome, turns: res.numTurns });
    writeEntry.end();
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
    const deps = depsOf(task.id), files = parseFiles(task.files);
    if (deps.length) meta.push(`- starts after: ${deps.map((d) => `#${d}`).join(', ')}`);
    if (files) meta.push(`- files: ${files.join(', ')}`);
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
  // Commit the main tree now; only call it inside serialGit(p).
  async function commitNow(p, message) {
    try {
      const sha = await commitAll(p, message);
      if (sha) onCommit(p, sha, message); // pushed to GitHub by the owner's protocol
      return sha;
    } catch { return ''; }
  }
  function gitCommit(p, message) {
    if (!CFG.autoCommit || !fs.existsSync(path.join(p, '.git'))) return Promise.resolve('');
    return serialGit(p, () => commitNow(p, message));
  }

  // ---- worktrees (worktrees.mjs). A work task in a git project runs in <repo>/../.agent-orch-worktrees/<repo>-task-<id>;
  // the main tree (which the live server itself may be running from) only ever receives merged commits. serialGit on the
  // project path is the per-project merge lock: worktree creation, merges and cleanup all go through it.
  const worktreeCapable = (p) => !!p && CFG.worktrees && CFG.autoCommit && fs.existsSync(path.join(p.path, '.git'));
  // Acquire (create or reuse) a work task's worktree; an integrator gets the worktree of the task it integrates.
  function taskWorktree(task, project) {
    const owner = task.integrates || task.id;
    return serialGit(project.path, async () => {
      const info = await repoInfo(project.path);
      if (!info) return null;
      // A fresh worktree starts from what the main tree shows, so commit what the planner or a chat left there first.
      if (!(await listWorktrees(info.top)).some((w) => w.id === owner)) await commitNow(project.path, `agent-orch: uncommitted changes before #${task.id}`);
      const wt = { ...(await ensureWorktree(info, owner)), info, owner };
      if (task.integrates) await startIntegration(info, wt.dir);
      return wt;
    }).catch((e) => {
      logEvent(`#${task.id}: couldn't set up a worktree: ${String(e?.stderr || e?.message || e).trim().slice(0, 300)}`, { level: 'warn', projectId: project.id, taskId: task.id });
      return null;
    });
  }
  // Land a finished worktree on the main branch: commit whatever sits in the main tree, squash + rebase + fast-forward,
  // push, then drop the worktree and its branch. { sha } or { conflict: [files] } (worktree kept).
  function mergeTask(task, project, wt, message) {
    return serialGit(project.path, async () => {
      await commitNow(project.path, `agent-orch: uncommitted changes before merging #${task.id}`);
      const info = (await repoInfo(project.path)) || wt.info;
      const r = await mergeBack(info, wt.owner, message);
      if (r.conflict) return r;
      if (r.sha) onCommit(project.path, r.sha, message);
      await removeWorktree(info, wt.owner);
      run('UPDATE tasks SET worktree=NULL WHERE id=:id', { id: wt.owner });
      return r;
    });
  }
  // A failed or cancelled task: its unfinished work is committed to its branch (kept for a retry) and the checkout removed.
  function parkTask(project, id, message) {
    return serialGit(project.path, async () => {
      const info = await repoInfo(project.path);
      if (!info) return;
      await parkWorktree(info, id, message);
      run('UPDATE tasks SET worktree=NULL WHERE id=:id', { id });
      logEvent(`#${id}: worktree removed; its work stays on branch agent-orch/task-${id}`, { projectId: project.id, taskId: id });
    }).catch((e) => console.error('[orchestrator] parking worktree failed', id, e));
  }
  // At boot: worktrees of tasks that are no longer queued, running or waiting for integration are parked (merged
  // branches deleted). Those of interrupted tasks stay and are reused when the task runs again.
  async function cleanupWorktrees() {
    for (const p of qa('SELECT * FROM projects')) {
      if (!worktreeCapable(p)) continue;
      await serialGit(p.path, async () => {
        const info = await repoInfo(p.path);
        if (!info) return;
        for (const w of await listWorktrees(info.top)) {
          if (path.dirname(w.dir) !== worktreesRoot(info.top)) continue;
          const t = getTask(w.id);
          if (t && t.project_id !== p.id) continue;
          if (t && ['queued', 'running', 'paused', 'needs_integration'].includes(t.status)) continue;
          await parkWorktree(info, w.id, `agent-orch #${w.id}: unfinished work`);
          const merged = await isMerged(info, w.id);
          if (merged) await removeWorktree(info, w.id);
          if (t) run('UPDATE tasks SET worktree=NULL WHERE id=:id', { id: w.id });
          logEvent(`removed the orphaned worktree of #${w.id}${merged ? '' : ` (work kept on branch agent-orch/task-${w.id})`}`, { projectId: p.id, taskId: w.id });
        }
      }).catch((e) => console.error('[orchestrator] worktree cleanup failed', p.path, e));
    }
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
  // A non-Claude auth_error marks just that agent unusable for 10 min (kv agent_auth_failed:<id>), and a non-Claude
  // usage limit until its reset (kv blocked_until:<id>), so its routes fall back to Claude.
  const kvTime = (k) => parseFloat(kvGet(k, '0')) || 0;
  const agentAvailable = (id, model) => {
    if (kvTime(`agent_auth_failed:${id}`) > now()) return 'sign-in failed';
    const u = blockedUntilFor(id, model);
    if (u) return `usage limit until ${fmtAt(u)}`;
    const st = agentStatus(id);
    return st !== true && workerNodes(id).length ? true : st; // signed in on a worker is enough: the task runs there
  };
  // The agent/model a queued task would run on right now (no logging). Plan tasks run the planner on their own agent.
  const routeNow = (task, project) => (task.kind === 'plan' ? { agent: plannerAgent(task.agent), model: task.agent && task.agent !== 'claude' ? task.model : null }
    : resolveRoute(task, project, listRoutes(project.id), agentAvailable));
  // A task waits only while the limit scope it would run on is at its limit (routeFor never falls back onto a blocked
  // Claude). A plan task also waits while its (non-Claude) agent's sign-in recently failed.
  const waitsForLimit = (task, project) => {
    const { agent: a, model } = routeNow(task, project || getProject(task.project_id));
    return !!blockedUntilFor(a, model) || (task.kind === 'plan' && a !== 'claude' && kvTime(`agent_auth_failed:${a}`) > now());
  };
  function routeFor(task, project) {
    const r = resolveRoute(task, project, listRoutes(project.id), agentAvailable);
    if (r.dropped) logEvent(`model ${r.dropped} is not a ${r.fellBack || r.agent} model; #${task.id || task.kind} uses the agent's default model`, { level: 'warn', projectId: project.id, taskId: task.id || null });
    if (r.fellBack) logEvent(`${r.fellBack} ${/^not /.test(r.reason) ? 'is ' : ''}${r.reason}; #${task.id || task.kind} runs on Claude instead`, { level: 'warn', projectId: project.id, taskId: task.id || null });
    return r;
  }
  // ---- delegation: a work task whose agent is limited moves to its first usable fallback (tasks.fallbacks); none = it waits
  const delegator = createDelegator({
    agents: () => Object.keys(AGENTS),
    connected: (id) => (id === 'claude' ? onSubscription() : (agentStatus(id) === true || workerNodes(id).length > 0) && !(kvTime(`agent_auth_failed:${id}`) > now())),
    blockedUntil: (id, model) => blockedUntilFor(id, model),
    windows: (id) => usageLog.current?.(id) || [],
    models: (id) => modelCatalog(id).models || [],
    cfg: CFG.delegate,
  });
  // The model the task asked for, before any fallback (a blocked codex route falls back onto Claude and waits there).
  const intendedRoute = (task, project) => resolveRoute(task, project, listRoutes(project.id), () => true);
  function nextModel(task) {
    return delegator.nextModel(task, intendedRoute(task, getProject(task.project_id)));
  }
  const delegateTried = new Map(); // task id -> last attempt (s): a task with no usable fallback is rechecked once a minute
  function delegate(task) {
    if (!['work', 'reflect'].includes(task.kind || 'work') || !parseFallbacks(task.fallbacks)?.length || now() - (delegateTried.get(task.id) || 0) < 60) return false;
    delegateTried.set(task.id, now());
    const from = intendedRoute(task, getProject(task.project_id));
    const top = delegator.nextModel(task, from);
    if (!top) return false;
    const fromModel = from.model || delegator.defaultModel(from.agent), fromName = `${from.agent}/${fromModel || 'default'}`;
    const until = agentUsage(from.agent, fromModel).until || null;
    updateTask(task.id, { agent: top.agent, model: top.model, session_id: null, delegated_from: task.delegated_from || fromName, delegated_reason: top.reason,
      moves: addMove(task, { from: { agent: from.agent, model: fromModel }, to: { agent: top.agent, model: top.model }, until, by: 'limit' }) });
    logEvent(`#${task.id} ${fromName} hit its limit → moved to ${top.agent}/${top.model}`, { projectId: task.project_id, taskId: task.id });
    // A chat's task: one compact notice in that chat (app.js renders it from the models, with the reset in the browser's timezone).
    const convoId = task.origin === 'chat' && getProject(task.project_id)?.convo_id;
    if (convoId && convoExists(convoId)) emitChat(convoId, { t: 'moved', taskId: task.id, from: { agent: from.agent, model: fromModel, label: labelOf(from.agent, fromModel) },
      to: { agent: top.agent, model: top.model, label: labelOf(top.agent, top.model) }, until });
    return true;
  }
  const addMove = (task, m) => JSON.stringify([...(parseJsonList(task.moves)), { at: now(), ...m }]);
  const parseJsonList = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  const labelOf = (agent, model) => (modelCatalog(agent).models || []).find((m) => m.id === model)?.label || model || agent;
  // Manual delegation (the task drawer's "Delegate…" sheet). The owner is choosing, so the fallback list doesn't apply;
  // every model of a connected agent is listed with its status, available ones first.
  function agentUsage(agent, model) {
    const until = blockedUntilFor(agent, model);
    if (until) return { status: 'limited', until };
    const hot = (usageLog.current?.(agent) || []).filter((w) => Number(w.pct) >= CFG.delegate.maxWindowPct);
    if (hot.length) return { status: 'limited', until: Math.max(0, ...hot.map((w) => w.resetsAt || 0)) || null, window: hot[0].window };
    return { status: 'available', until: null };
  }
  function delegateOptions(id) {
    const task = getTask(id);
    if (!task) return null;
    const cur = intendedRoute(task, getProject(task.project_id));
    const connected = Object.keys(AGENTS).filter((a) => (a === 'claude' ? onSubscription() : agentStatus(a) === true && !(kvTime(`agent_auth_failed:${a}`) > now())));
    const all = connected.flatMap((a) => (modelCatalog(a).models || []).map((m) => ({ agent: a, model: m.id, label: m.label || m.id, default: !!m.default })));
    const current = { agent: cur.agent, model: cur.model || (all.find((m) => m.agent === cur.agent && m.default) || all.find((m) => m.agent === cur.agent))?.model || null };
    const rows = all.filter((m) => !(m.agent === current.agent && m.model === current.model))
      .map((m) => ({ agent: m.agent, model: m.model, label: m.label, ...agentUsage(m.agent, m.model) }));
    rows.sort((a, b) => (a.status === 'available' ? 0 : 1) - (b.status === 'available' ? 0 : 1));
    return { task: taskView(task),
      current: { ...current, label: all.find((m) => m.agent === current.agent && m.model === current.model)?.label || current.model, ...agentUsage(current.agent, current.model) }, candidates: rows };
  }
  function delegateTask(id, { agent, model } = {}) {
    const task = getTask(id);
    if (!task) return { error: 'No such task', status: 404 };
    if (task.status !== 'queued') return { error: `Only queued tasks can be delegated (#${id} is ${task.status})`, status: 409 };
    if ((task.kind || 'work') !== 'work') return { error: 'Only work tasks can be delegated', status: 409 };
    if (!AGENTS[agent]) return { error: 'Unknown agent' };
    model = model ? String(model) : null;
    if (unlistedModel(agent, model)) return { error: `${model} is not a ${agent} model` };
    const project = getProject(task.project_id);
    const from = intendedRoute(task, project);
    const fromName = `${from.agent}/${from.model || 'default'}`;
    updateTask(id, { agent, model, session_id: null, delegated_from: task.delegated_from || fromName, delegated_reason: 'chosen by the owner',
      moves: addMove(task, { from: { agent: from.agent, model: from.model || delegator.defaultModel(from.agent) }, to: { agent, model: model || delegator.defaultModel(agent) }, until: null, by: 'owner' }) });
    logEvent(`#${id} delegated by the owner from ${fromName} to ${agent}/${model || 'default'}`, { projectId: task.project_id, taskId: id });
    setTimeout(tick, 100);
    return { ok: true, task: taskView(getTask(id)) };
  }
  // ---- owner controls on a running task (drawer and card): pause and hand off. Aborting only asks the session to stop;
  // the intent is applied once the run has really ended (applyStopIntent, from execute), so a run that finishes in the
  // meantime simply finishes, and a limit that hits mid-handoff is recorded as usual and the handoff still happens.
  const stopIntents = new Map(); // task id -> { kind: 'pause' } | { kind: 'handoff', agent, model, account }
  const stopWaiters = new Map(); // task id -> [resolve]: callers waiting for the run to end
  const runEnded = (id, ms) => new Promise((resolve) => {
    if (!running.has(id)) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    stopWaiters.set(id, [...(stopWaiters.get(id) || []), () => { clearTimeout(t); resolve(true); }]);
  });
  const stopNote = (t, what) => (t.status === 'done' ? `#${t.id} finished before it could ${what}` : `#${t.id} is ${t.status}; it could not ${what}`);
  async function stopRunning(task, intent, what) {
    if (stopIntents.has(task.id)) return { error: `#${task.id} is already being paused or handed off`, status: 409 };
    stopIntents.set(task.id, intent);
    running.get(task.id)?.abort.abort();
    if (!running.has(task.id)) applyStopIntent(task.id); // marked running with no live run (a restart race)
    const ended = await runEnded(task.id, CFG.stopWaitMs);
    const t = getTask(task.id), applied = intent.kind === 'pause' ? t.status === 'paused' : !!t.handoff && t.agent === intent.agent && !t.finished_at;
    return { ok: true, task: taskView(t), ...(!ended ? { pending: true } : !applied ? { note: stopNote(t, what) } : {}) };
  }
  // Called once a run has ended: turn a requeued task into what the owner asked for. Anything else (done, failed,
  // cancelled) means the run ended on its own first, and the intent is dropped.
  function applyStopIntent(id) {
    const intent = stopIntents.get(id);
    stopIntents.delete(id);
    const task = getTask(id);
    if (!intent || !['queued', 'running'].includes(task?.status)) return;
    if (intent.kind === 'pause') {
      // Pinned to the agent/model it ran on, so Resume continues that session (a session resumes only on its agent).
      updateTask(id, { status: 'paused', not_before: 0, agent: task.ran_agent || task.agent, model: task.ran_agent ? task.ran_model : task.model });
      logEvent(`⏸ #${id} paused by the owner (session and worktree kept)`, { projectId: task.project_id, taskId: id });
    } else moveTo(task, intent);
    pushState(); setTimeout(tick, 100);
  }
  // Hand a task to another agent: a fresh session there, in the same worktree, starting with ownerHandoffPrompt.
  function moveTo(task, { agent, model, account }) {
    const fromAgent = task.ran_agent || task.agent || 'claude', fromModel = task.ran_agent ? task.ran_model : task.model;
    const fromName = `${fromAgent}/${fromModel || delegator.defaultModel(fromAgent) || 'default'}`;
    const ran = !!q1('SELECT 1 AS x FROM runs WHERE task_id=:t LIMIT 1', { t: task.id }); // nothing to hand over before a first run
    updateTask(task.id, { status: 'queued', not_before: 0, agent, model, session_id: null, last_error: null,
      handoff: ran ? JSON.stringify({ agent: fromAgent, model: fromModel || null, reason: 'moved by owner' }) : null,
      delegated_from: task.delegated_from || fromName, delegated_reason: 'moved by owner',
      moves: addMove(task, { from: { agent: fromAgent, model: fromModel || delegator.defaultModel(fromAgent) }, to: { agent, model: model || delegator.defaultModel(agent), ...(account && { account }) }, until: null, by: 'owner' }) });
    logEvent(`⇄ #${task.id} moved by the owner from ${fromName} to ${agent}/${model || 'default'}; it continues in the same worktree`, { projectId: task.project_id, taskId: task.id });
  }
  async function pauseTask(id) {
    const task = getTask(id);
    if (!task) return { error: 'No such task', status: 404 };
    if ((task.kind || 'work') !== 'work') return { error: 'Only work tasks can be paused', status: 409 };
    if (task.status === 'queued' && !running.has(id)) {
      updateTask(id, { status: 'paused' });
      logEvent(`⏸ #${id} paused by the owner`, { projectId: task.project_id, taskId: id });
      return { ok: true, task: taskView(getTask(id)) };
    }
    if (task.status !== 'running') return { error: `#${id} is ${task.status}, not running`, status: 409 };
    return stopRunning(task, { kind: 'pause' }, 'pause');
  }
  function resumeTask(id) {
    const task = getTask(id);
    if (!task) return { error: 'No such task', status: 404 };
    if (task.status !== 'paused') return { error: `#${id} is ${task.status}, not paused`, status: 409 };
    updateTask(id, { status: 'queued', not_before: 0 });
    logEvent(`▶ #${id} resumed by the owner${task.session_id ? ' (same session)' : ''}`, { projectId: task.project_id, taskId: id });
    setTimeout(tick, 100);
    return { ok: true, task: taskView(getTask(id)) };
  }
  async function handoffTask(id, { agent, model, account } = {}) {
    const task = getTask(id);
    if (!task) return { error: 'No such task', status: 404 };
    if ((task.kind || 'work') !== 'work') return { error: 'Only work tasks can be handed off', status: 409 };
    // Queued too: a run that just ended on a limit (or was otherwise interrupted) is back in the queue by the time the owner acts.
    if (!['running', 'paused', 'queued'].includes(task.status)) return { error: `Only running, paused or queued tasks can be handed off (#${id} is ${task.status})`, status: 409 };
    if (task.status === 'running' && (running.get(id)?.node || LOCAL_NODE) !== LOCAL_NODE) return { error: `#${id} runs on another machine; pause it or let it finish there`, status: 409 };
    if (!AGENTS[agent]) return { error: 'Unknown agent' };
    model = model ? String(model) : null;
    if (unlistedModel(agent, model)) return { error: `${model} is not a ${agent} model` };
    const connected = agent === 'claude' ? onSubscription() : agentStatus(agent) === true && !(kvTime(`agent_auth_failed:${agent}`) > now());
    if (!connected) return { error: `${agentName(agent)} is not signed in`, status: 409 };
    const curAgent = task.ran_agent || task.agent || 'claude', curModel = task.ran_agent ? task.ran_model : task.model;
    if (curAgent === agent && (curModel || null) === model) return { error: `#${id} already runs on ${agent}/${model || 'default'}`, status: 409 };
    const intent = { kind: 'handoff', agent, model, account: account ? String(account) : null };
    const limited = agentUsage(agent, model).status === 'limited' ? { warning: `${agentName(agent)} is at its usage limit; the task waits for it` } : {};
    if (task.status !== 'running' || !running.has(id)) {
      moveTo(task, intent);
      pushState(); setTimeout(tick, 100);
      return { ok: true, task: taskView(getTask(id)), ...limited };
    }
    return { ...(await stopRunning(task, intent, 'be handed off')), ...limited };
  }
  function routesText(projectId) {
    const agents = Object.values(AGENTS).map((a) => {
      const st = a.id === 'claude' || agentStatus(a.id);
      const { models, error } = modelCatalog(a.id);
      return `  - ${a.id} (${a.label})${st === true ? '' : ` [${st.toUpperCase()}: falls back to Claude]`}: models ${models.map((m) => m.id).join(', ') || `unknown (${error || 'none listed'}); omit \`model\``}`;
    });
    const routes = listRoutes(projectId).map((r) => `  #${r.id} [${r.project_id == null ? 'global' : 'project'}] '${r.match}' → ${[r.agent, r.model].filter(Boolean).join(' / ')}${r.note ? ` (${r.note})` : ''}`);
    return `Coding agents:\n${agents.join('\n')}\nRouting rules:\n${routes.join('\n') || '  (none: everything runs on Claude with the chat model)'}`;
  }

  // ---- queueing a planner/reflector reply
  // origin: {origin, fallbacks} for every task in the payload (fallbacks: the chat's or project's list, snapshotted).
  function queuePayload(project, payload, source, origin = {}) {
    if (!payload) return [];
    // Once the owner orders projects in the sidebar, that order alone sets project priority.
    if (payload.project) {
      const fields = { ...payload.project };
      if (projectsOrdered()) delete fields.priority;
      updateProject(project.id, fields);
    }
    for (const d of payload.dropped || []) logEvent(`${source} ${d}`, { level: 'warn', projectId: project.id });
    for (const r of payload.routes || []) applyRoute(project, r);
    const ids = [], batch = [], checkpoints = [];
    for (const t of payload.tasks) {
      if (t.kind === 'review') { // a checkpoint: what needed its prerequisites now waits for the owner's review too
        const deps = resolveAfter(t.after, batch).filter((d) => getTask(d));
        if (!deps.length) { logEvent(`${source} review break '${t.title}' has no \`after\`; skipped`, { level: 'warn', projectId: project.id }); batch.push(null); continue; }
        const id = addCheckpoint(project.id, deps, { title: t.title, source, origin: origin.origin ?? null, relinkNow: false });
        checkpoints.push([id, deps]);
        ids.push(id);
        batch.push(id);
        continue;
      }
      const dup = findDuplicate(project.id, t.title);
      if (dup) { logEvent(`skipped duplicate: ${t.title} (already #${dup.id})`, { projectId: project.id }); batch.push(dup.id); continue; }
      const dependsOn = resolveAfter(t.after, batch).filter((d) => getTask(d));
      const id = addTask(project.id, { title: t.title, prompt: t.prompt, kind: 'work', source, priority: t.priority, urgency: t.urgency, deadline: t.deadline, dependsOn, doneWhen: t.done_when,
        agent: t.agent, model: t.model, files: t.files, ...origin });
      writeTaskSpec(project.path, getTask(id));
      ids.push(id);
      batch.push(id);
    }
    for (const [cp, deps] of checkpoints) relinkTo(cp, deps); // once the whole block exists
    if (ids.length) logEvent(`${source} queued ${ids.length} task(s): ${ids.map((i) => `#${i}`).join(', ')}`, { projectId: project.id });
    return ids;
  }

  // ---- chat → planner (streams into the chat like a normal Claude reply)
  function chatStreamer(convoId) {
    let acc = '', hidden = false;
    const media = mediaCollector(dataDir, null);
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
        for (const e of AGENTS.claude.events(m)) {
          if (e.k === 'tool_result') emitChat(convoId, { t: 'tool_result', id: e.id, text: e.text, isError: e.isError });
          else if (e.k === 'image') { const img = media.image(e); if (img) emitChat(convoId, { t: 'image', ...img, tool: e.tool }); }
        }
      }
    };
  }

  // The chat's model picker changed: its project's default model (what unrouted tasks run on) follows at once, not only
  // when the next message is sent, so queued tasks, their fallback sheets and the reflection sheet name the right model.
  function syncConvoModel(convo) {
    const p = q1('SELECT * FROM projects WHERE path=:p AND convo_id=:c', { p: convo.cwd, c: convo.id });
    if (!p || (convo.model || null) === p.model) return;
    updateProject(p.id, { model: convo.model || null });
    // Queued tasks show where they will run (runs_on/runs_model: card chips, their fallback sheets): refresh those too.
    for (const t of qa("SELECT id FROM tasks WHERE project_id=:p AND status='queued'", { p: p.id })) pushTask(t.id);
  }
  function ensureProject(convo) {
    let p = q1('SELECT * FROM projects WHERE path=:p', { p: convo.cwd });
    if (!p) {
      const r = run(`INSERT INTO projects(path,name,convo_id,model,position,created_at)
        VALUES(:p,:n,:c,:m,(SELECT COALESCE(MAX(position), 0) + 1 FROM projects),:t)`,
        { p: convo.cwd, n: path.basename(convo.cwd), c: convo.id, m: convo.model || null, t: now() });
      p = getProject(Number(r.lastInsertRowid));
      logEvent(`project added: ${p.name}`, { projectId: p.id });
      // A new project joins the bottom of the owner's order (and so gets the lowest priority).
      if (projectsOrdered()) { applyProjectOrder(projectsInOrder()); p = getProject(p.id); }
      else broadcast({ t: 'oprojects', order: projectOrderView() });
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
  // `agent`/`model`: what the plan task's planner runs on (the chat's choice). Returns the saved message's id,
  // which the 'Saved…' notice carries (`msgId`) so the owner can edit or retract it while it is still pending.
  function deferMessage(projectId, text, selfId = 0, agent = null, model = null) {
    const msgId = text != null ? Number(run("INSERT INTO messages(project_id,content,created_at) VALUES(:p,:c,:t)", { p: projectId, c: text, t: now() }).lastInsertRowid) : null;
    if (!q1("SELECT 1 AS x FROM tasks WHERE project_id=:p AND kind='plan' AND status IN ('queued','running') AND id!=:s", { p: projectId, s: selfId })) {
      addTask(projectId, { title: "Answer owner's message", prompt: '(pending chat messages)', kind: 'plan', source: 'user',
        agent: agent && agent !== 'claude' ? agent : null, model: agent && agent !== 'claude' ? model : null });
    }
    return msgId;
  }
  // Owner edits/retracts of a saved message: only while it is pending (a plan task's claim is one UPDATE, so no race).
  function changeMessage(id, text) {
    const m = q1('SELECT * FROM messages WHERE id=:id', { id });
    if (!m) return { status: 404, error: 'No such message' };
    const retract = text == null;
    if (!retract && !String(text).trim()) return { status: 400, error: 'Message is empty' };
    const r = retract ? run("DELETE FROM messages WHERE id=:id AND status='pending'", { id })
      : run("UPDATE messages SET content=:c WHERE id=:id AND status='pending'", { id, c: String(text).trim() });
    if (!r.changes) return { status: 409, error: 'The planner has already read this message' };
    const convoId = getProject(m.project_id)?.convo_id;
    if (convoId && convoExists(convoId)) emitChat(convoId, retract ? { t: 'msg_retract', msgId: id } : { t: 'msg_edit', msgId: id, text: String(text).trim() });
    // Nothing left to answer: the waiting plan task goes too.
    if (retract && !q1("SELECT 1 AS x FROM messages WHERE project_id=:p AND status IN ('pending','taken')", { p: m.project_id })) {
      for (const t of qa("SELECT id FROM tasks WHERE project_id=:p AND kind='plan' AND status='queued'", { p: m.project_id })) taskAction(t.id, 'cancel');
    }
    return { ok: true };
  }
  // The planner runs on the chat's selected agent; Claude when none (or an unknown one) is selected.
  const plannerAgent = (agent) => (agent && agent !== 'claude' && AGENTS[agent] ? agent : 'claude');
  // When the chat's agent is at its limit, the planner answers on the chat's first fallback (convo.fallbacks) with usage
  // left, and says so. With no fallbacks the message is saved until that agent's reset.
  async function planTurn(convo, text) {
    const project = ensureProject(convo);
    await ensureGit(project.path);
    if (project.status !== 'active') updateProject(project.id, { status: 'active' });
    // A plan task is answering saved messages on this session: queue behind it.
    if (planningProjects.get(project.id) === 'task') {
      const msgId = deferMessage(project.id, text);
      emitChat(convo.id, { t: 'notice', msgId, text: 'Saved. The planner is busy answering earlier messages; it answers this right after.' });
      return;
    }
    // Restart when idle is pending: save the message; a plan task answers it after the restart.
    if (draining) {
      const msgId = deferMessage(project.id, text);
      emitChat(convo.id, { t: 'notice', msgId, text: 'Saved. agent-orch is restarting once idle; the planner answers this after the restart.' });
      return;
    }
    let agent = plannerAgent(convo.agent), model = agent === 'claude' ? null : convo.model || null;
    // A non-Claude agent that can't run at all (not installed, signed out) is an error, never a silent swap.
    const st = agent === 'claude' ? true : agentStatus(agent);
    if (st !== true || kvTime(`agent_auth_failed:${agent}`) > now()) {
      emitChat(convo.id, { t: 'error', text: `Not sent: ${agentName(agent)} is ${st === true ? 'not signed in' : st}. Connect it from the sidebar or pick another model.` });
      return;
    }
    // While the chat's agent is limited, save the message; a plan task answers it the moment that agent's capacity returns.
    const r = limitResetFor(agent, model);
    if (r) {
      const alt = delegator.nextModel({ fallbacks: convo.fallbacks }, { agent, model });
      if (alt) {
        emitChat(convo.id, { t: 'notice', until: r.at, untilKnown: r.known, text: `${r.name} is at its ${r.notice} until {until}; ${alt.model} (${agentName(alt.agent)}, fallback #${alt.rank}) answers this instead.` });
        agent = alt.agent; model = alt.model;
      } else {
        const msgId = deferMessage(project.id, text, 0, agent, model);
        // The browser replaces {until} with `until` in its own timezone.
        emitChat(convo.id, { t: 'notice', msgId, until: r.at, untilKnown: r.known, agent, text: r.known
          ? `Saved. ${r.name} is at its ${r.notice} until {until}; the orchestrator answers then.`
          : `Saved. ${r.name} is at its ${r.notice}; the reset time isn't known yet. Retrying around {until}.` });
        return;
      }
    }
    const ac = new AbortController();
    planAborts.set(convo.id, ac);
    planningProjects.set(project.id, 'chat');
    // The chat's fallbacks are snapshotted into its tasks, so a later edit doesn't change what's already queued.
    const origin = { origin: 'chat', fallbacks: parseFallbacks(convo.fallbacks) };
    try { await plannerRun(project, text, convo.id, ac.signal, true, { agent, model, origin }); }
    finally { planAborts.delete(convo.id); planningProjects.delete(project.id); }
  }
  const abortPlan = (convoId) => planAborts.get(convoId)?.abort();

  // Planner sessions: Claude's is projects.chat_session_id; another agent's is kv planner_session:<project>:<agent>
  // (a session only resumes on the agent that made it).
  // A run's system text plus the persona of the project's chat (server: extensions.mjs), read at each session start.
  const withPersona = (system, project, convoId = null) => {
    const cid = convoId || project?.convo_id, p = cid ? convoPersona(cid) : null;
    return p ? `${system}\n\n${p}` : system;
  };
  const plannerSession = (project, agent) => (agent === 'claude' ? project.chat_session_id : kvGet(`planner_session:${project.id}:${agent}`) || null);
  const setPlannerSession = (project, agent, id) => (agent === 'claude' ? updateProject(project.id, { chat_session_id: id }) : kvSet(`planner_session:${project.id}:${agent}`, id || ''));

  async function plannerRun(project, text, convoId, signal, fromChat = false, { agent = 'claude', model = null, origin = { origin: 'chat' } } = {}) {
    const prompt = plannerTurnPrompt(project, listTasks(project.id, 25), text, `${ENVIRONMENT}\n${routesText(project.id)}\nOwner fallback list (used when a model hits its limit): ${JSON.stringify(origin.fallbacks || [])}`);
    // Claude streams SDK messages into the chat, so a 'plan' route can only change the Claude planner's model.
    // Other agents show their tool calls as they happen and the reply at the end.
    const route = resolveRoute({ kind: 'plan', title: '' }, project, listRoutes(project.id), () => true);
    const claude = agent === 'claude';
    const toChat = convoId && !claude ? (e) => {
      if (e.k === 'tool') emitChat(convoId, { t: 'tool_use', id: e.id, name: e.name, input: e.input });
      else if (e.k === 'tool_result') emitChat(convoId, { t: 'tool_result', id: e.id, text: String(e.text || '').slice(0, 20000), isError: !!e.isError });
    } : null;
    const plannerModel = claude ? (route.agent === 'claude' ? route.model : project.model) : model || undefined;
    // A chat turn (and a plan task answering the chat) runs at the chat's current effort.
    const effort = clampEffort(agent, convoId || project.convo_id ? convoEffort(convoId || project.convo_id) : null, plannerModel || null);
    const attempt = (resume) => runAgent({
      agent, prompt, cwd: project.path, resume, append: resume ? null : withPersona(PLANNER_SYSTEM, project, convoId), autonomous: false, signal, timeoutSec: 30 * 60,
      model: plannerModel, effort,
      tools: PLANNER_TOOLS, partial: claude && !!convoId, onMessage: claude && convoId ? chatStreamer(convoId) : null, onEvent: toChat,
    });
    const session = plannerSession(project, agent);
    let res = await attempt(session);
    if (session && isMissingSession(res)) {
      setPlannerSession(project, agent, null);
      res = await attempt(null);
    }
    recordGovernor(res, agent, claude ? null : model);
    if (res.sessionId && ['ok', 'max_turns'].includes(res.outcome)) setPlannerSession(project, agent, res.sessionId);
    if (convoId && !claude && res.outcome === 'ok') { const shown = stripTasksBlock(res.text || ''); if (shown) emitChat(convoId, { t: 'text', text: shown }); }
    if (!['ok'].includes(res.outcome)) {
      if (convoId) {
        const why = res.outcome === 'rate_limited' ? `${limitName(agent, model)} hit its ${res.limitType ? windowLabel(res.limitType) : 'usage'} limit. The message is saved and will be answered after the reset.`
          : res.outcome === 'aborted' ? 'Stopped.' : `The planner couldn't finish (${res.outcome}). ${String(res.stderr || res.text).trim().slice(-300)}`;
        // A plan task's messages go back to pending and the task itself is requeued.
        const msgId = res.outcome === 'rate_limited' && fromChat ? deferMessage(project.id, text, 0, agent, model) : null;
        emitChat(convoId, { t: res.outcome === 'aborted' ? 'notice' : 'error', text: why, ...(msgId ? { msgId } : {}) });
      }
      return { res, ids: [] };
    }
    const [, payload] = extractTasks(res.text);
    const ids = queuePayload(getProject(project.id), payload, 'planner', origin);
    if (convoId && ids.length) emitChat(convoId, { t: 'tasks', ids, source: 'planner' });
    return { res, ids };
  }

  // ---- the scheduler (agent-orch's daemon, as timers inside this process)
  let ticking = false;
  let draining = false, drained = []; // in memory only: a restart forgets drain()
  async function tick() {
    if (ticking || !leader.ok || draining) return;
    ticking = true;
    try {
      // No hub was attached (the cluster is off): tasks left running on workers can't be re-adopted.
      if (!cluster && adoptable.length) for (const id of adoptable.splice(0)) requeueIfRunning(id);
      armCheckpoints();
      if (kvGet('paused_all') === '1') return;
      if (!onSubscription()) {
        if (kvGet('announced_auth') !== '1') { kvSet('announced_auth', 1); logEvent('waiting: Claude Code is not signed in with the subscription', { level: 'warn' }); }
        return;
      }
      kvSet('announced_auth', 0);
      const d = decision();
      considerPreemption(d);
      reapIfLow();
      // Pacing and the owner's cap limit work across every node (all nodes share the same accounts' limits).
      const settings = parallelSettings();
      const cap = Math.min(settings.maxTasks || Infinity, d.scarce || d.concurrency < CFG.concurrency ? Math.max(1, d.concurrency) : Infinity);
      for (;;) {
        const mem = readMemInfo(CFG.meminfo), slots = slotCount(d, mem);
        if (!slots) {
          if (kvGet('announced_mem') !== '1') { kvSet('announced_mem', 1); logEvent(`waiting: server memory low (${Math.round(mem.avail / 1024 ** 2)} MB available)`, { level: 'warn' }); }
          if (!workerNodes('claude').length && !workerNodes('codex').length) break; // workers can still take work
        } else kvSet('announced_mem', 0);
        const free = slots > 0 && workRunning() < slots, claim = claimNext(d.allowed, free, slots > 0, cap);
        if (!claim) { if (free && scheduleReflections()) continue; break; }
        startTask(claim.task, claim.node, claim.prevNode);
      }
    } catch (e) {
      console.error('[orchestrator] tick failed', e);
    } finally {
      ticking = false;
    }
  }

  // Low memory: reap leftover processes (resources.mjs) before claiming, at most every 30 s.
  let reapedAt = 0;
  function reapIfLow() {
    if (!reap || Date.now() - reapedAt < 30_000 || readMemInfo(CFG.meminfo).avail >= MEM.reapBelow) return;
    reapedAt = Date.now();
    try { reap(); } catch (e) { console.error('[orchestrator] reap failed', e); }
  }

  // node: where it runs (LOCAL_NODE or a worker id); prevNode: where it ran before (a worker's pushed branch is adopted).
  // adopt: {runId, logPath, from, agent} continues a remote job that outlived a controller restart.
  function startTask(task, node = LOCAL_NODE, prevNode = null, adopt = null) {
    const abort = new AbortController();
    const project = getProject(task.project_id);
    // A remote task always has its own checkout, so it shares its project like a worktree task.
    running.set(task.id, { abort, kind: task.kind, projectId: task.project_id, startedAt: now(), node, prevNode, adopt,
      wt: task.kind === 'work' && (node !== LOCAL_NODE || worktreeCapable(project)), agent: adopt?.agent || routeNow(task, project).agent });
    pushState();
    execute(task, abort.signal)
      .catch((e) => console.error('[orchestrator] task crashed', e))
      .finally(() => {
        running.delete(task.id); pushState(); setTimeout(tick, 200);
        for (const w of stopWaiters.get(task.id) || []) w();
        stopWaiters.delete(task.id);
        if (!running.size) for (const r of drained.splice(0)) r();
      });
  }

  // Stop claiming (plan, work and reflect) and resolve once every running task has finished.
  function drain() {
    draining = true; pushState();
    return new Promise((r) => running.size ? drained.push(r) : r());
  }
  // Cancel a drain: claiming resumes. Pending drain() promises still resolve when running tasks end.
  function undrain() {
    draining = false; pushState(); setTimeout(tick, 100);
  }
  const chatPlanning = () => [...planningProjects.values()].includes('chat');

  function scheduleReflections() {
    let added = false;
    const t = now();
    for (const p of qa("SELECT * FROM projects WHERE status='active' AND perpetual=1")) {
      if (p.next_reflect_at > t) continue;
      if (planningProjects.has(p.id)) continue; // the owner is mid-conversation with the planner
      if (!projectReady(p.path)) continue;
      if (q1("SELECT 1 AS x FROM tasks WHERE project_id=:p AND status IN ('queued','running','paused','awaiting_review')", { p: p.id })) continue;
      // Nothing to improve until the owner has said what the project is and some work has landed.
      if (!q1("SELECT 1 AS x FROM tasks WHERE project_id=:p AND kind='work' AND status='done' LIMIT 1", { p: p.id })) continue;
      run('UPDATE projects SET next_reflect_at=:u WHERE id=:id', { u: t + 120, id: p.id });
      const rs = reflectFor(p);
      // The reflection fallbacks move the reflect task itself too when its model is at its limit (delegate).
      const id = addTask(p.id, { title: 'Reflect: what else should be done?', prompt: '(reflection)', kind: 'reflect', source: 'reflection', agent: rs.agent, model: rs.model,
        fallbacks: reflectFallbacksFor(p) });
      if (p.convo_id) emitChat(p.convo_id, { t: 'reflect', taskId: id, text: p.reflect_direction ? `${REFLECT_ASK} Direction: ${p.reflect_direction}` : REFLECT_ASK });
      logEvent(`queue empty → reflecting (task #${id})`, { projectId: p.id, taskId: id });
      added = true;
    }
    return added;
  }

  // Memory guard: MemAvailable under MEM.pauseBelow for CFG.memLowPauseSec pauses the newest running work task (a
  // graceful abort: it requeues and resumes its session later); another pause needs another full low stretch.
  // Claiming stays off until memory is back above MEM.claimFloor.
  let memLowSince = 0;
  function memGuard() {
    if (readMemInfo(CFG.meminfo).avail >= MEM.pauseBelow) { memLowSince = 0; return; }
    memLowSince ||= Date.now();
    if (Date.now() - memLowSince < CFG.memLowPauseSec * 1000) return;
    const [id, r] = [...running.entries()].filter(([, r]) => r.kind !== 'plan' && r.node === LOCAL_NODE && !r.paused && !r.abort.signal.aborted).pop() || [];
    if (!r) return;
    memLowSince = Date.now();
    r.paused = true;
    const t = getTask(id);
    logEvent(`Paused #${id}: server memory low`, { level: 'warn', projectId: t?.project_id, taskId: id });
    r.abort.abort();
  }

  function considerPreemption(d) {
    if (workRunning() < Math.max(1, slotCount(d))) return;
    const best = runnable(d.allowed, false, 1)[0];
    if (!best) return;
    const runningRows = qa(`SELECT t.*, ${EFFECTIVE_SQL} AS eff FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.status='running' ORDER BY eff ASC`, { now: now() });
    const lowest = runningRows[0];
    if (!lowest || lowest.kind === 'plan' || now() - (lowest.started_at || 0) < PREEMPT_MIN_RUNTIME) return;
    if (best.eff - lowest.eff < PREEMPT_MARGIN || best.project_id === lowest.project_id) return;
    const r = running.get(lowest.id);
    if (!r || r.preempted || r.node !== LOCAL_NODE) return;
    r.preempted = true;
    logEvent(`⇅ pausing #${lowest.id} (${lowest.title}) for more urgent #${best.id} (${best.title})`, { projectId: lowest.project_id, taskId: lowest.id });
    r.abort.abort();
  }

  async function execute(task, signal) {
    const project = getProject(task.project_id);
    if (!running.get(task.id)?.adopt) logEvent(`started #${task.id}: ${task.title}`, { projectId: project.id, taskId: task.id });
    try {
      let res;
      if (task.kind === 'plan') {
        // Claim the pending messages in one statement (plus any this task took on an earlier, crashed attempt):
        // from here on the owner can no longer edit or retract them.
        const pending = qa("UPDATE messages SET status='taken', task_id=:t WHERE project_id=:p AND (status='pending' OR (status='taken' AND task_id=:t)) RETURNING *",
          { p: project.id, t: task.id }).sort((a, b) => a.id - b.id);
        if (!pending.length) return updateTask(task.id, { status: 'done', finished_at: now(), result: 'nothing pending' });
        const convoId = project.convo_id && convoExists(project.convo_id) ? project.convo_id : null;
        const ids = pending.map((m) => m.id);
        if (convoId) emitChat(convoId, { t: 'msg_state', ids, state: 'read' });
        let text = pending.map((m) => m.content).join('\n\n');
        if (pending.length > 1) text = '(Several messages arrived while you were rate-limited:)\n\n' + text;
        planningProjects.set(project.id, 'task');
        const origin = { origin: 'chat', fallbacks: parseFallbacks(convoId ? convoFallbacks(convoId) : null) };
        try { res = (await plannerRun(project, text, convoId, signal, false, { agent: plannerAgent(task.agent), model: task.model, origin })).res; }
        finally { if (planningProjects.get(project.id) === 'task') planningProjects.delete(project.id); }
        if (res.outcome !== 'ok') {
          // Not answered: the messages wait (and are editable) again until the task's next attempt.
          for (const id of ids) run("UPDATE messages SET status='pending', task_id=NULL WHERE id=:id AND status='taken'", { id });
          if (convoId) emitChat(convoId, { t: 'msg_state', ids, state: 'pending' });
        } else {
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
    } finally {
      applyStopIntent(task.id);
      const wt = taskWts.get(task.id);
      taskWts.delete(task.id);
      // A task's own worktree outlives a requeue (the next run reuses it) and 'needs_integration'; an integrator's
      // belongs to the task it integrates.
      const st = getTask(task.id)?.status;
      if (wt && wt.owner === task.id && (st === 'failed' || st === 'cancelled')) {
        await parkTask(project, task.id, `agent-orch #${task.id} ${st}: ${task.title} (partial work)`);
      } else if (wt && wt.owner !== task.id && ['failed', 'cancelled'].includes(getTask(wt.owner)?.status)) {
        const owner = getTask(wt.owner);
        await parkTask(project, owner.id, `agent-orch #${owner.id} ${owner.status}: ${owner.title} (partial work)`);
      }
    }
  }

  async function runTask(task, project, signal) {
    if (nodeOf(task.id) !== LOCAL_NODE) return runRemote(task, project, signal);
    const prev = running.get(task.id)?.prevNode;
    if (prev && prev !== LOCAL_NODE && task.kind === 'work' && worktreeCapable(project)) await adoptRemoteBranch(task, project);
    let wt = null;
    if (running.get(task.id)?.wt) {
      wt = await taskWorktree(task, project);
      if (wt) {
        taskWts.set(task.id, wt);
        run('UPDATE tasks SET worktree=:w WHERE id=:id', { w: wt.dir, id: wt.owner });
      } else {
        running.get(task.id).wt = false;
        // Without a worktree it may only share the main tree with nobody.
        if (qa("SELECT id FROM tasks WHERE status='running' AND project_id=:p AND id!=:id", { p: project.id, id: task.id }).length) throw new Error('no worktree while other tasks run in this project');
      }
    }
    const cwd = wt?.cwd || project.path;
    initProject(cwd);
    writeTaskSpec(cwd, task);
    const route = routeFor(task, project);
    // A session id only resumes on the agent that created it.
    let resume = task.session_id && lastRunAgent(task.id) === route.agent && lastRunNode(task.id) === LOCAL_NODE ? task.session_id : null, reused = false, body, system, tools, autonomous;
    if (task.kind === 'reflect') {
      const failures = qa("SELECT * FROM tasks WHERE project_id=:p AND status IN ('failed') AND finished_at>=:s ORDER BY finished_at DESC LIMIT 8",
        { p: project.id, s: now() - 7 * 86400 });
      const oc = q1(`SELECT SUM(status='done') AS done, SUM(status='failed') AS failed FROM tasks WHERE project_id=:p AND source='reflection' AND kind='work' AND finished_at>=:s`,
        { p: project.id, s: now() - 7 * 86400 }) || {};
      body = reflectPrompt(project, listTasks(project.id, 20), recentJournal(project.path), contextOverage(project.path),
        limitsRows(), decision().reason, failures, { done: oc.done || 0, failed: oc.failed || 0 }, `${ENVIRONMENT}\nOwner fallback list (used when a model hits its limit): ${JSON.stringify(reflectFallbacksFor(project) || [])}`);
      system = REFLECT_SYSTEM;
      tools = [...PLANNER_TOOLS, ...CFG.safeTools.filter((t) => t.startsWith('Bash('))];
      autonomous = false;
    } else {
      // A warm session from another task was made in another checkout, so worktree tasks always start fresh.
      if (!resume && route.agent === 'claude' && !wt && !lostHandoff(task) && !task.handoff) { resume = pickSession(task); reused = !!resume; }
      const where = wt ? { ...project, path: cwd } : project, env = wt ? `${ENVIRONMENT}\n${worktreeNote(wt, project)}` : ENVIRONMENT;
      body = reused ? nextTaskPrompt(task) : !resume && lostHandoff(task) ? handoffPrompt(where, task, env, await handoffInfo(task, project))
        : !resume && task.handoff ? ownerHandoffPrompt(where, task, env, await ownerHandoffInfo(task, project, cwd)) : workerTaskPrompt(where, task, env);
      system = WORKER_SYSTEM;
      tools = CFG.safeTools;
      autonomous = !!project.autonomous;
    }
    const prompt = resume && !reused ? resumePrompt(task) : body;
    const effort = taskEffort(task, project, route);
    const { runId, logPath } = startRun(task.id, task.kind, route.agent, LOCAL_NODE, effort);
    updateTask(task.id, { ran_agent: route.agent, ran_model: route.model || null, route_note: routeNote(route), node_id: LOCAL_NODE });
    if (running.has(task.id)) running.get(task.id).agent = route.agent;
    pushState(); // Publish the actual route once fallback/model resolution has finished.
    const r = running.get(task.id);
    if (r) r.runId = runId;
    const res = await runAgent({
      agent: route.agent, prompt, cwd, resume, model: route.model, append: resume ? null : withPersona(system, project), tools, autonomous, effort,
      signal, timeoutSec: CFG.taskTimeoutSec, taskId: task.id, runId, logPath,
    });
    finishRun(runId, res);
    if (task.handoff && res.sessionId) updateTask(task.id, { handoff: null }); // the new agent's own session carries on from here
    // A missing session (Claude's 'no conversation found', a codex errorCode 'no_session') is dropped; the task
    // requeues without spending an attempt and starts fresh.
    if (resume && isMissingSession(res)) {
      updateTask(task.id, { session_id: null });
      res.outcome = 'aborted';
      res.sessionId = null; // CLI adapters echo `resume` back; don't let the requeue restore it
    }
    if (task.kind === 'work' && route.agent === 'claude') recordSessionUse(res, project.id, task.id);
    return res;
  }

  // What a resumed session is told: the check that failed, the error it hit, or just to continue.
  function resumePrompt(task) {
    if (task.verify_output != null) return verifyFailedPrompt(extractCommand(task.done_when) || '(the done-when check)', task.verify_output || '(no output)');
    if (task.last_error != null) return retryAfterFailure(task.attempts + 1, lastRunOutcome(task.id) || 'error', task.last_error);
    return task.continuations ? CONTINUE : RESUME;
  }

  // ---- remote runs: a work task on a worker (job.offer → job.start → job.event* → job.check → job.done). The worker
  // checks out the project's GitHub repo at the base sha on agent-orch/task-<id> and pushes that branch; finishWork
  // fetches it and merges it here exactly like a local worktree.
  async function runRemote(task, project, signal) {
    const nodeId = nodeOf(task.id), n = nodesNow().find((x) => x.id === nodeId), name = n?.name || nodeId;
    const adopt = running.get(task.id)?.adopt;
    if (adopt) { // re-adopted after a controller restart: the job still runs there; its run and log continue
      const res = await remoteJob(task.id, nodeId, name, adopt, { agent: adopt.agent }, signal, { from: adopt.from });
      finishRun(adopt.runId, res);
      return res;
    }
    const repo = remoteRepo(project);
    if (!repo) throw new Error(`${project.name} has no GitHub remote for a worker to clone`);
    const route = routeFor(task, project);
    const baseSha = await remoteBase(task, project, running.get(task.id)?.prevNode);
    const resume = task.session_id && lastRunAgent(task.id) === route.agent && lastRunNode(task.id) === nodeId ? task.session_id : null;
    const where = `a checkout of ${repo} on the worker machine ${name}`;
    const env = `Environment (cluster worker ${name}, ${n?.os || 'unknown'}/${n?.arch || 'unknown'}): a machine that runs agent-orch tasks; ` +
      `install whatever the task needs.\nYou are in ${where}, on branch ${taskBranch(task.id)}. The orchestrator pushes and merges it when you finish.`;
    const prompt = resume ? resumePrompt(task) : lostHandoff(task) ? handoffPrompt({ ...project, path: where }, task, env, await handoffInfo(task, project))
      : workerTaskPrompt({ ...project, path: where }, task, env);
    const effort = taskEffort(task, project, route);
    const { runId, logPath } = startRun(task.id, task.kind, route.agent, nodeId, effort);
    updateTask(task.id, { ran_agent: route.agent, ran_model: route.model || null, route_note: routeNote(route), node_id: nodeId });
    const r = running.get(task.id);
    if (r) { r.agent = route.agent; r.runId = runId; }
    pushState();
    logEvent(`#${task.id} runs on ${name}`, { projectId: project.id, taskId: task.id });
    const res = await remoteJob(task.id, nodeId, name, { runId, logPath }, {
      title: task.title, prompt, systemAppend: resume ? undefined : withPersona(WORKER_SYSTEM, project), agent: route.agent, model: route.model || undefined, effort: effort || undefined,
      repo, baseSha, branch: taskBranch(task.id), doneWhen: task.done_when || undefined, resume: resume || undefined,
      timeouts: { taskSec: CFG.taskTimeoutSec, verifySec: CFG.verifyTimeoutSec, installSec: 900 }, autonomous: !!project.autonomous,
    }, signal);
    finishRun(runId, res);
    if (resume && isMissingSession(res)) {
      updateTask(task.id, { session_id: null });
      res.outcome = 'aborted';
      res.sessionId = null;
    }
    return res;
  }

  // One job on a worker, as a runAgent-shaped result. Its events go through the same run log (task drawer, lanes);
  // usage and limit readings feed usage.mjs like a local run (same accounts, same limits). Each log entry keeps its
  // event index (`i`), so a re-adopted job continues after the last one written. attach: {from} re-adopts a job that
  // already runs there (after a controller restart): no offer or start, the worker's hello gets job.attach instead.
  // While the node is away the task shows 'waiting for <node>'; past its grace period the job is lost and the task
  // moves on (handle → requeue with a handoff prompt, from the pushed WIP branch).
  function remoteJob(id, nodeId, name, { runId, logPath }, spec, signal, attach = null) {
    return new Promise((resolve) => {
      const write = runLog(id, runId, logPath), media = mediaCollector(dataDir, null);
      if (!attach) write({ k: 'start', at: now(), resumed: !!spec.resume, agent: spec.agent, model: spec.model || null, node: nodeId, nodeName: name });
      let settled = false, offerTimer = null, watch = null, lostSince = attach ? Date.now() : 0;
      const job = { node: nodeId, next: attach?.from || 0, check: null, started: !!attach, attached: false };
      const waiting = (label) => {
        const r = running.get(id);
        if (!r || r.waiting === label) return;
        r.waiting = label;
        if (label) logEvent(`#${id} waiting for ${label}`, { level: 'warn', taskId: id });
        pushTask(id); pushState();
      };
      const finish = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(offerTimer); clearInterval(watch);
        signal?.removeEventListener('abort', onAbort);
        if (jobs.get(id) === job) jobs.delete(id);
        waiting(null);
        write({ k: 'end', at: now(), outcome: res.outcome, turns: 0 });
        write.end();
        resolve({ usage: {}, numTurns: 0, text: '', sessionId: null, ...res });
      };
      job.accept = () => {
        if (job.started || settled) return;
        job.started = job.attached = true;
        clearTimeout(offerTimer);
        if (!cluster.send(nodeId, { t: MSG.JOB_START, job: id, ...spec })) finish({ outcome: 'aborted', text: `${name} went away before the job started` });
      };
      job.reject = (reason) => {
        if (job.started) return;
        rejected.set(`${nodeId}/${id}`, Date.now() + 60_000);
        finish({ outcome: 'aborted', text: `${name} declined the job (${reason})` });
      };
      // Batches may be re-sent after a reconnect: `from` + index dedupes them.
      job.event = ({ from, events }) => {
        events.forEach((e, n) => {
          const i = from + n;
          if (i < job.next) return;
          if (e.k === 'image') { const img = e.data && media.image(e); if (img) write({ k: 'image', ...img, tool: e.tool, i }); return; }
          const l = logEntryOf(e);
          if (l) write({ ...l, i });
        });
        job.next = Math.max(job.next, from + events.length);
      };
      job.done = (msg) => {
        const lim = msg.limits || {};
        usageLog.tokens(spec.agent, msg.usage || {}, 'task', id);
        usageLog.windows(spec.agent, lim.windows || undefined);
        finish({ outcome: msg.outcome, text: msg.text, usage: msg.usage || {}, sessionId: msg.sessionId || null,
          resetsAt: lim.resetsAt ?? undefined, limitType: lim.limitType ?? undefined, windows: lim.windows ?? undefined,
          remote: { node: nodeId, sha: msg.sha || null, check: job.check } });
      };
      // The job is gone from that node: don't offer it there again for a while (its old copy is cancelled when it returns).
      job.lost = (why) => {
        rejected.set(`${nodeId}/${id}`, Date.now() + 10 * 60_000);
        logEvent(`#${id}: ${why}; it moves to another machine`, { level: 'warn', taskId: id });
        finish({ outcome: 'aborted', lost: true, text: `[lost] ${why}` });
      };
      const onAbort = () => {
        if (job.started) cluster.send(nodeId, { t: MSG.JOB_CANCEL, job: id, reason: 'stopped by the controller' });
        finish({ outcome: 'aborted', text: 'stopped by the controller' });
      };
      jobs.set(id, job);
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
      watch = setInterval(() => {
        const n = cluster.node(nodeId);
        // Disabled or removed by the owner: its jobs move now (the worker drops its copy without pushing).
        if (!n?.enabled) {
          if (job.started) cluster.send(nodeId, { t: MSG.JOB_CANCEL, job: id, reason: 'disabled' });
          return job.lost(`node ${name} was ${n ? 'disabled' : 'removed'}`);
        }
        if (!job.started) return; // an unanswered offer times out on its own
        const up = cluster.isConnected(nodeId);
        if (!up) job.attached = false;
        if (up && job.attached) { if (lostSince) { lostSince = 0; logEvent(`#${id}: ${name} is back; the job continues`, { taskId: id }); } return waiting(null); }
        lostSince ||= Date.now();
        waiting(n.awayLabel === 'Mac asleep' ? `${name} (Mac asleep)` : name);
        if (Date.now() - lostSince >= (n.graceMs ?? graceMs(n.os))) job.lost(`node ${name} disappeared`);
      }, 1000);
      if (attach) return;
      if (!cluster.send(nodeId, { t: MSG.JOB_OFFER, job: id, agent: spec.agent, model: spec.model, footprint: Math.round(footprint(spec.agent)) })) {
        return finish({ outcome: 'aborted', text: `${name} is not connected` });
      }
      offerTimer = setTimeout(() => job.reject('no answer'), CFG.offerMs);
    });
  }

  function onClusterMessage(nodeId, msg) {
    if (msg.t === MSG.HELLO) {
      // A (re)connecting worker lists the jobs it still holds: ours continue (job.attach: it replays the stream from
      // what we have), the rest are cancelled; 'reassigned' drops the worktree without pushing over the new run.
      // A job of ours it no longer has (it rebooted) moves on at once instead of waiting out the grace period.
      const listed = new Set(msg.jobs.map((j) => j.job));
      for (const j of msg.jobs) {
        const mine = jobs.get(j.job);
        if (mine?.node === nodeId && mine.started) {
          mine.attached = true;
          cluster.send(nodeId, { t: MSG.JOB_ATTACH, job: j.job, from: mine.next });
        } else cluster.send(nodeId, { t: MSG.JOB_CANCEL, job: j.job, reason: 'reassigned' });
      }
      for (const [id, job] of jobs) if (job.node === nodeId && job.started && !listed.has(id)) job.lost(`${nodeName(nodeId)} came back without the job (restarted?)`);
      return;
    }
    // The worker keeps a finished job (to replay it) until its job.done is acked.
    if (msg.t === MSG.JOB_DONE) cluster.send(nodeId, { t: MSG.ACK, re: msg.seq, job: msg.job });
    if (msg.t === MSG.WAKE) return logEvent(`${nodeName(nodeId)} woke up after ${Math.max(1, Math.round(msg.sleptMs / 60_000))} min asleep`);
    const job = msg.job != null ? jobs.get(msg.job) : null;
    if (msg.t === MSG.ERROR && msg.job != null) return logEvent(`#${msg.job} on ${nodeName(nodeId)}: ${msg.message}`, { level: 'warn', taskId: msg.job });
    if (!job || job.node !== nodeId) return;
    switch (msg.t) {
      case MSG.JOB_ACCEPT: return job.accept();
      case MSG.JOB_REJECT: return job.reject(msg.reason);
      case MSG.JOB_EVENT: return job.event(msg);
      case MSG.JOB_CHECK: job.check = { command: msg.command, pass: msg.pass, output: msg.output, code: msg.code ?? null }; return;
      case MSG.JOB_WIP: run('UPDATE tasks SET wip_sha=:s WHERE id=:id', { s: msg.sha, id: msg.job }); return;
      case MSG.JOB_DONE: return job.done(msg);
    }
  }
  function attachCluster(c) {
    cluster = c;
    nodesAt = 0;
    c.onMessage(onClusterMessage);
    for (const id of adoptable.splice(0)) adopt(id);
  }
  // Controller restart: a task that was running on a worker stays 'running' and is re-adopted here. It waits (one grace
  // period) for its node to reconnect; the worker's hello then re-attaches the job and its run log continues.
  function adopt(id) {
    const task = getTask(id), last = q1('SELECT * FROM runs WHERE task_id=:t ORDER BY id DESC LIMIT 1', { t: id });
    if (task?.status !== 'running') return;
    if (!last?.log_path || last.finished_at) { requeueIfRunning(id); return logEvent(`requeued #${id}: no run to re-adopt`, { taskId: id }); }
    let from = 0;
    try { for (const e of parseJsonl(fs.readFileSync(last.log_path, 'utf8'))) if (Number.isInteger(e.i)) from = Math.max(from, e.i + 1); } catch {}
    logEvent(`#${id} re-adopted after a restart: it runs on ${nodeName(task.node_id)}`, { projectId: task.project_id, taskId: id });
    startTask(task, task.node_id, null, { runId: last.id, logPath: last.log_path, from, agent: last.agent || task.ran_agent || 'claude' });
  }
  let adoptable = []; // remote tasks left running at boot, re-adopted once the hub is attached

  // What a handoff run is told about the lost one: its last messages and tool calls (its run log) and the pushed
  // branch's diff stat against the main branch. The branch is fetched here (a local run's worktree starts from it).
  // The last run's final messages (last 3, 1500 chars each) and tool calls (last 12), from its run log.
  function lastRunDigest(taskId) {
    const last = q1('SELECT * FROM runs WHERE task_id=:t ORDER BY id DESC LIMIT 1', { t: taskId });
    let entries = [];
    try { entries = parseJsonl(fs.readFileSync(last.log_path, 'utf8')); } catch {}
    const texts = entries.filter((e) => e.k === 'text' && String(e.text || '').trim()).slice(-3)
      .map((e) => { const t = String(e.text).trim(); return t.length > 1500 ? `…${t.slice(-1500)}` : t; });
    const tools = entries.filter((e) => e.k === 'tool').slice(-12).map(toolLine);
    return { last, texts, tools };
  }
  // An owner handoff: the digest plus the checkout's git status, uncommitted diff stat and the branch's own commits.
  async function ownerHandoffInfo(task, project, cwd) {
    const { texts, tools } = lastRunDigest(task.id);
    let h = {};
    try { h = JSON.parse(task.handoff) || {}; } catch {}
    const out = (args) => git(cwd, args).then((s) => s.trim(), () => '');
    const main = (await repoInfo(project.path).catch(() => null))?.branch;
    const inWorktree = cwd !== project.path;
    return { from: `${agentName(h.agent || 'claude')} (${h.model || 'default model'})`, texts, tools,
      // The orchestrator's own untracked task spec (.agent-orch/) isn't the previous agent's work.
      status: (await out(['status', '--short'])).split('\n').filter((l) => l !== '?? .agent-orch/').join('\n'), stat: await out(['diff', '--stat', 'HEAD']),
      log: inWorktree && main ? await out(['log', '--oneline', '-20', `${main}..HEAD`]) : '' };
  }
  async function handoffInfo(task, project) {
    const { last, texts, tools } = lastRunDigest(task.id);
    let sha = task.wip_sha || null, stat = '';
    await serialGit(project.path, async () => {
      const info = await repoInfo(project.path);
      if (!info) return;
      const b = taskBranch(task.id);
      if (!(await listWorktrees(info.top)).some((w) => w.id === task.id)) await git(info.top, ['fetch', '-q', 'origin', `+refs/heads/${b}:refs/heads/${b}`]);
      sha = (await git(info.top, ['rev-parse', `refs/heads/${b}`])).trim();
      stat = (await git(info.top, ['diff', '--stat', (await git(info.top, ['merge-base', info.branch, b])).trim(), b])).trim();
    }).catch(() => {});
    return { node: nodeName(last?.node_id || task.node_id), sha, stat, texts, tools };
  }

  // The base a worker starts from: the main branch's head, pushed to origin first when origin lacks it. A task whose
  // last run was here and left its branch (a retried task) pushes that branch too, so the worker continues from it.
  function remoteBase(task, project, prevNode) {
    return serialGit(project.path, async () => {
      const info = await repoInfo(project.path);
      if (!info) throw new Error('not on a git branch');
      await commitNow(project.path, `agent-orch: uncommitted changes before #${task.id}`);
      const sha = (await git(info.top, ['rev-parse', info.branch])).trim();
      const has = (args) => git(info.top, args).then(() => true, () => false);
      if (!(await has(['merge-base', '--is-ancestor', sha, `refs/remotes/origin/${info.branch}`]))) await git(info.top, ['push', '-q', 'origin', `${info.branch}:refs/heads/${info.branch}`]);
      const b = taskBranch(task.id);
      if ((!prevNode || prevNode === LOCAL_NODE) && await has(['rev-parse', '--verify', '-q', `refs/heads/${b}`])) await git(info.top, ['push', '-q', '-f', 'origin', `${b}:refs/heads/${b}`]);
      return sha;
    });
  }
  // A task that last ran on a worker continues here from its pushed branch (unless a worktree here already has it).
  function adoptRemoteBranch(task, project) {
    return serialGit(project.path, async () => {
      const info = await repoInfo(project.path);
      if (!info || (await listWorktrees(info.top)).some((w) => w.id === task.id)) return;
      const b = taskBranch(task.id);
      await git(info.top, ['fetch', '-q', 'origin', `+refs/heads/${b}:refs/heads/${b}`]);
    }).catch(() => {});
  }
  // A finished remote run: fetch its branch (it must be at the sha the worker reported) and check it out as the task's
  // worktree here, so the existing merge path (mergeTask, needs_integration) takes over.
  async function remoteWorktree(task, project, sha) {
    const b = taskBranch(task.id);
    if (!sha) throw new Error(`the worker reported no pushed commit for ${b}`);
    await serialGit(project.path, async () => {
      const info = await repoInfo(project.path);
      await git(info.top, ['fetch', '-q', 'origin', `+refs/heads/${b}:refs/heads/${b}`]);
      const tip = (await git(info.top, ['rev-parse', `refs/heads/${b}`])).trim();
      if (tip !== sha) throw new Error(`${b} on origin is at ${tip.slice(0, 8)}, not the reported ${sha.slice(0, 8)}`);
    });
    const wt = await taskWorktree(task, project);
    if (!wt) throw new Error(`couldn't check out ${b} from origin`);
    taskWts.set(task.id, wt);
    run('UPDATE tasks SET worktree=:w WHERE id=:id', { w: wt.dir, id: task.id });
    return wt;
  }

  async function handle(task, project, res, signal) {
    // Plan tasks record their own limits in plannerRun and run the planner on their own agent.
    const ran = task.kind === 'plan' ? plannerAgent(task.agent) : task.ran_agent || 'claude';
    const ranModel = task.kind === 'plan' ? task.model : task.ran_model;
    if (task.kind !== 'plan') recordGovernor(res, ran, ranModel);
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
      if (ran !== 'claude') return logEvent(`#${tid} hit the ${limitName(ran, ranModel)} usage limit; ${task.kind === 'plan' ? `resumes ${fmtAt(blockedUntilFor(ran, ranModel) || now())}` : 'retrying on Claude'}`, { level: 'warn', projectId: pid, taskId: tid });
      const u = blockedUntil();
      return logEvent(`⏸ #${tid} hit the Claude ${res.limitType || 'usage'} limit; resumes ${u ? fmtAt(u) : 'soon'}`, { level: 'warn', projectId: pid, taskId: tid });
    }
    if (res.outcome === 'auth_error' && ran !== 'claude') {
      requeueIfRunning(tid);
      kvSet(`agent_auth_failed:${ran}`, now() + 600);
      pushState();
      return logEvent(`${agentName(ran)} is not signed in; its tasks run on Claude for 10 min`, { level: 'error', projectId: pid, taskId: tid });
    }
    if (res.outcome === 'auth_error') {
      requeueIfRunning(tid);
      kvSet('blocked_until', now() + 600);
      kvSet('blocked_known', 0);
      kvSet('blocked_reason', 'Claude Code is not signed in');
      pushState();
      return logEvent('Claude Code is not authenticated; rechecking every 10 min', { level: 'error', projectId: pid, taskId: tid });
    }
    if (res.outcome === 'aborted' && res.lost) {
      // Its machine vanished: the next run (another node, or here) starts fresh from the pushed WIP branch with a
      // handoff prompt. The first loss costs no attempt; repeated ones do.
      const again = /^\[lost\]/.test(task.last_error || ''), attempts = task.attempts + (again ? 1 : 0);
      if (attempts >= CFG.maxAttempts) return fail(task, project, 'lost', res.text);
      return requeueIfRunning(tid, { session_id: null, attempts, not_before: 0, last_error: res.text.slice(0, 2000) });
    }
    if (res.outcome === 'aborted' && stopIntents.has(tid)) return requeueIfRunning(tid, { session_id: res.sessionId || task.session_id }); // applyStopIntent takes it from here
    if (res.outcome === 'aborted') {
      requeueIfRunning(tid, { session_id: res.sessionId || task.session_id, not_before: now() + 5 });
      return logEvent(`#${tid} interrupted; will continue later`, { projectId: pid, taskId: tid });
    }
    // Stopped by the owner (pause/handoff) and the agent exited with an error on the way out: no attempt is spent.
    if (stopIntents.has(tid)) return requeueIfRunning(tid, { session_id: res.sessionId || task.session_id });
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
    const tid = task.id, remote = res.remote || null;
    let wt = taskWts.get(tid), dir = wt?.cwd || project.path;
    const [status, note] = parseStatus(res.text);
    if (status === 'continue' && task.continuations < CFG.maxContinuations) {
      // A remote task's notes stay in its run log: its checkout is on the worker, not in this main tree.
      if (!remote) recordResult(dir, task, `in progress (${task.continuations + 1})`, res.text);
      if (!wt && !remote) await gitCommit(project.path, `agent-orch #${tid} (in progress): ${task.title}`); // a worktree just stays as it is
      requeueIfRunning(tid, { continuations: task.continuations + 1, session_id: res.sessionId || task.session_id, result: res.text });
      return logEvent(`↻ #${tid} not finished yet: ${note.slice(0, 160) || 'continuing'}`, { projectId: project.id, taskId: tid });
    }
    if (status === 'continue') return fail(task, project, 'unfinished', `still not done after ${CFG.maxContinuations} sessions: ${note}`);
    if (task.integrates && wt) {
      const left = await unresolvedFiles(wt.dir);
      if (left.length) return verifyFailed(task, project, res, 'resolve every merge conflict', `Still conflicted: ${left.join(', ')}`);
    }
    const command = extractCommand(task.done_when);
    let checked = '';
    if (command) {
      logEvent(`checking #${tid}: ${command}`, { projectId: project.id, taskId: tid });
      let ok, output, code;
      if (remote) [ok, output, code] = remote.check ? [remote.check.pass, remote.check.output, remote.check.code] : [false, 'command not found: the worker ran no check', 127]; // the worker ran it in its checkout
      else {
        try { [ok, output, code] = await runCheck(command, dir, agentEnv, CFG.verifyTimeoutSec, signal); }
        catch (e) { ok = false; output = `verification crashed: ${e?.message || e}`; }
      }
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
    if (remote) { wt = await remoteWorktree(task, project, remote.sha); dir = wt.cwd; }
    recordResult(dir, task, `done${checked}`, res.text);
    let sha;
    if (wt) {
      const merged = await mergeTask(task, project, wt, `agent-orch #${tid}: ${task.title}`);
      if (merged.conflict) {
        // An integrator whose base moved on again just goes another round in the same worktree.
        if (task.integrates) return verifyFailed(task, project, res, `merge ${wt.info.branch} again`, `${wt.info.branch} changed meanwhile; conflicts in: ${merged.conflict.join(', ')}`);
        return needsIntegration(task, project, res, wt, merged.conflict);
      }
      sha = merged.sha;
      // Merged: a branch a worker pushed (this run's, or a lost run's WIP this one continued) is done.
      if (remote || task.wip_sha) await git(project.path, ['push', '-q', 'origin', '--delete', taskBranch(tid)]).catch(() => {});
    } else sha = await gitCommit(project.path, `agent-orch #${tid}: ${task.title}`);
    if (!updateTask(tid, { status: 'done', finished_at: now(), result: res.text, session_id: res.sessionId, verify_output: null, commit_sha: sha || null }, true)) return;
    logEvent(`✔ #${tid} done${checked}: ${task.title}${sha ? ` (commit ${sha})` : ''}`, { projectId: project.id, taskId: tid });
    if (task.integrates && updateTask(task.integrates, { status: 'done', finished_at: now(), commit_sha: sha || null, result: `Merged by integrator #${tid}.` })) {
      logEvent(`✔ #${task.integrates} merged by integrator #${tid}`, { projectId: project.id, taskId: task.integrates });
    }
  }

  // The rebase onto the main branch conflicted: keep the worktree, mark the task and queue an integrator for it.
  function needsIntegration(task, project, res, wt, files) {
    const tid = task.id, branch = wt.info.branch;
    const note = `Its branch ${wt.branch} conflicts with ${branch} in: ${files.join(', ')}. The work is kept in ${wt.dir}.`;
    if (!updateTask(tid, { status: 'needs_integration', finished_at: now(), result: note, session_id: res.sessionId, verify_output: null }, true)) return;
    const prompt = `Task #${tid} ("${task.title}") finished in its own git worktree, but its branch \`${wt.branch}\` conflicts with ` +
      `\`${branch}\`, which changed meanwhile (conflicting files: ${files.join(', ')}). You are in that worktree, and the orchestrator ` +
      `has started merging \`${branch}\` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both ` +
      `${branch}'s changes and task #${tid}'s intent survive, then verify the result still works. Don't commit, and don't abort the merge.\n\n` +
      `Task #${tid}'s instructions were:\n\n${task.prompt}`;
    const iid = addTask(project.id, { title: `Integrate #${tid}: ${task.title}`.slice(0, 200), prompt, source: task.source, priority: task.priority + 10,
      doneWhen: task.done_when, agent: task.agent, model: task.model, origin: task.origin, fallbacks: parseFallbacks(task.fallbacks), files: parseFiles(task.files) });
    run('UPDATE tasks SET integrates=:t WHERE id=:id', { t: tid, id: iid });
    updateTask(tid, { result: `${note} Integrator #${iid} merges it.` });
    logEvent(`⚠ #${tid} needs integration: conflicts with ${branch} in ${files.join(', ')}; queued integrator #${iid}`, { level: 'warn', projectId: project.id, taskId: tid });
  }

  async function verifyFailed(task, project, res, command, output) {
    const tid = task.id;
    retireSession(res.sessionId, 'verify_failed');
    if (task.continuations >= CFG.maxContinuations) {
      return fail(task, project, 'verification', `\`${command}\` still failing after ${CFG.maxContinuations} sessions:\n${output.slice(-1500)}`);
    }
    const wt = taskWts.get(tid), remote = nodeOf(tid) !== LOCAL_NODE;
    if (!remote) recordResult(wt?.cwd || project.path, task, `verify failed (${task.continuations + 1})`, `Command: ${command}\n\n${output}`);
    if (!wt && !remote) await gitCommit(project.path, `agent-orch #${tid} (in progress): ${task.title}`);
    requeueIfRunning(tid, { continuations: task.continuations + 1, session_id: res.sessionId || task.session_id, result: res.text, verify_output: output });
    logEvent(`↻ #${tid} done-when check failed: ${command}\n${output.slice(0, 300)}`, { projectId: project.id, taskId: tid });
  }

  async function fail(task, project, outcome, detail) {
    const tid = task.id;
    if (!updateTask(tid, { status: 'failed', attempts: task.attempts + 1, finished_at: now(), result: detail }, true)) return;
    if (task.kind === 'work' && (taskWts.get(tid) || nodeOf(tid) === LOCAL_NODE)) { // a remote run's partial work stays on its pushed branch
      const wt = taskWts.get(tid);
      recordResult(wt?.cwd || project.path, task, `failed (${outcome})`, detail);
      if (!wt) await gitCommit(project.path, `agent-orch #${tid} failed: ${task.title} (partial work)`); // else execute() parks the worktree
    }
    const blocked = cascadeBlock(tid, 'failed', `${blockedPrefix(tid)}(${outcome})`);
    logEvent(`✖ #${tid} failed (${outcome}): ${String(detail).slice(0, 200)}${blocked.length ? `; blocked ${blocked.map((b) => `#${b}`).join(', ')}` : ''}`,
      { level: 'error', projectId: project.id, taskId: tid });
    releaseOwner(task, 'failed', `(${outcome}) ${detail}`);
  }

  async function finishReflection(task, project, res) {
    const [clean, payload] = extractTasks(res.text);
    // The project's curated reflection fallbacks are snapshotted, so a later edit doesn't change what's already queued.
    const fresh = getProject(project.id);
    const ids = queuePayload(fresh, payload, 'reflection', { fallbacks: reflectFallbacksFor(fresh) });
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

  // ---- review checkpoints (kind 'review'): never run an agent. A checkpoint stays queued until its prerequisites are
  // done, then waits in 'awaiting_review' (tasks.result: JSON review context) until the owner approves it (→ done, which
  // releases its dependents) or requests changes (a fix task goes ahead of it and it re-arms once the fix is done).
  const followersOf = (id) => qa("SELECT DISTINCT x.task_id AS id FROM all_deps x JOIN tasks t ON t.id=x.task_id WHERE x.depends_on=:id AND t.status='queued'", { id }).map((r) => r.id);
  // Task `t` stops waiting for `from` and waits for `to` (an id or ids) instead.
  function relink(t, from, to) {
    run('DELETE FROM task_deps WHERE task_id=:t AND depends_on=:f', { t, f: from });
    const ids = (Array.isArray(to) ? to : [to]).filter((d) => d != null && d !== t);
    for (const d of ids) run('INSERT OR IGNORE INTO task_deps(task_id, depends_on) VALUES(:t,:d)', { t, d });
    run('UPDATE tasks SET depends_on=:d WHERE id=:t AND depends_on=:f', { t, f: from, d: ids[0] ?? null });
    pushTask(t);
  }
  // A checkpoint after `deps`; the queued tasks that needed any of them now wait for the checkpoint instead.
  function addCheckpoint(projectId, deps, { title, source = 'user', origin = null, relinkNow = true } = {}) {
    const id = addTask(projectId, { title, prompt: '(review checkpoint)', kind: 'review', source, origin, dependsOn: deps, position: insertPosition(projectId, Infinity, deps) });
    if (relinkNow) relinkTo(id, deps);
    return id;
  }
  const relinkTo = (cp, deps) => { for (const d of deps) for (const f of followersOf(d)) if (f !== cp) relink(f, d, cp); };
  function insertCheckpoint(id) {
    const task = getTask(id);
    if (!task) return { error: 'No such task', status: 404 };
    if (task.kind !== 'work' || !['queued', 'running'].includes(task.status)) return { error: 'Review breaks go after queued or running work tasks', status: 409 };
    const dup = qa("SELECT t.id FROM all_deps x JOIN tasks t ON t.id=x.task_id WHERE x.depends_on=:id AND t.kind='review' AND t.status IN ('queued','awaiting_review')", { id })[0];
    if (dup) return { error: `#${id} already has a review break (#${dup.id})`, status: 409 };
    db.exec('BEGIN IMMEDIATE'); // the checkpoint and its re-linked followers land together
    let cp;
    try { cp = addCheckpoint(task.project_id, [id], { title: `Review: ${task.title}`.slice(0, 200) }); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    logEvent(`⚑ review break #${cp} after #${id}`, { projectId: task.project_id, taskId: cp });
    return { ok: true, task: taskView(getTask(cp)) };
  }
  // The task a checkpoint reviews: its most recently finished prerequisite (after a round of changes, the fix task).
  const reviewedTask = (cp) => depsOf(cp.id).map(getTask).filter((t) => t?.status === 'done').sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))[0] || null;
  function taskShots(taskId) {
    const out = new Map();
    for (const r of qa('SELECT log_path FROM runs WHERE task_id=:t ORDER BY id', { t: taskId })) {
      try { for (const e of parseJsonl(fs.readFileSync(r.log_path, 'utf8'))) if (e.k === 'image' && e.id) out.set(e.id, { id: e.id, name: e.name, w: e.w, h: e.h }); } catch {}
    }
    return [...out.values()].slice(-12);
  }
  async function changedFiles(project, sha) {
    if (!sha) return [];
    try {
      return (await git(project.path, ['show', '--name-status', '--format=', sha])).split('\n').filter(Boolean).slice(0, 200)
        .map((l) => { const [st, ...f] = l.split('\t'); return { status: st[0], path: f[f.length - 1] }; });
    } catch { return []; }
  }
  function armCheckpoints() {
    for (const cp of qa(`SELECT t.* FROM tasks t WHERE t.kind='review' AND t.status='queued'
      AND NOT EXISTS(SELECT 1 FROM all_deps x LEFT JOIN tasks d ON d.id=x.depends_on WHERE x.task_id=t.id AND d.status IS NOT 'done')`)) {
      const reviewed = reviewedTask(cp), project = getProject(cp.project_id);
      const ctx = reviewed ? { task: reviewed.id, title: reviewed.title, summary: parseStatus(reviewed.result)[1] || null, commit: reviewed.commit_sha || null,
        files: [], shots: taskShots(reviewed.id) } : null;
      if (!run("UPDATE tasks SET status='awaiting_review', started_at=:t, result=:r WHERE id=:id AND status='queued'", { t: now(), r: JSON.stringify(ctx), id: cp.id }).changes) continue;
      pushTask(cp.id);
      logEvent(`⚑ #${cp.id} waits for your review${reviewed ? ` of #${reviewed.id}` : ''}`, { projectId: cp.project_id, taskId: cp.id });
      if (project.convo_id && convoExists(project.convo_id)) {
        emitChat(project.convo_id, { t: 'notice', text: `Review break: ${reviewed ? `#${reviewed.id} ${reviewed.title} is done. ` : ''}Approve it to continue the queue, or request changes.` });
        emitChat(project.convo_id, { t: 'tasks', ids: [cp.id], source: 'review' });
      }
      changedFiles(project, ctx?.commit).then((files) => {
        if (!files.length || getTask(cp.id)?.status !== 'awaiting_review') return;
        run('UPDATE tasks SET result=:r WHERE id=:id', { r: JSON.stringify({ ...ctx, files }), id: cp.id });
        pushTask(cp.id);
      });
    }
  }
  function approveCheckpoint(id) {
    const cp = getTask(id);
    if (!cp || cp.kind !== 'review') return { error: 'No such review break', status: 404 };
    if (cp.status !== 'awaiting_review') return { error: `#${id} is ${cp.status}, not waiting for review`, status: 409 };
    updateTask(id, { status: 'done', finished_at: now() });
    logEvent(`✔ #${id} approved; the queue continues`, { projectId: cp.project_id, taskId: id });
    setTimeout(tick, 100);
    return { ok: true, task: taskView(getTask(id)) };
  }
  const changing = new Set(); // checkpoint ids with a request-changes in flight (it awaits git)
  async function requestChanges(id, note) {
    const cp = getTask(id);
    note = String(note ?? '').trim().slice(0, 8000);
    if (!cp || cp.kind !== 'review') return { error: 'No such review break', status: 404 };
    if (cp.status !== 'awaiting_review' || changing.has(id)) return { error: `#${id} is not waiting for review`, status: 409 };
    if (!note) return { error: 'Say what should change', status: 400 };
    changing.add(id);
    try {
      const project = getProject(cp.project_id), reviewed = reviewedTask(cp), deps = depsOf(id);
      let diff = '';
      if (reviewed?.commit_sha) diff = await git(project.path, ['show', '--stat', '--patch', '--format=%h %s', reviewed.commit_sha]).catch(() => '');
      if (diff.length > 12000) diff = `${diff.slice(0, 12000)}\n… (diff truncated; run \`git show ${reviewed.commit_sha}\` for the rest)`;
      const prompt = [`The owner reviewed #${reviewed?.id ?? '?'} "${reviewed?.title || cp.title}" and asked for changes:`, note,
        reviewed ? `The reviewed task's instructions were:\n${String(reviewed.prompt).slice(0, 4000)}` : '',
        diff ? `What it changed (commit ${reviewed.commit_sha}):\n\`\`\`diff\n${diff}\n\`\`\`` : '',
        "Make the requested changes. Keep everything the owner didn't ask to change."].filter(Boolean).join('\n\n');
      const fix = addTask(project.id, { title: `Changes after review: ${reviewed?.title || cp.title}`.slice(0, 200), prompt, kind: 'work', source: 'user', dependsOn: deps,
        doneWhen: reviewed?.done_when ?? null, agent: reviewed?.agent ?? null, model: reviewed?.model ?? null, origin: reviewed?.origin ?? null,
        fallbacks: parseFallbacks(reviewed?.fallbacks), files: reviewed?.files ?? null, position: insertPosition(project.id, Infinity, deps) });
      writeTaskSpec(project.path, getTask(fix));
      run('INSERT OR IGNORE INTO task_deps(task_id, depends_on) VALUES(:t,:d)', { t: id, d: fix });
      run("UPDATE tasks SET status='queued', result=NULL, started_at=NULL WHERE id=:id", { id });
      pushTask(id);
      logEvent(`↺ #${id} changes requested: #${fix} queued, then the review break comes back`, { projectId: project.id, taskId: id });
      setTimeout(tick, 100);
      return { ok: true, fix, task: taskView(getTask(id)) };
    } finally { changing.delete(id); }
  }

  // ---- owner actions from the task drawer
  function taskAction(id, action, value) {
    const task = getTask(id);
    if (!task) return { error: 'No such task' };
    switch (action) {
      // The drawer's per-task effort override: a level of the agent the task would run on now, or null to follow the
      // chat's live effort again. Takes effect at the task's next session boundary.
      case 'effort': {
        if (value == null || value === '') { updateTask(id, { effort: null }); return { ok: true }; }
        const agent = routeNow(task, getProject(task.project_id)).agent;
        if (!agentEfforts(agent).includes(value)) return { error: agentEfforts(agent).length ? `${agent} takes ${agentEfforts(agent).join(', ')}` : `${agent} has no effort levels` };
        updateTask(id, { effort: value });
        logEvent(`#${id} effort: ${value}`, { projectId: task.project_id, taskId: id });
        return { ok: true };
      }
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
        // Manual position is the primary order within the project, so it also goes to the front of its queue
        // (unless a queued prerequisite has to finish first).
        const queue = queuedInOrder(task.project_id).filter((r) => r.position != null && r.id !== id);
        const front = queue.length && !prereqIds(depsOf(task.id)).some((up) => queue.some((r) => r.id === up)) ? { position: queue[0].position - 1 } : {};
        updateTask(id, { priority: Math.max(task.priority, top - own + 5), urgency: 'urgent', not_before: 0, ...front });
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
        if (!['queued', 'running', 'paused', 'needs_integration', 'awaiting_review'].includes(task.status)) return { error: 'Only waiting, paused or running tasks can be cancelled' };
        updateTask(id, { status: 'cancelled', finished_at: now() });
        if (task.kind === 'review') { // removing a review break: what waited for it follows its prerequisites again
          const deps = depsOf(id);
          for (const f of followersOf(id)) relink(f, id, deps);
          logEvent(`■ review break #${id} removed`, { projectId: task.project_id, taskId: id });
          setTimeout(tick, 100);
          return { ok: true };
        }
        running.get(id)?.abort.abort();
        // A paused task has no run whose end would park its worktree: park it here (the work stays on its branch).
        if (task.status === 'paused' && task.worktree) parkTask(getProject(task.project_id), id, `agent-orch #${id} cancelled: ${task.title} (partial work)`).catch(() => {});
        if (task.status === 'needs_integration') {
          // Its integrators go too, and the worktree is parked on its branch.
          for (const r of qa("SELECT id FROM tasks WHERE integrates=:id AND status IN ('queued','running')", { id })) {
            updateTask(r.id, { status: 'cancelled', finished_at: now(), result: `cancelled with #${id}` });
            running.get(r.id)?.abort.abort();
          }
          const project = getProject(task.project_id);
          setTimeout(() => { if (!qa("SELECT id FROM tasks WHERE integrates=:id AND status='running'", { id }).length) parkTask(project, id, `agent-orch #${id} cancelled: ${task.title}`); }, 1000);
        }
        const blocked = cascadeBlock(id, 'cancelled', `cancelled with #${id}`);
        logEvent(`■ #${id} cancelled${blocked.length ? `; also ${blocked.map((b) => `#${b}`).join(', ')}` : ''}`, { projectId: task.project_id, taskId: id });
        releaseOwner(task, 'cancelled');
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
    if ('reflectDirection' in fields) {
      const d = String(fields.reflectDirection ?? '').trim().slice(0, REFLECT_DIRECTION_MAX) || null;
      if (d !== (p.reflect_direction || null)) {
        allowed.reflect_direction = d;
        // A new direction deserves a fresh look now, not after the "found nothing" cooldown.
        if (d) { allowed.next_reflect_at = 0; kvSet(`reflect_empty_streak:${id}`, 0); }
      }
    }
    updateProject(id, allowed);
    if (allowed.status === 'paused') pauseProject(id);
    logEvent(`project settings: ${JSON.stringify(allowed)}`, { projectId: id });
    setTimeout(tick, 100);
    return { ok: true };
  }
  function setTaskFallbacks(id, list) {
    const t = getTask(id);
    if (!t) return { error: 'No such task', status: 404 };
    if (t.kind !== 'work' || !['queued', 'running'].includes(t.status)) return { error: 'Only queued or running work tasks can edit fallbacks', status: 409 };
    updateTask(id, { fallbacks: list == null ? null : JSON.stringify(list) });
    delegateTried.delete(id);
    return { ok: true, task: taskView(getTask(id)) };
  }
  // Reflection fallbacks (list already validated by the server): [{agent, model}] or null = none.
  function setReflectFallbacks(id, list) {
    if (!getProject(id)) return { error: 'No such project', status: 404 };
    updateProject(id, { reflect_fallbacks: list == null ? null : JSON.stringify(list) });
    logEvent(`reflection fallbacks: ${list == null ? 'none' : list.map((f) => `${f.agent}/${f.model}`).join(' → ') || 'none'}`, { projectId: id });
    return { ok: true, project: projectView(getProject(id)) };
  }
  // A project's reflection settings (Settings → This project): its reflect tasks run on agent/model (null = routes, else
  // Claude), and they and the work they queue snapshot fallbacks (null = none: they wait at a limit).
  const reflectFor = (p) => ({ agent: p.reflect_agent || null, model: p.reflect_model || null, fallbacks: parseFallbacks(p.reflect_fallbacks) });
  // v: {model?: {agent, model} | null, fallbacks?: [{agent, model}] | null}, already validated by the server.
  function setReflectSettings(id, v) {
    const p = getProject(id);
    if (!p) return { error: 'No such project', status: 404 };
    const f = {};
    if ('model' in v) { f.reflect_agent = v.model?.agent || null; f.reflect_model = v.model?.model || null; }
    if ('fallbacks' in v) f.reflect_fallbacks = v.fallbacks == null ? null : JSON.stringify(v.fallbacks);
    updateProject(id, f);
    const next = reflectFor(getProject(id));
    logEvent(`reflection: ${next.agent ? `${next.agent}/${next.model || 'default'}` : 'default model'}; fallbacks ${next.fallbacks?.map((x) => `${x.agent}/${x.model}`).join(' → ') || 'none'}`, { projectId: id });
    return { ok: true, reflect: next, project: projectView(getProject(id)) };
  }
  const reflectFallbacksFor = (p) => reflectFor(p).fallbacks;
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
      priority: t.priority, deadline: t.deadline, depends_on: t.depends_on, attempts: t.attempts, position: t.position ?? null,
      effort: t.effort ?? null, // the owner's per-task override (null = the chat's live effort)
      // deps: every direct prerequisite (all must be done); prereqs: unfinished tasks up the prerequisite graph (must finish
      // first); dependents: the queued subtree that moves with it. files: what it declared it modifies (null = everything).
      deps: depsOf(t.id), prereqs: prereqIds(depsOf(t.id)), dependents: dependentIds(t.id), files: parseFiles(t.files),
      continuations: t.continuations, not_before: t.not_before, source: t.source, created_at: t.created_at,
      started_at: t.started_at, finished_at: t.finished_at, commit_sha: t.commit_sha,
      agent: t.agent, model: t.model, ran_agent: t.ran_agent, ran_model: t.ran_model, route_note: t.route_note ?? null,
      origin: t.origin ?? null, delegated_from: t.delegated_from ?? null, delegated_reason: t.delegated_reason ?? null, fallbacks: parseFallbacks(t.fallbacks), has_verify_failure: t.verify_output != null,
      // The agent a queued task would run on now: the UI shows it waiting only while its limit scope (limit_scope, a
      // state.blocks key: the agent) is limited.
      // runs_model: that route's model (the agent's default when the route names none). moves: every delegation, oldest first.
      moves: parseJsonList(t.moves),
      ...(() => { if (t.status !== 'queued') return { runs_on: null, runs_model: null, limit_scope: null };
        const r = routeNow(t, getProject(t.project_id));
        return { runs_on: r.agent, runs_model: r.model || delegator.defaultModel(r.agent), limit_scope: limitScope(r.agent, r.model) }; })(),
      summary: t.kind === 'review' ? (t.status === 'done' ? 'Approved' : ['failed', 'cancelled'].includes(t.status) ? String(t.result || '').slice(0, 200) || null : null)
        : t.status === 'done' ? parseStatus(t.result)[1] || null : ['failed', 'cancelled', 'needs_integration'].includes(t.status) ? String(t.result || '').slice(0, 200) : null,
      // A review checkpoint waiting for the owner: {task, title, summary, commit, files: [{status, path}], shots: [media]}.
      review: t.kind === 'review' && t.status === 'awaiting_review' ? (() => { try { return JSON.parse(t.result); } catch { return null; } })() : null,
      worktree: t.worktree ?? null, integrates: t.integrates ?? null,
      // Where it runs (or last ran): a worker's id and name; null/controller = this server.
      node: t.node_id ?? null, node_name: t.node_id && t.node_id !== LOCAL_NODE ? nodeName(t.node_id) : null,
      // A remote run whose node went away (within its grace period): 'Mac mini (Mac asleep)'.
      waiting_for: running.get(t.id)?.waiting || null,
    };
  }
  function projectView(p) {
    if (!p) return null;
    const c = q1(`SELECT SUM(status='queued') AS queued, SUM(status='running') AS running, SUM(status='done') AS done,
      SUM(status='failed') AS failed FROM tasks WHERE project_id=:p AND kind!='plan'`, { p: p.id }) || {};
    return {
      id: p.id, name: p.name, path: p.path, convo_id: p.convo_id, status: p.status, priority: p.priority, position: p.position ?? null, mode: p.mode,
      perpetual: !!p.perpetual, autonomous: !!p.autonomous, next_reflect_at: p.next_reflect_at, ready: !!projectReady(p.path),
      counts: { queued: c.queued || 0, running: c.running || 0, done: c.done || 0, failed: c.failed || 0 },
      reflect_fallbacks: parseFallbacks(p.reflect_fallbacks), reflect_direction: p.reflect_direction || null, reflect: reflectFor(p),
      // What a reflect task starts on when Settings names no reflection model (a 'reflect' route, else the chat's model).
      reflect_route: (({ agent, model }) => ({ agent, model: model || delegator.defaultModel(agent) }))(intendedRoute({ kind: 'reflect', title: 'Reflect: what else should be done?', prompt: '' }, p)),
      // What its work tasks (and so reflection-queued ones) start on: the "primary" the reflection fallbacks back up.
      work_route: (({ agent, model }) => ({ agent, model: model || delegator.defaultModel(agent) }))(intendedRoute({ kind: 'work', title: '', prompt: '' }, p)),
      routes: listRoutes(p.id).map((r) => ({ id: r.id, scope: r.project_id == null ? 'global' : 'project', match: r.match, agent: r.agent, model: r.model, note: r.note })),
    };
  }
  function stateView() {
    const d = decisionCache?.d;
    // blocks: every limit scope (agent) currently at its usage limit →
    // { until, known, reason } (`until` is when it really resets).
    const blocks = {};
    for (const id of limitScopes(Object.keys(AGENTS))) {
      const u = blockedUntilOf(id);
      if (u) blocks[id] = { until: u, known: kvGet(limitKey('blocked_known', id), '0') === '1', reason: kvGet(limitKey('blocked_reason', id)) || 'usage limit' };
    }
    const activeUsage = qa("SELECT DISTINCT CASE WHEN kind='plan' THEN COALESCE(agent, 'claude') ELSE COALESCE(ran_agent, agent, 'claude') END AS agent FROM tasks WHERE status='running'");
    const mem = readMemInfo(CFG.meminfo), parallel = { ...parallelSettings(), memAvailable: mem.avail, swapPct: mem.swapPct };
    const lanes = [...running.entries()].map(([id, r]) => {
      const t = getTask(id);
      return { agent: r.agent, task: id, project_id: r.projectId, title: t.title, model: t.ran_model || t.model || delegator.defaultModel(r.agent),
        activity: r.activity || null, started_at: r.startedAt, elapsed: Math.max(0, now() - r.startedAt), node: r.node, node_name: r.node === LOCAL_NODE ? null : nodeName(r.node), waiting_for: r.waiting || null };
    });
    return { activeUsage, blocks, blockedUntil: blockedUntil(), blockedReason: kvGet('blocked_reason'),
      pacing: d?.reason || kvGet('budget_reason'), slots: slotCount(d, mem), parallel, lanes, capacity: capacityView(d, mem),
      running: running.size, workRunning: workRunning(), remoteRunning: workEverywhere() - workRunning(), draining, subscription: onSubscription() };
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
      return { id: r.id, outcome: r.outcome, started_at: r.started_at, finished_at: r.finished_at, turns: r.num_turns, output_tokens: r.output_tokens,
        agent: r.agent || 'claude', effort: r.effort ?? null, entries };
    });
    return {
      task: { ...taskView(t), prompt: t.prompt, done_when: t.done_when, result: t.result, last_error: t.last_error, verify_output: t.verify_output, check: extractCommand(t.done_when) },
      eff: effectivePriority(t, project),
      project: projectView(project),
      dependsOn: t.depends_on ? taskView(getTask(t.depends_on)) : null,
      after: depsOf(id).map((d) => taskView(getTask(d))).filter(Boolean),
      followers: qa('SELECT t.* FROM all_deps x JOIN tasks t ON t.id=x.task_id WHERE x.depends_on=:id ORDER BY t.id', { id }).map(taskView),
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
  if (disabled) {
    console.log('[orchestrator] disabled (CW_NO_ORCHESTRATOR=1): not requeueing or scheduling tasks');
  } else if (leader.ok) {
    // Work running on a worker keeps running there: it is re-adopted when the hub is attached (attachCluster).
    const remoteSql = "status='running' AND kind='work' AND node_id IS NOT NULL AND node_id!=:l";
    adoptable = qa(`SELECT id FROM tasks WHERE ${remoteSql}`, { l: LOCAL_NODE }).map((r) => r.id);
    const orphans = run(`UPDATE tasks SET status='queued' WHERE status='running' AND NOT (${remoteSql})`, { l: LOCAL_NODE }).changes;
    run(`UPDATE runs SET outcome='error', finished_at=:t WHERE finished_at IS NULL
      AND id NOT IN (SELECT MAX(id) FROM runs WHERE task_id IN (SELECT value FROM json_each(:k)) GROUP BY task_id)`, { t: now(), k: JSON.stringify(adoptable) });
    if (orphans) logEvent(`requeued ${orphans} interrupted task(s) after a restart`);
    cleanupWorktrees(); // per-project merge lock: a claim in the same project waits for it
    reconcileCodexLimit();
    setInterval(tick, CFG.pollMs);
    setInterval(memGuard, CFG.memCheckMs);
    setTimeout(tick, 5000);
    // A limit that has passed: capacity is back, so refresh usage for pacing.
    setInterval(() => {
      if (reconcileClaudeLimit()) tick();
      for (const id of limitScopes(Object.keys(AGENTS))) {
        const key = limitKey('blocked_until', id);
        if (blockedUntilOf(id) || kvGet(key, '0') === '0') continue;
        kvSet(key, 0); usageLog.limitCleared(id); pushState();
        if (id === 'claude') refreshUsage?.();
      }
    }, 15000);
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
    planTurn, abortPlan, nextModel, delegateOptions, delegateTask, taskAction, moveTask, insertCheckpoint, approveCheckpoint, requestChanges, reorderProjects, changeMessage, projectAction, setTaskFallbacks, setReflectFallbacks, setReflectSettings, syncConvoModel, pauseTask, resumeTask, handoffTask, setConvoMode, detachConvo, convoSnapshot, taskDetail, watchTask,
    drain, undrain, chatPlanning, stateView, setParallelSettings, limitResetFor, recordLimit: recordGovernor, reconcileCodexLimit, reconcileClaudeLimit, projectFor: (convo) => projectView(q1('SELECT * FROM projects WHERE path=:p', { p: convo.cwd })),
    // A sidebar chat's project rank ({id, position, priority}), or null when its folder has no orchestrator project.
    projectRank: (cwd) => q1('SELECT id, position, priority FROM projects WHERE path=:p', { p: cwd }) ?? null,
    isRunning: (id) => running.has(Number(id)), logEvent, attachCluster,
    unwatch: (ws) => { for (const set of runSubs.values()) set.delete(ws); },
  };
}
