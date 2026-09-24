# Task #21: Rename AO2 protocol markers and DB file to agent-orch

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-24 23:37  
- starts after: #20

## Prompt

In orchestrator.mjs (and public/app.js where it strips the status line), rename the internal AO2 names while staying backward compatible. 1) Prompts: replace every 'AO2' mention in prompt text and comments with 'agent-orch'. 2) The tasks fence ```ao2-tasks → ```agent-orch-tasks. TASKS_BLOCK_RE and the indexOf at ~line 308 must accept BOTH fences. 3) The status line AO2-STATUS → AGENT-ORCH-STATUS. STATUS_RE and the two regexes in public/app.js (~lines 2135, 2235) must accept both. 4) The DB file data/orchestrator/ao2.db → data/orchestrator/agent-orch.db: before opening, if ao2.db exists and agent-orch.db doesn't, rename ao2.db plus its -wal and -shm files. Test this migration against a temp dir only, never the live data/. Add node:test cases in test/ covering: both fences parse, both status lines parse, and the DB rename migration. Don't touch the .ao2/ memory dir name (the next task does that).

## Done when

`grep -n 'AO2' orchestrator.mjs` shows only backward-compat regex matches and `npm test` passes with the new fence/status/DB-migration tests

## Result — done (check passed) (2026-09-24 23:48)

AO2-STATUS: done — New fence, status and DB names in place; old names still accepted; tests pass
