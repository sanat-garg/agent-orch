# Task #80: Add CW_NO_ORCHESTRATOR=1 to boot the server without running the orchestrator

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-25 09:29

## Prompt

Goal: be able to boot server.mjs against a copy of real data without it running or requeuing any tasks. The next task uses this for a preflight before the owner restarts the live service.

In server.mjs (createOrchestrator is called around line 574) and orchestrator.mjs: when process.env.CW_NO_ORCHESTRATOR === '1', the server must still open the DB and run every schema migration, so the preflight exercises them. It must also keep serving the task/project read APIs the UI uses. But it must never claim tasks, never requeue orphaned 'running' tasks, never start planner/reflection/worker loops, never take the data-dir lock in a way that affects another instance, and never push to git. Prefer the smallest change, e.g. an option passed to createOrchestrator that skips starting the loop and the orphan recovery. Log one line at boot saying the orchestrator is disabled. Match the terse style. Document the flag in README.md (env vars section) and add one bullet under Gotchas in .agent-orch/CONTEXT.md.

Test: add a test in test/ (follow test/server.test.mjs: spawn server.mjs on a free port with CW_DATA_DIR set to a temp dir). Seed an orchestrator DB with a queued task and a task in status 'running', or seed through the API if that is easier. Boot with CW_NO_ORCHESTRATOR=1, wait a few seconds, and assert that both tasks keep their status and GET /api/ returns 200 for the task listing. Never touch port 3000 or the live data/ dir.

## Done when

`npm test` passes, including a new test that boots with CW_NO_ORCHESTRATOR=1 and asserts that a queued and a running task keep their status

## Result — done (check passed) (2026-09-25 09:33)

AGENT-ORCH-STATUS: done — CW_NO_ORCHESTRATOR=1 boots inert, tested; all 117 tests pass
