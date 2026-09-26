# Task #195: Agent health check: verify models and rate limits for all six CLIs

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 14:32  
- files: bin/agent-health.mjs, agents.mjs, usage.mjs, connections.mjs, .agent-orch/AGENTS.md, test/health*.test.mjs

## Prompt

Make sure models and rate limits are fetched correctly from every agent (claude, codex, antigravity, opencode, kiro, copilot). Context: task #187 concluded that Copilot exposes only 'auto' for this account. Its notes are on branch agent-orch/task-187 (`git log agent-orch/task-187`, `git diff main...agent-orch/task-187`); reuse anything valid there. Treat 'auto only' as a legitimate, documented state for Copilot (show 'Auto (Copilot picks the model)'), not an error. 1) Add bin/agent-health.mjs, which prints one table: agent, installed and version, signed in and account, number of models discovered (plus the first few ids), the limit windows known (name, pct, resetsAt) and their data source, the time of the last successful fetch, and errors. Add `--json` and an exit code other than 0 if any installed, signed-in agent has 0 models, or has windows with null resets while its source provides them. 2) Run it and fix every gap at the root cause in agents.mjs/usage.mjs/connections.mjs. If a CLI genuinely exposes no limit data, record 'not exposed by CLI' in .agent-orch/AGENTS.md, and the UI says that instead of 'unknown'. 3) Model and limit caches refresh on startup, every 6 h, right after sign-in or out, and via a 'Refresh' button in the Connections modal that shows a compact health status per row. Tests with stub CLIs for the health output and exit code.

## Done when

`node bin/agent-health.mjs` exits 0 on this machine, with every signed-in agent showing at least 1 model and its limit windows or 'not exposed by CLI', and `npm test` passes
