# Task #67: Server: tmux-driven sign-in sessions for agent CLIs (codex first)

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 08:21

## Prompt

Build the backend for signing in to agent CLIs from the web UI instead of the terminal. Create connections.mjs. For each agent it runs the CLI's interactive login inside a detached tmux session (tmux is installed; use a dedicated socket, e.g. `tmux -L agent-orch-login`, so the owner's terminals are never touched). It polls `tmux capture-pane -p` to extract the sign-in URL and any one-time device code, forwards a code the owner pastes back via `tmux send-keys`, detects success/failure, and cleans up the session (with a 10 min timeout). Use a per-agent spec: {start command, url regex, code regex, needsPastedCode, successRe, statusCmd}. Start with codex: `codex login --device-auth`, status via `codex login status` (see .agent-orch/AGENTS.md; keep forced_login_method=chatgpt). Also add a GitHub spec that reuses the existing gh status. Add server.mjs endpoints, all login-protected: GET /api/connections (per agent: id, label, installed, signedIn, account if known, login in progress + url/code), POST /api/connections/:id/start, POST /api/connections/:id/code {code}, POST /api/connections/:id/cancel, POST /api/connections/:id/logout (where the CLI supports it). Broadcast state changes over the existing WebSocket. Unit-test the capture parsing with recorded pane text fixtures. Don't start a real login in tests.

## Done when

`npm test` passes with connections.mjs parsing tests, and GET /api/connections on a test server returns entries for claude, codex, agy and github with installed/signedIn fields
