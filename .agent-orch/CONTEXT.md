# Project Context

_Durable knowledge for every agent session: architecture, conventions, decisions, gotchas. History lives in JOURNAL.md._

## Architecture
- `server.mjs`: node:http + `ws`. Login/sessions (cookie `__Host-cw_session` over HTTPS via `X-Forwarded-Proto`, plain `cw_session` on http), chat via the Agent SDK `query()`, serves `public/`. PORT defaults to 3000. Chat runtimes: always `retireRuntime` (runtimes.mjs), never `q.close()` + `runtimes.delete`.
- `orchestrator.mjs`: node:sqlite DB at data/orchestrator/agent-orch.db; planner/worker/reflection loop; `runAgent()` wraps adapters with timeout + run log. Prompts live inline. `createOrchestrator({config})` overrides CFG in tests.
- `agents.mjs`: adapter registry (`AGENTS`, `runAgentCli`) emitting normalised events (text/tool/tool_result/result/limit). Adapters: claude (SDK), codex (`codex exec --json`), antigravity (`~/.local/bin/agy -p --output-format stream-json`), opencode (`opencode run --format json`), kiro (`~/.local/bin/kiro-cli`, ACP stream-json), copilot (`copilot -p --output-format json`, shares the gh account). CLI adapters share `spawnJsonl` (detached process group, killed on abort/exit). `agentStatus` (on PATH + logged in, cached 60 s) gates routing. CLI flags and stream formats: `.agent-orch/AGENTS.md`.
- `models.mjs`: every model list comes from its CLI (`discoverModels`), cached in `<DATA>/models.json`, refreshed at boot, every 6 h and after sign-in changes. Read via `modelCatalog(id)`/`modelNames(id)`; never hardcode model lists.
- Routing (`resolveRoute`): task agent/model → project route → global route → Claude on project.model. Model-only routes infer the agent; a model the agent doesn't list is dropped. Unavailable agents fall back to Claude with `tasks.route_note`. Sessions resume only on the agent that made them (`runs.agent`).
- Limits are per agent (Antigravity: per model group, `:antigravity:gemini`/`:antigravity:3p`): `blockedUntilFor(agent, model)`; kv keys `blocked_until`/`blocked_known`/`blocked_reason` (+ `:<agent>` suffix for non-Claude). `claimNext` skips only tasks whose resolved agent is blocked.
- Delegation (`delegate.mjs`): no benchmarks. A task moves only if its `tasks.fallbacks` snapshot is non-empty (null/[] = wait). `nextModel` picks the first entry whose agent is connected, lists the model, isn't blocked and has no window ≥90%. Lists: `convo.fallbacks` (per chat) and `projects.reflect_fallbacks`. Moves are appended to `tasks.moves`. UI text comes only from app.js `modelStatus(task)`.
- Planner: `planTurn` runs on the chat's agent; `planningProjects` allows one planner resume per project; messages during a plan task go through `deferMessage`. Saved messages: pending → taken (by a plan task) → done.
- Parallel work: work tasks in a git project run in `<repo>/../.agent-orch-worktrees/<repo>-task-<id>` on branch `agent-orch/task-<id>` (worktrees.mjs). Only `mergeTask` touches the main tree, under `serialGit` (squash, rebase, ff-only, push). Rebase conflict → `needs_integration` + an integrator task in the same worktree; `releaseOwner` fails/cancels the owner with its integrator. JOURNAL.md merges with `merge=union`. Tasks declare `files` (NULL = everything, runs alone); `runnable` shares a project only when `filesOverlap` is false. Deps: `task_deps` table, read via `depsOf(id)` / the `all_deps` view (legacy `tasks.depends_on` = first dep). `CFG.maxParallel`, `CFG.agentSlots`; `spreadAssign` spills to a fallback with a free slot.
- Queue order: `tasks.position` (per project) first; plan/reflect/user tasks and deadlines <24 h jump ahead.
- `connections.mjs`: web sign-in; runs each CLI's login in tmux (socket `-L agent-orch-login`) and scrapes the pane. Every server boot kills that socket.
- `usage.mjs`: append-only `<DATA>/metrics/usage.jsonl` (30 days). Non-Claude windows come from adapters (`res.windows`); missing readings never inherit Claude's.
- `media.mjs`: screenshots stored as `<DATA>/media/<sha256>.<ext>`, served by `GET /api/media/:id`. `bin/shot.mjs` (playwright-core 1.63.0 = cached chromium-1243) takes them; save into `<project>/.agent-orch/shots/`.
- `github.mjs`: gh wrapper; every project gets a private repo on `origin`.
- `public/`: vanilla JS SPA (app.js ~4.5k lines, marked + dompurify), PWA. Shared helpers: `toast(msg, {kind, action, run, duration})`, `renderFallbackEditor`, `withUntil`, `fmtDur`. Check for name clashes before adding functions (a later declaration silently wins).
- Live setup: systemd units agent-orch, agent-orch-shell (ttyd 127.0.0.1:7682, Caddy `/shell/`), agent-orch-tmux. `data/` (gitignored) holds auth, convos, metrics, logs, DB, run logs.

