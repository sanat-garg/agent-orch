# Task #149: Verify Antigravity runs a real orchestrator task end to end

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 23:56  
- starts after: #148

## Prompt

After the smoke-suite fixes, confirm that Antigravity works inside the actual orchestrator loop, not just via runAgentCli. Start a test server with CW_DATA_DIR=$(mktemp -d) on a separate port (orchestrator enabled in that temp dir only; never touch the live data/ or the live server), register a scratch git project, and queue one small real task routed to antigravity (gemini-3.1-pro-high): 'add a function and its test, make npm test pass', with done_when `npm test`. Let it run through claim → agent run → check → done. Confirm: the task ends 'done' with the check passing; the run log shows tool events with file paths (not {}); the usage/limit records land under the right Gemini group; and nothing touched the live orchestrator. Repeat once with claude-sonnet-4-6 on antigravity (the third-party group). Write the results, with the run ids, into .agent-orch/ANTIGRAVITY-TOOLS.md under 'Orchestrator verification'. Fix anything that breaks and add tests for it.

## Done when

.agent-orch/ANTIGRAVITY-TOOLS.md has an 'Orchestrator verification' section showing both antigravity runs finishing 'done' with the check passing, and `npm test` passes
