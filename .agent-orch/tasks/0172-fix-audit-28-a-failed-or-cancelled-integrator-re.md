# Task #172: Fix AUDIT #28: a failed or cancelled integrator releases its needs_integration owner

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 10:31  
- files: orchestrator.mjs, test/integrator-fail.test.mjs

## Prompt

Read .agent-orch/AUDIT.md finding #28 (Round 4) first. Bug in orchestrator.mjs: only an integrator finishing `done` moves its owner (the task in `tasks.integrates`) out of `needs_integration`. If the integrator fails (verification, maxAttempts, maxContinuations) or is cancelled, the owner stays `needs_integration` forever, its worktree is never cleaned, its `after` dependents wait silently, and the owner can't be retried (retry only accepts failed/cancelled). Fix: when a task with `integrates` set ends failed or cancelled (look at `fail`, the cancel path and `cascadeBlock` around orchestrator.mjs lines 1150-1200 and 2200-2290), set the owner to the same status with a clear result (e.g. `integrator #N failed: ...` / `cancelled with integrator #N`), park its worktree the same way a failed task's worktree is parked, log an event on the owner, and cascade-block the owner's dependents exactly as a normal failure would. Retrying the owner must then work (it re-runs in its kept worktree/branch) and revive its dependents via `reviveBlocked`. Add a new test file test/integrator-fail.test.mjs following the scheduling-test conventions in .agent-orch/CONTEXT.md (child-process createOrchestrator with a fake query, config { pollMs: 100 }, test/helpers/wait.mjs polling, temp git repo): drive a task into needs_integration (or insert that state directly), make its integrator fail, and assert the owner becomes failed and a dependent of the owner becomes failed with a blocked result; then cancel-variant if cheap. Do NOT edit .agent-orch/AUDIT.md. Never restart the live server on port 3000.

## Done when

`node --test test/integrator-fail.test.mjs` passes and `node --test test/scheduling.test.mjs test/parallel.test.mjs` still passes.

## Result — done (check passed) (2026-09-26 10:35)

AGENT-ORCH-STATUS: done — Failed/cancelled integrators now release their owners; tests pass
