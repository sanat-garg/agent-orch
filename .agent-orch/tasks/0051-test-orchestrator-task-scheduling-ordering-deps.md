# Task #51: Test orchestrator task scheduling: ordering, deps, cascade, blocked_until

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 04:05  
- starts after: #50

## Prompt

In /home/ubuntu/agent-orch, task scheduling in orchestrator.mjs (runnable/claimNext ~line 840-870, cascadeBlock/reviveBlocked, blockedUntil/kv 'blocked_until') has no tests. Add test/scheduling.test.mjs. createOrchestrator starts timers, so use the same child-process harness pattern as test/planner-guard.test.mjs: a temp dataDir and project dir, and a fake SDK `query` that yields a success result. Insert rows directly with node:sqlite. If that is simpler, you may add small test-only exports or an option, as long as production behaviour doesn't change. Cover: (1) urgent beats normal beats background, and a higher project priority wins at equal urgency; (2) a task with depends_on on an unfinished task is not claimed; (3) two tasks in the same project never run at once; (4) a parent that fails marks its queued children 'blocked: #N', and retrying the parent revives them (reviveBlocked); (5) while kv blocked_until is in the future, nothing is claimed. Read the code to find the actual ordering expression (`eff`) before you assert. Keep each assertion about observable DB state. Don't restart the live server.

## Done when

`npm test` passes and test/scheduling.test.mjs exists covering ordering, depends_on, per-project exclusivity, cascade/revive and blocked_until

## Result — done (check passed) (2026-09-25 04:10)

AGENT-ORCH-STATUS: done — scheduling tests added; npm test passes, all 73 tests
