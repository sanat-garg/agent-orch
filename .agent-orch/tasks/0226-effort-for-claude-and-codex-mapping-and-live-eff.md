# Task #226: Effort for Claude and Codex: mapping and live effort for active tasks

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-27 12:43  
- files: agents.mjs, orchestrator.mjs, server.mjs, .agent-orch/AGENTS.md, test/effort*.test.mjs

## Prompt

Backend for an effort control like Claude Code's, for the Claude and Codex agents ONLY (others keep their defaults and declare no efforts). 1) agents.mjs: Claude declares `efforts` from the Agent SDK/CLI effort option (check the SDK types in node_modules/@anthropic-ai/claude-agent-sdk for `effort` and its levels, e.g. low/medium/high/xhigh/max) and passes the chosen level in query options. Codex declares its accepted `model_reasoning_effort` values (verify with the installed codex, e.g. minimal/low/medium/high/xhigh) and passes `-c model_reasoning_effort=<level>`. runAgentCli accepts `effort` and ignores it for other agents. Document this in .agent-orch/AGENTS.md. 2) Storage: the convo gets `effort` (null = the agent default); PUT /api/convos/:id/effort {effort}, validated against the selected agent's levels; include it in the convo payload. 3) LIVE effort for active tasks (the owner's rule: not the effort from prompt time). Tasks don't snapshot effort. Each time a Claude or Codex work task starts a session, resumes, is retried or is handed off, the orchestrator reads the CURRENT effort of the task's chat (project convo) and passes it, clamped to that agent's levels. A running session keeps its effort until its next session boundary. Record the effort used per run (runs.effort). A per-task override (tasks.effort, set only from the drawer) wins if set. Chat turns use the current effort. Tests: stub CLIs/SDK assert the flag/option for claude and codex; a task queued before an effort change runs with the new effort; a resume uses the updated effort; other agents never get an effort flag.

## Done when

`npm test` passes with claude/codex effort-mapping tests and a test where a task queued at 'low' runs with 'high' after the chat's effort changed