## Conventions
- ESM `.mjs`, no build step, no framework, minimal deps. Match the terse style and comment density.
- Tests: `node --test`; `npm test` runs `test/**/*.test.mjs`. Server tests spawn server.mjs on a free port with `CW_DATA_DIR` set to a temp dir. Scheduling tests run `createOrchestrator` in a child process with a fake `query`; CLI adapters use stub binaries in test/fixtures/. Scheduler tests pass `config: { pollMs: 100 }` and poll with `test/helpers/wait.mjs` instead of fixed sleeps. Browser tests (test/ui-*.test.mjs) use playwright-core.
- User-visible times: events carry `until` (epoch s); app.js `withUntil` formats in the browser's timezone. Don't format times on the server except in logs.
- .agent-orch/AUDIT.md is the bug backlog; mark fixed items `**Fixed**` with a one-line note.
- Mobile: follow Apple HIG (apple-design skill). Modals need `grid-template-columns: minmax(0, 100%)`; test/ui-away.test.mjs checks every modal fits 375×667 and 390×844.

## Decisions
- Chat and agents run on subscriptions, never API credits (API_ENV stripping in server.mjs; agy refuses API-key mode). Never weaken that.
- Repo is github.com/sanat-garg/agent-orch with fresh history; local branch `backup/pre-agent-orch` must never be pushed.
- `after` is for TRUE prerequisites only: cancelling a task cascades to everything after it. Use `files` to keep work apart.
- Typography uses the system font stack; no bundled web fonts (Inter was tried and reverted).
- Delegation is owner-entered fallback lists only; benchmark ranking was removed on purpose.

## Gotchas
- This checkout IS the live app. Never restart/kill it or call `POST /api/restart-when-idle` on port 3000. Test instances MUST use another port and `CW_DATA_DIR=$(mktemp -d)`, or they double-run live tasks. `CW_NO_ORCHESTRATOR=1` serves read APIs without the tick loop.
- Server/orchestrator edits go live only on restart ("Restart when idle" banner). A failing "Done when" check may be stale running code, not the task.
- The verifier runs every command-like backtick snippet in "Done when", joined with ` && `. Commands containing `>` (incl. `2>&1`) or `curl` are refused. Absence checks use `! grep …`.
- Claude logout needs `confirm: true` — never send it in tests. `agyLogout` deletes `~/.gemini/antigravity-cli/antigravity-oauth-token` — never call it on the real home.
- agy: native path params need `AGY_PATH_KEYS` mapping; headless agy without `--dangerously-skip-permissions` silently denies run_command, so agy work runs autonomous. `bin/agent-smoke.mjs --agent X --model Y` and `bin/orch-e2e.mjs --agent X --model Y [--parallel]` are live checks (cost quota).
- Kiro is signed out on this VM; its authenticated event schema is unverified. Copilot `listModels()` currently returns only `auto`; no remaining/reset reading exists for Copilot.
- The screenshot lightbox `#lbView` needs `contain: size` or huge images widen the modal.
- Don't commit macOS `._*` files.
