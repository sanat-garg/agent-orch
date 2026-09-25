# Project Context

_Durable knowledge for every agent session: architecture, conventions, decisions, gotchas._

## Architecture
- `server.mjs`: node:http + `ws`. Login/sessions (cookie `cw_session`), chat via the Agent SDK `query()`, serves `public/`. PORT defaults to 3000.
- `orchestrator.mjs`: node:sqlite DB at data/orchestrator/agent-orch.db; planner/worker/reflection loop; `runAgent()` wraps the adapters and adds timeout + the task-run log. Prompts live inline.
- `agents.mjs`: adapter registry (`AGENTS`, `runAgentCli`) emitting normalised events (text/tool/tool_result/result/limit). Adapters: `claude` (SDK), `codex` (`codex exec --json`), `antigravity` (`~/.local/bin/agy -p --output-format stream-json`; refuses Gemini API-key mode). CLI adapters share `spawnJsonl` (detached process group, killed on abort and after exit). `agentStatus` (on PATH + logged in, cached 60 s) gates routing. `isMissingSession` detects dead resumes.
- Routing (`resolveRoute`): task's own agent/model → project route → global route → Claude on project.model. A model-only route infers the agent from the model family; a foreign model on an explicit agent is dropped. Unavailable/unsigned/limited agents fall back to Claude with `tasks.route_note` (UI badge). Planner always runs on Claude. Sessions resume only on the agent that made them (`runs.agent`).
- Limits: only a Claude limit/auth failure sets the global kv `blocked_until`; non-Claude ones set `blocked_until:<agent>` / `agent_auth_failed:<agent>` and only reroute that agent.
- Chat agents: `convo.agent` + `convo.model` (WS `set_model`). Non-Claude chats run one `runAgentCli` turn per message (`agentChatTurn`, resume via `convo.agentSession`).
- Planner guard: `planningProjects` ensures only one `--resume` of a project's planner session at a time; chat messages during a plan task go through `deferMessage`.
- `connections.mjs`: web sign-in. Runs each CLI's login in tmux (socket `-L agent-orch-login`), scrapes the pane with per-agent `SPECS`, detects the end via an `__AO_EXIT:<code>` marker (agy never exits: `liveSuccessRe`/`liveFailRe`). API: GET /api/connections, POST /api/connections/:id/{start,code,cancel,logout}; WS `{t:'connections'}`. Claude logout needs `confirm: true` — never send that in tests. UI: sidebar `#conns` panel.
- `runtimes.mjs`: chat runtime ownership — always use `retireRuntime`, never `q.close()` + `runtimes.delete`.
- `github.mjs`: gh wrapper; every project gets a private repo, pushes go to `origin`. `convo.repo` is just a cache of `gh.remoteOf(cwd)`.
- `public/`: vanilla JS SPA (app.js, marked + dompurify), login page, PWA manifest.
- `.agent-orch/AGENTS.md`: research notes on the Codex/agy/Gemini CLIs (flags, stream formats, billing env vars to strip).
- Live setup: systemd units agent-orch, agent-orch-shell (ttyd on 127.0.0.1:7682, Caddy at `/shell/`), agent-orch-tmux. `data/` (gitignored) holds auth, convos, metrics, logs, the DB and run logs.

## Conventions
- ESM `.mjs`, no build step, no framework, minimal deps. Match the terse style and comment density.
- Tests: `node --test`; `npm test` runs `test/**/*.test.mjs`. Server tests spawn server.mjs on a free port with `CW_DATA_DIR` set to a temp dir. Orchestrator scheduling tests run `createOrchestrator` in a child process with a fake `query`; CLI adapters are tested with stub binaries in test/fixtures/.
- User-visible times: events carry `until` (epoch s) and a `{until}` token; app.js `withUntil` formats in the browser's timezone. Don't format times on the server except in log lines.
- .agent-orch/AUDIT.md is the bug backlog. When you fix an item, mark it `**Fixed**` with a one-line note.

## Decisions
- 2026-09-24: repo moved to github.com/sanat-garg/agent-orch with fresh history (old history leaked data/auth.json). Local branch `backup/pre-agent-orch` — never push it.
- 2026-09-24: the owner removed DENY_TOOLS so agents can work on this repo.

## Gotchas
- This checkout IS the live app. Never restart/kill it or call `POST /api/restart-when-idle` on port 3000. Test instances MUST use another port and `CW_DATA_DIR=$(mktemp -d)`, or they double-run live tasks.
- Edits to server/orchestrator only go live on restart. The UI banner offers "Restart when idle" (drain, exit 0, systemd restarts).
- The verifier (`extractCommand`) runs every command-like backtick snippet in "Done when", joined with ` && `. Commands containing `>` (incl. `2>&1`) or `curl` are refused. Absence checks must use `! grep …`.
- `migrateMemDir()` renames a legacy `.ao2/` into `.agent-orch/`.
- Don't commit macOS `._*` files.
