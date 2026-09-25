# Project Context

_Durable knowledge for every agent session: architecture, conventions, decisions, gotchas._

## Architecture
- `server.mjs` (~1.2k lines): a node:http server plus `ws`. It handles login/sessions (cookie `cw_session`)
  and chat via `query()` from @anthropic-ai/claude-agent-sdk, and serves `public/`. PORT defaults to 3000.
- `orchestrator.mjs` (~1.6k lines): AO2. It uses a node:sqlite DB at data/orchestrator/agent-orch.db (renamed from ao2.db on start), a
  planner/worker/reflection loop, and a `runAgent()` wrapper around the SDK `query()`. Prompts live inline.
- `agents.mjs`: the coding-agent adapter registry (`AGENTS`, `runAgentCli`), emitting normalised events (text/tool/tool_result/result/limit). Adapters: 'claude' (SDK query), 'codex' (`codex exec --json`) and 'antigravity' (`~/.local/bin/agy -p --output-format stream-json`; kills a run that blocks on the OAuth prompt, refuses `modelProvider:"gemini"` API-key mode). CLI adapters share `spawnJsonl` (detached, kills the process group on abort); tests use stub binaries in test/fixtures/; orchestrator `runAgent` wraps it and adds timeout and the task-run log (tool_result is logged as k:'result').
- Routing (orchestrator.mjs): `resolveRoute` picks a task's agent/model: its own `agent`/`model` columns, then the first matching project route, then a global one (`routes` table, project_id NULL), then Claude on project.model; an agent that is not installed or not logged in (`agentStatus` in agents.mjs: `available()` = on PATH, `loggedIn()` = `codex login status` / an agy token file under ~/.gemini/antigravity-cli/ / ~/.claude/.credentials.json, sync, cached 60 s, `clearLoginCache()` for tests) falls back to Claude with a logged reason; GET /api/agents reports `loggedIn`. Planner/reflector save routes via the tasks block's `routes`. The planner itself always runs on Claude (a plan route only changes its model). `runs.agent` records who made a session, so a session only resumes on the same agent; warm-session reuse is Claude-only. A non-Claude rate limit still sets the global `blocked_until`. `tasks.ran_agent/ran_model` record what the latest run used (UI badge); project views carry `routes`, deleted via projectAction `{removeRoute}`.
- Chat agents: `convo.agent` (default claude) + `convo.model`, set by WS `set_model {agent, model}`; GET /api/agents feeds the picker (values `agent|model`). Non-Claude chats run one `runAgentCli` turn per message (`agentChatTurn` in server.mjs, resume via `convo.agentSession`), no persistent runtime or permission prompts; Orchestrator Mode still plans on Claude.
- `runtimes.mjs`: chat runtime ownership. To replace or close a chat's runtime, use `retireRuntime`, not `q.close()` plus `runtimes.delete`. A runtime loop touches the map only while `runtimes.get(convo.id) === rt`.
- `github.mjs`: the gh CLI wrapper. Every project gets a private repo, and pushes go to `origin`.
- `public/`: a vanilla JS SPA (app.js ~2.4k lines, marked + dompurify), a login page and a PWA manifest.
- `.agent-orch/AGENTS.md`: research notes on the Codex, Antigravity (`agy`) and Gemini CLIs (install, subscription login, headless flags, stream formats, billing env vars to strip), for the agents.mjs adapters.
- `bin/term-attach.sh`: the ttyd terminal attach helper. Live setup: ttyd on 127.0.0.1:7682 behind Caddy at `/shell/` (not `/term/`, despite a server.mjs comment); systemd units agent-orch, agent-orch-shell, agent-orch-tmux (renamed 2026-09-25 by bin/rename-install.sh; the install dir moved from ~/claude-web to ~/agent-orch).
- `data/` (gitignored): auth.json, convos.json, metrics, logs, and the orchestrator DB and run logs.

## Conventions
- ESM `.mjs`, no build step, no framework. Match the existing terse style and comment density.
- Tests: use Node's built-in `node --test` (no extra test deps). `npm test` runs `test/**/*.test.mjs` (Node 22 won't take a
  bare `test/` dir). test/server.test.mjs spawns server.mjs on a free port with `CW_DATA_DIR` set to a temp dir
  (CW_DATA_DIR overrides data/ for the server and the orchestrator).

## Decisions
- 2026-09-24: The repo moved to sanat-garg/agent-orch with a fresh single-commit history, because the old
  history contained data/auth.json. The old history is kept locally only, on branch `backup/pre-agent-orch`.
  Never push that branch.
- 2026-09-24: The owner removed the self-protection deny rules (DENY_TOOLS) from orchestrator.mjs so that
  agents can work on this repo.

## Gotchas
- The verifier (`extractCommand`) runs every command-like single-backtick snippet in "Done when", joined with ` && ` (a triple-backtick block wins if present); snippets like `server.mjs` are ignored. Commands containing `>` (incl. `2>&1`) or `curl` are refused, so such checks never run.
- "Done when" checks asserting absence must use `! grep …`: grep exits 1 on no matches, so a bare `grep` check fails exactly when the code is clean.
- Editing server.mjs or orchestrator.mjs doesn't affect the running app until the owner restarts it.
- Project memory lives in `.agent-orch/` (formerly `.ao2/`). `migrateMemDir()` renames it on init/read, and merges a `.ao2/` that a pre-restart server recreated, so a stray `.ao2/` in a commit is expected until restart.
- Don't commit macOS `._*` files (they're gitignored).
- Test instances MUST set `CW_DATA_DIR=$(mktemp -d)`. Without it, a second server on the live data/ requeues and
  double-runs the live orchestrator's running tasks and rewrites convos/sessions (AUDIT #2).
- .agent-orch/AUDIT.md is the bug backlog. When you fix an item, mark it `**Fixed**` there with a one-line note.
