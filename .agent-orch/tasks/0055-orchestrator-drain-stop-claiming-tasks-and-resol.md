# Task #55: Orchestrator drain(): stop claiming tasks and resolve when running tasks finish

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 04:13  
- starts after: #54

## Prompt

Read .agent-orch/CONTEXT.md first. In orchestrator.mjs, add a `drain()` method to the object returned by createOrchestrator. After it is called, tick() must not claim any new task (plan, work or reflect), but running tasks keep going. It returns a Promise that resolves once `running.size` is 0 (resolve immediately if nothing is running). Add `draining: true/false` to stateView(). Draining is in-memory only: never persist it to kv, because it must reset on restart. Keep the style terse. Add test/drain.test.mjs, following test/scheduling.test.mjs (child process, fake `query`, CW_DATA_DIR temp dir, rows inserted via node:sqlite). It checks that a running task finishes and drain() then resolves, and that a queued task is not claimed while draining. Do not restart the live service.

## Done when

`node --test test/drain.test.mjs && npm test`

## Result — done (check passed) (2026-09-25 04:18)

AGENT-ORCH-STATUS: done — drain() stops claims, resolves when idle; tests pass
