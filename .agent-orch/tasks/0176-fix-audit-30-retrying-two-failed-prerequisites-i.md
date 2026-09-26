# Task #176: Fix AUDIT #30: retrying two failed prerequisites in either order revives their dependent

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 10:42  
- files: orchestrator.mjs, test/revive-deps.test.mjs

## Prompt

Fix AUDIT #30 in .agent-orch/AUDIT.md (read it first). In orchestrator.mjs, `reviveBlocked(rootId)` (near `cascadeBlock`/`releaseOwner`, ~line 1192) only revives failed/cancelled dependents whose `result` starts with `blockedPrefix(rootId)`. Scenario: task C depends on A and B. A fails, so C is marked failed with `blocked: #A (…)`. B fails too (its cascade skips C). Retry A: C stays down because B is still failed (correct). Retry B: C is not revived because its result names #A, not #B (the bug). Fix: when walking the dependents of a retried task, revive a failed/cancelled dependent if its result starts with the blocked prefix (or the `cancelled with #N` text) of ANY of its direct prerequisites (`depsOf(id)`), and none of those prerequisites is still failed or cancelled. Keep the existing cascade into the dependent's own dependents. Do not revive tasks that failed for their own reasons (their result has no blocked/cancelled-with prefix). Add a scheduling test in a NEW file test/revive-deps.test.mjs. Follow the pattern of the existing scheduling tests (test/scheduling.test.mjs, test/integrator-fail.test.mjs): createOrchestrator in a child process with a fake query, `config: { pollMs: 100 }`, and test/helpers/wait.mjs polling with no fixed sleeps. Cover both retry orders (A then B, B then A): C ends queued, and so does a task that depends on C. Do NOT edit .agent-orch/AUDIT.md (the next reflection marks it fixed). Never touch the live server on port 3000.

## Done when

`node --test test/revive-deps.test.mjs` passes and `npm test` passes.

## Result — done (check passed) (2026-09-26 10:51)

AGENT-ORCH-STATUS: done — retrying failed prerequisites in either order revives dependents
