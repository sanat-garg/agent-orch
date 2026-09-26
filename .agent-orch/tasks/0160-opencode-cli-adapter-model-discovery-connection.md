# Task #160: OpenCode CLI: adapter, model discovery, connection and smoke test

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 04:21  
- starts after: #159

## Prompt

Add an 'opencode' agent following the OpenCode section of .agent-orch/AGENTS.md and the patterns of the codex/antigravity adapters in agents.mjs: headless run with normalised events (text, tool with file paths, tool_result, result + usage, limit), model discovery (no hardcoded lists), limit detection ONLY from structured errors (never from tool output text), abort/process-group cleanup, session resume, and stripping of API-key billing env vars. Add its sign-in spec to connections.mjs (status, account, connect, disconnect) so it appears in the Connections modal, and its usage windows in usage.mjs if exposed. Add adapter unit tests with recorded fixtures, then run `node bin/agent-smoke.mjs --agent opencode --model <a discovered model>` until every check passes (if it isn't signed in, document that and run the smoke test once the owner connects it).

## Done when

`npm test` passes with opencode adapter tests, and GET /api/connections lists opencode
