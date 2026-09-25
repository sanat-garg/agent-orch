# Task #54: Audit round 2: multi-agent adapters, routing and non-Claude chat

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 04:13

## Prompt

Read .agent-orch/BRIEF.md, .agent-orch/CONTEXT.md and .agent-orch/AUDIT.md (items 1-16 are all fixed). Audit the code added for multi-agent support, which has never been reviewed: agents.mjs (adapters, spawnJsonl, agentStatus/loggedIn caching, the billing env stripping, so that no API key can leak to codex/agy), resolveRoute and route_note handling in orchestrator.mjs, the routes table save/delete path (projectAction removeRoute, the tasks-block `routes`), agentChatTurn and set_model in server.mjs (session resume via convo.agentSession, abort/delete mid-turn, error surfacing to the UI), and the planner-busy guard (planningProjects, deferMessage). Look for real bugs: crashes, hangs, leaked processes, wrong fallbacks, billing-safety holes, races, and missing error handling. Confirm each one by reading the code carefully or by a small experiment with the stub binaries in test/fixtures/. Append each confirmed finding to .agent-orch/AUDIT.md as `### 17. [severity] title (file:line)` and onward, with **What:** and **Fix:** lines, in the existing format. Do NOT fix anything in this task and do not modify source files. If you find nothing real, add a short 'Round 2 (2026-09-25): no issues found' note instead.

## Done when

`grep -Eq '^### 17\.|Round 2' .agent-orch/AUDIT.md`
