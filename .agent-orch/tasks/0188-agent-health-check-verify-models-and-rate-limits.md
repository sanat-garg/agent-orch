# Task #188: Agent health check: verify models and rate limits for all six CLIs

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 12:52  
- starts after: #185, #186, #187  
- files: bin/agent-health.mjs, agents.mjs, usage.mjs, connections.mjs, .agent-orch/AGENTS.md, test/health*.test.mjs

## Prompt

Make sure models and rate limits are fetched correctly from every agent (claude, codex, antigravity, opencode, kiro, copilot). 1) Add bin/agent-health.mjs, which prints one table: agent, installed and version, signed in and account, number of models discovered (plus the first few ids), the limit windows known (name, pct, resetsAt) and their data source, the time of the last successful fetch, and errors. Add `--json` output and an exit code other than 0 if any installed and signed-in agent has 0 models or has windows with null resets while its data source provides them. 2) Run it, and for every gap, find and fix the root cause in agents.mjs/usage.mjs/connections.mjs (discovery commands, env isolation, parsing, refresh triggers after sign-in, stale caches, per-agent limit sources: Claude /usage windows, codex rate_limits snapshots, agy four groups, opencode/kiro/copilot quota info where it exists). If a CLI genuinely exposes no limit data, record 'not exposed by CLI' in .agent-orch/AGENTS.md and have the UI say that instead of 'unknown'. 3) Model and limit caches refresh on startup, every 6 h, right after sign-in or out, and on demand via a 'Refresh' button in the Connections modal, which shows the health table as a compact status per row. Tests with stub CLIs for the health output and exit code.

## Done when

`node bin/agent-health.mjs` exits 0 on this machine, with every signed-in agent showing at least 1 model and its limit windows or 'not exposed by CLI', and `npm test` passes
