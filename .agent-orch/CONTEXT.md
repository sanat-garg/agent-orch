# Project Context

_What the code doesn't say. History: JOURNAL.md. Bugs: AUDIT.md. Mobile HIG rows: UI-REVIEW.md. Cluster: CLUSTER.md. Computer work: AGENTIC.md. CLI flags and stream formats: AGENTS.md. Setup: README.md. Each module's header comment explains its job and API: read it first._

## Architecture (cross-module rules)
- Head = `server.mjs` (http + ws, chat, `public/`) + `orchestrator.mjs` (node:sqlite DB under `data/orchestrator/`; planner / work / reflection loop; `createOrchestrator({config})` overrides CFG in tests).
- Agents (`agents.mjs`): model lists come only from each CLI (`models.mjs`, cached daily); limits are per agent and never polled. Every discovery/limit/sign-in helper goes through `helpers.mjs runHelper`, never raw execFile/spawnSync.
- Routing: task agent/model → project route → global route → Claude on project.model. Sessions resume only on the agent and node that made them. Delegation moves a task only if its `tasks.fallbacks` snapshot is non-empty; UI wording comes only from app.js `modelStatus(task)`.
- Keep improving (`projects.perpetual`, Settings → This project) off = no reflection: `scheduleReflections` is the only creator of reflect tasks, RUNNABLE never claims one of an off project, `cancelReflections` cancels waiting ones and `finishReflection` discards a running one's tasks. Planner chat is unaffected.
- Pause/resume/handoff set `stopIntents`, applied only when the run ended requeued. A paused project keeps its queued plan task until resumed.
- Work tasks run in `<repo>/../.agent-orch-worktrees/<repo>-task-<id>` on branch `agent-orch/task-<id>`. Only `mergeTask` touches the main tree, under `serialGit`; a rebase conflict → `needs_integration` + an integrator task. `tasks.files` (NULL = everything) + `filesOverlap` decide what runs in parallel. `kind='review'` tasks never run.
- Placement: a work task goes to the free worker with the agent signed in and most headroom, else the controller; `tasks.run_on` pins one. Plan/reflect/integrators, tasks with a live local worktree and projects without an https/ssh origin stay local. Lost remote jobs requeue from the pushed WIP branch.
- Controller work slots = kv `parallel_settings.parallelTasks` (1-16, default 4). Memory is only an emergency guard (`MEM.claimFloor`, `MEM.pauseBelow`), never a pre-emptive throttle (BRIEF goal 9).
- Cluster: `cluster-protocol.mjs` holds the wire format, `FEATURES` and `WORKER_ACCEPTS`; change it first, then test/cluster-protocol.test.mjs's expected lists, then CLUSTER.md. `worker.mjs` is compute-only and must never import server/orchestrator/cluster/runtimes: shared code goes in taskrun.mjs (test/compute-only.test.mjs walks the import graph).
- Extensions (`extensions.mjs`) reach runs via files, never argv. `ext.mcpRun(agent, run)` must get the run config (`{browser, gate}`) or the run gets neither the gate nor the browser.
- Browser tasks (`capabilities: ["browser"]`) run the pinned `@playwright/mcp` on a persistent profile, one running task per identity. The approval gate (`gate.mjs`, `approvals.mjs`) holds outbound MCP calls for the owner; proxy ↔ host talk only through files. Until AGENTIC.md's run sandbox exists (AUDIT #38) the gate is a log and a speed bump, not a hard stop. Screen prompts (`execution='browser'`) use the non-reflecting Browser project and finish on the final message, without git or checks.
- Web Push (`push.mjs`): everything goes through server.mjs `notify`, max one push per tag per 60 s.
- `public/`: vanilla JS SPA (app.js ~7k lines, then files/stats/ext/browser.js), classic scripts sharing one namespace (ui-static.test.mjs rejects duplicate functions). Reuse `toast`, `renderFallbackEditor`, `withUntil`, `fmtDur`. #orchBar stays minimal; settings live in the gear's Settings sheet.

