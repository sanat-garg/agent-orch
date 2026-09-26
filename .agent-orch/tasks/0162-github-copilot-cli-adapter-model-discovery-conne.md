# Task #162: GitHub Copilot CLI: adapter, model discovery, connection and smoke test

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 04:21  
- starts after: #159

## Prompt

Add a 'copilot' agent following the Copilot section of .agent-orch/AGENTS.md and the patterns of the existing adapters in agents.mjs: headless run with normalised events, model discovery (no hardcoded lists), limit/premium-request quota detection only from structured errors, abort cleanup, resume, and API-key env stripping. Add its sign-in spec to connections.mjs (reuse the gh account if Copilot uses it, else its own device flow in tmux; show the account; disconnect) so it shows in the Connections modal, plus usage (premium requests) in usage.mjs if exposed. Add adapter unit tests with recorded fixtures, then run `node bin/agent-smoke.mjs --agent copilot --model <a discovered model>` until every check passes (if it isn't signed in or has no Copilot subscription, document that for the owner).

## Done when

`npm test` passes with copilot adapter tests, and GET /api/connections lists copilot
