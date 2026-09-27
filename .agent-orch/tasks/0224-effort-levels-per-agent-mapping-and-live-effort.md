# Task #224: Effort levels: per-agent mapping and live effort for active tasks

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-27 12:42  
- files: agents.mjs, orchestrator.mjs, server.mjs, .agent-orch/AGENTS.md, test/effort*.test.mjs

## Prompt

Backend for an effort control like Claude Code's (low → max). 1) Per-agent mapping in agents.mjs, verified against each installed CLI or SDK on this machine: Claude (the Agent SDK/CLI effort option; check the SDK types in node_modules/@anthropic-ai/claude-agent-sdk for `effort`/thinking options and the levels low/medium/high/xhigh/max), Codex (`-c model_reasoning_effort=` with its accepted values), Antigravity (`--effort low|medium|high`), Copilot (`--reasoning-effort none|minimal|low|medium|high|xhigh|max`), OpenCode (`--variant` if models expose reasoning variants), and Kiro (if supported; otherwise mark it unsupported). Each adapter declares `efforts: [...]` (ordered) and `defaultEffort`, and runAgentCli accepts `effort`, mapping the unified scale low/medium/high/xhigh/max to the nearest supported level. Document the mapping in .agent-orch/AGENTS.md. 2) Storage: the chat/convo gets `effort` (null = the agent default). PUT /api/convos/:id/effort {effort}. Include it in the convo payload. 3) LIVE effort for active tasks (the owner's rule: don't use the effort captured at prompt time). Tasks store no effort snapshot by default. Whenever a work task starts a session, resumes, is retried or is handed off, the orchestrator reads the CURRENT effort of the task's chat (project convo), falling back to the project default, and passes it to the adapter. A running session keeps its effort until its next session boundary. Record the effort actually used on each run (runs.effort) and show it in the run log. A per-task override is optional (tasks.effort, set only when the owner changes it in the drawer) and wins if set. Chat turns use the current effort too. 4) The planner prompt context lists the current effort. Tests: the mapping for each agent (stub CLIs assert the flags/options), a queued task picking up an effort changed after it was queued, a resume after an effort change using the new effort, and the per-task override winning.

## Done when

`npm test` passes with per-agent effort-mapping tests and a test where a task queued at 'low' runs with 'high' after the chat's effort was changed
