# Task #388: Fix the failing worker-cap test: nodeCap keeps a worker's CPU and max-tasks cap when the owner set max slots

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-28 13:14  
- files: orchestrator.mjs, cap.mjs, test/worker-cap.test.mjs

## Prompt

test/worker-cap.test.mjs 'the head keeps to a worker's local cap' fails on main since #311: orchestrator.mjs `nodeCap` (around line 1469) computes the owner-capped branch as `Math.min(n.maxSlots, localCap(n)?.maxTasks ?? Infinity)`, which drops the worker's CPU cap (`node worker.mjs limit --cpu 4` → 4 tasks at cpuPerTask cores each, cap.mjs `capTasks`). The head then offers jobs the worker refuses (cap.mjs `capRejection`). BRIEF goal 11 says the head must respect the worker's local cap; BRIEF goal 9 says RAM is never a pre-emptive throttle, so the RAM part of the old expectation is stale, not the code. Change: in the `n.maxSlots != null` branch use `Math.min(n.maxSlots, capTasks(localCap(n), CFG.cpuPerTask?.[agent] ?? CPU_PER_TASK))` (import capTasks from cap.mjs; capTasks(null, …) must return Infinity, check and adjust cap.mjs if not) and leave the Auto branch alone. Then update the test's expectations and comment: `capped` stays 4 (its CPU cap), `ram-used` becomes 8 (its RAM cap no longer limits the head; the worker still enforces it locally) and `workers` sums accordingly; keep every other expectation. Keep the orchestrator.mjs diff to that one expression plus the import so it merges cleanly with the queued placement work (#344/#378/#301). Run only `npm test -- test/worker-cap.test.mjs`.

## Done when

`npm test -- test/worker-cap.test.mjs`
