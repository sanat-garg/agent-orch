# Project Context

_What the code doesn't say. Per-area rules (chats, users, files, previews, schedules, browser, cluster, Machines UI, phone UI…): AREAS.md, read the section you touch. History: JOURNAL.md. Also CLUSTER.md, AGENTIC.md, CHROME.md, AGENTS.md (CLI flags), README.md (setup). Read a module's header comment before changing it._

## Architecture
- Head = `server.mjs` (http + ws, chat via the Agent SDK, serves `public/`) + `orchestrator.mjs` (node:sqlite DB in `data/orchestrator/agent-orch.db`; planner / work / reflection loop; `createOrchestrator({config})` overrides CFG in tests). Workers run `worker.mjs` (compute-only, dials out over WSS); shared code lives in `taskrun.mjs`, never server/orchestrator imports (test/compute-only.test.mjs).
- Agents: Claude Code and Codex only (`agents.mjs`). Model lists come only from each CLI (`models.mjs`, cached daily); limits are per agent and never polled. Every CLI helper goes through `helpers.mjs runHelper`.
- Routing: task agent/model → project route → global route → Claude on the chat's model. Delegation moves a task only if its `tasks.fallbacks` snapshot is non-empty; UI wording comes only from app.js `modelStatus(task)`. Reflect tasks pick a random model from `projects.reflect_pool` and never delegate.
- Work tasks run in `<repo>/../.agent-orch-worktrees/<repo>-task-<id>` on branch `agent-orch/task-<id>`. Only `mergeTask` touches the main tree (under `serialGit`); a rebase conflict → `needs_integration` + an integrator task. Head pushes go only through github.mjs `pushBranch` (never `git push`, never forced). `tasks.files` + `filesOverlap` decide parallelism. `kind='review'` tasks never run and only the owner creates them.
- Chat turns auto-commit and push after each reply; chat logs hold commit shas, so never rebase or reset main.
- `public/`: vanilla JS SPA, classic scripts sharing one namespace (app.js ~10k lines, plus files/stats/ext/browser/previews/schedules/users/credentials/shots/commits/tokens.js). ui-static.test.mjs rejects duplicate function names and checks every `$('id')` exists in index.html. A NEW public file must be added to server.mjs's static allowlist (one long `p === '/x.js'` line) or it 404s. Reuse `toast`, `api`, `el`, `withUntil`, `fmtDur`, `renderFallbackEditor`, `openMenuFrom`.
- Updates: merged server code restarts the head automatically (`rolling.mjs`) when kv `parallel_settings.applyUpdates` is 'auto'; with 'manual' new endpoints stay 404 until a restart, so check the running build before debugging a "broken" new feature.

## Conventions
- ESM `.mjs`, no build step, no framework, minimal deps, system font stack. Match the terse style and comment density.
- Tests: `npm test` runs only test files the diff from main reaches; `npm test -- test/x.test.mjs` runs named files; `npm run test:full` is for reflection only. Copy a neighbouring test's setup: server tests spawn server.mjs on a free port with a temp `CW_DATA_DIR`; scheduler tests use `createOrchestrator` with a fake `query`; UI tests use playwright-core against a static/test server; wait for `!$("app").inert` (the splash lifts, then focuses #input) before driving focus or keys. A bare test origin's HEAD is `master`: clone it with `-b main`.
- Times: events carry `until` (epoch s) and the browser formats them (`withUntil`); the server never formats times except in logs.
- Mobile follows Apple's HIG (apple-design skill): 44px targets and 16px fields in `@media (pointer: coarse)`, phone layout in `public/phone.css` (loaded last), modals need `grid-template-columns: minmax(0, 100%)`, filled buttons use `--accent-strong` (contrast test ≥ 4.5:1). Phones never auto-focus #input.
- AUDIT.md items get `**Fixed**` + a one-line note; UI-REVIEW.md rows are marked fixed in place.
- Zen mode (app.js setZen, `.zen` on #app, localStorage `cw.zen` = start ms): `toast()` returns a detached no-op while in Zen and finish/approval sounds are skipped, so new notices need no Zen check of their own; owner-needed items surface only via `renderZenQuiet` (#zenQuiet). Zen CSS must not add a `.topbar {` rule (ui-static counts them): target `.app.zen .main > header`.
- macOS shell scripts must parse under bash 3.2 (test/install-macos-bash32.test.mjs).

## Decisions
- Subscriptions only: API_ENV stripping in server.mjs enforces it. Never weaken that.
- Feature-first (owner, 2026-10-10): planner and reflection lead with user-facing features, borrowing ideas from popular similar repos (ROADMAP.md "Inspiration"). Security/infrastructure work only when the owner asks or rigor ≥ 4. Rigor 1-5 per project (`projects.rigor`, orchestrator `RIGOR_LEVELS`) shapes planner/reflection prompts and the Rapid top-up cap.
- Leaving Orchestrator Mode only closes `projects.intake` (0: no reflection, Rapid top-up or plan-task claims; queued/running work finishes). Only Pause (`projects.status='paused'`) stops work.
- `after` only for true prerequisites (cancelling cascades); `files` keeps parallel work apart. In Rapid mode overlap never blocks a free slot; a merge conflict retries once, then gets an integrator.
- Placement uses every online machine; only sustained CPU saturation gates a node. RAM is only an emergency pause, never a placement gate (BRIEF goal 9).
- No benchmark ranking of models, ever. No Antigravity/OpenCode/Kiro/Copilot.
- Agents never give a project a public address: live previews are opt-in, set only by the owner (server.mjs `previewNote` tells every run).
- Local branch `backup/pre-agent-orch` must never be pushed; local `claude/*` and `agent-orch/task-197/-199/-209` branches are the owner's: never land or delete them unasked.
- Machines UI: every machine card and detail panel keeps the 'Assign task' button (`renderAssignButton`); the window opens only via `openMachines()`.

## Gotchas
- This checkout IS the live app (agent-orch.service on :3000). Never restart/kill it or call its restart endpoints, and never import server.mjs in a test or script (it boots the app; use `node --check`). Test servers use another port and `CW_DATA_DIR=$(mktemp -d)`. Never create a test chat on ~/workspace or a real folder: it gets a real private GitHub repo.
- The Done-when verifier runs every command-like backtick snippet joined with ` && `; it refuses `>` (except `2>&1`, `2>/dev/null`), `curl` and more than three `&&`. Absence checks use `! grep …`.
- /tmp is a small tmpfs: run heavy tests with `TMPDIR=` on the home disk. test/helper-kill.test.mjs can leave `test/fixtures/helper-parent.mjs` holding the test lock: kill that pid.
- On the owner's MacBook Playwright browsers die at launch (SIGILL) unless launched with test/helpers/mac-chromium.mjs's env; some suites (compute-only's /proc check, cluster slot sizing) fail on macOS regardless of the change.
- node:test `mock.timers.tick(n)` never runs a timer scheduled by a timer it ran in the same tick: step in small increments.
- A task session on a worker can't call the head's owner API, and the head runs a task's code only after merge: a Done-when needing a live run against the head must be a follow-up task after deploy.
- `bin/agent-smoke.mjs` and `bin/orch-e2e.mjs` cost quota; never send Claude logout in tests.
- Other sessions and orchestrator auto-commits touch the live checkout at once: re-read before editing. A branch failing in files you didn't touch is usually a stale base: fast-forward to main and re-run.
- Reflections: run the needed tests to a log, check which files queued/running tasks hold, and emit the task block in the final message.