## Conventions
- ESM `.mjs`, no build step, no framework, minimal deps. Match the terse style and comment density.
- Tests: `npm test` runs only the test files the diff from main can reach; `npm test -- test/x.test.mjs` runs named files; `npm run test:full` is for reflection only. Verify with the files you touched; the orchestrator runs Done-when itself. Copy a neighbouring test's setup (server tests spawn server.mjs on a free port with a temp `CW_DATA_DIR`; scheduler tests use `createOrchestrator` with a fake `query`; UI tests use playwright-core).
- Times: events carry `until` (epoch s); app.js `withUntil` formats in the browser. Never format times on the server except in logs.
- AUDIT.md items get `**Fixed**` + a one-line note; UI-REVIEW.md rows are marked fixed in place.
- Mobile: Apple HIG (apple-design skill). Modals need `grid-template-columns: minmax(0, 100%)`. 44px touch targets and 16px fields go in `@media (pointer: coarse)` blocks after the base rule; phone type sizes in the `max-width: 600px` block at the end of app.css. Filled buttons use `--accent-strong` (test/ui-contrast.test.mjs asserts ≥ 4.5:1 in both themes).
- macOS shell scripts must parse under bash 3.2 (test/install-macos-bash32.test.mjs): `cmd <<EOF`, not `cat <<EOF | cmd`; under `set -u` an empty `"${arr[@]}"` is unbound; no `declare -A`, `mapfile`, `${x,,}`, `|&`, `local -n`.

## Decisions (beyond BRIEF.md)
- Subscriptions only: API_ENV stripping in server.mjs is what enforces it. Never weaken that.
- Local branch `backup/pre-agent-orch` must never be pushed. Local `claude/*` branches and `agent-orch/task-197/-199/-209` are the owner's unlanded work: never land or delete them unasked.
- `after` is for TRUE prerequisites only (cancelling cascades). Use `files` to keep parallel work apart. Rapid reflections target free cluster slots + two buffered tasks.
- System font stack only. No benchmark ranking of models, ever.
- Computer work follows AGENTIC.md's rollout (files-only workspace first). Connectors (Gmail etc.) only when the owner asks.

## Gotchas
- This checkout IS the live app. Never restart/kill it or call `POST /api/restart-when-idle` on port 3000. Test instances MUST use another port and `CW_DATA_DIR=$(mktemp -d)`. Server edits go live only on restart: a failing Done-when may be stale running code, and new DB tables don't exist until then.
- The verifier runs every command-like backtick snippet in Done-when (a whole runner word), joined with ` && `; `>` (except `2>&1`, `2>/dev/null`), `curl` and more than three `&&` are refused; `CI=1 ` and `cd <relative dir> && ` prefixes are fine. Absence checks use `! grep …`. A `|` inside a quoted grep pattern is regex, not a pipe.
- /tmp is a small tmpfs with a per-user quota; run heavy tests with `TMPDIR=` on the home disk. test/helper-kill.test.mjs is racy under load and can leave `test/fixtures/helper-parent.mjs` holding the shared test lock: kill that pid. Without `flock` (the MacBook) bin/test.mjs locks with `node_modules/.cache/agent-orch-test.lock.d`. A `--service daemon` Mac worker (LaunchDaemon, launchd system domain, non-root) cannot run Chrome or Chromium at all: they die at launch (SIGILL, "Mach rendezvous failed", even `--single-process`), and no non-root escape into the user domain exists. So test/approval-gate-browser.test.mjs fails on the MacBook even on untouched code; run real-browser checks on the VPS.
- On a macOS worker, some suites fail regardless of the change: compute-only's `/proc` check, cluster.test's controller-slot sizing, and UI tests' `renderMetrics` page error (no load averages on a macOS head; cluster-ping-ui.test.mjs filters it).
- `bin/agent-smoke.mjs` and `bin/orch-e2e.mjs` cost quota; never send Claude logout (`confirm: true`) in tests.
- Other sessions and orchestrator auto-commits touch the live checkout at once: re-read before editing. A branch failing in files you didn't touch is usually a stale snapshot base: fast-forward the worktree to main and re-run.
- Reflections: run the needed tests to a log first and emit the task block in the final message; never end the turn waiting on a background job. Check which files queued and running tasks hold before queuing; when AUDIT.md is held, queue the code fixes without it and one ledger task `after` them.
