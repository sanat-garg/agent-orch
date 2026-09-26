# Task #161: Kiro CLI: adapter, model discovery, connection and smoke test

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 04:21  
- starts after: #159

## Prompt

Add a 'kiro' agent following the Kiro section of .agent-orch/AGENTS.md and the patterns of the existing adapters in agents.mjs: headless run with normalised events, model discovery (no hardcoded lists), limit detection only from structured errors, abort cleanup, resume, and API-key env stripping. Add its sign-in spec to connections.mjs (status, account, connect via the device/URL flow in tmux, disconnect) so it shows in the Connections modal, plus usage windows in usage.mjs if exposed. Add adapter unit tests with recorded fixtures, then run `node bin/agent-smoke.mjs --agent kiro --model <a discovered model>` until every check passes (if it isn't signed in, document that for the owner).

## Done when

`npm test` passes with kiro adapter tests, and GET /api/connections lists kiro
