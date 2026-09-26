# Task #177: AUDIT round 5: security and robustness of the server's HTTP and WebSocket endpoints

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 10:42  
- files: .agent-orch/AUDIT.md

## Prompt

Audit only; do NOT change source code. Read .agent-orch/AUDIT.md (rounds 1–4 and their format) and .agent-orch/CONTEXT.md. Many endpoints have been added to server.mjs since round 1: /api/connections (and connections.mjs start/cancel/submit code), /api/media/:id (media.mjs), /api/terminals, /api/projects, /api/folders, /api/github/link, /api/away, /api/restart-when-idle, fallback-list and reorder endpoints, task actions, plus the WebSocket message handlers. Review each one for: auth checks (does everything after the login gate really require a session? any route before it?), path traversal (media ids, folders, project paths, terminal cwd), command/argument injection into git, gh, tmux or CLIs, missing input validation (types, sizes, ids) that could crash the process or corrupt the DB, CSRF/Origin checks on state-changing POSTs and on the WebSocket upgrade, and anything that could leak secrets or data/ contents. Verify every suspected issue with a real repro against a test instance: `PORT=<free port> CW_DATA_DIR=$(mktemp -d) CW_NO_ORCHESTRATOR=1 node server.mjs` (or a node --test harness like test/server.test.mjs). NEVER touch port 3000 or the real data/ dir, and kill only your own process. Append a section `## Round 5 (2026-09-26, task #N): HTTP/WS endpoint security` to .agent-orch/AUDIT.md. Start it with a short paragraph listing what you checked and found clean. Then add numbered findings continuing from #32 (### 33. [sev] title (file:line)), each with **What**, **Repro (verified)** and **Fix**. Include only verified issues. If you find none, say so explicitly in the section.

## Done when

`grep -q '^## Round 5' .agent-orch/AUDIT.md` succeeds and `git diff --quiet HEAD -- server.mjs orchestrator.mjs connections.mjs media.mjs public` shows no source changes.
