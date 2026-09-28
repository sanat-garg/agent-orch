# Task #436: Rapid top-up fills every machine's free slots with work it can actually run

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 14:24  
- files: orchestrator.mjs, test/rapid-topup-capacity*.test.mjs

## Prompt

The owner sees the MacBook Pro with a parallel limit of 11 get only 2 tasks. The planner found at 14:24: only 4 ready tasks were placeable on workers; 8 other 'ready' tasks were head-only integrators, and the rest waited on prerequisites. The rapid-mode top-up (#300: triggers reflection when ready < free slots + 2) counts integrators and head-only work as ready, so it never tops up enough for the workers. Fix it in orchestrator.mjs: 1) Compute the placeable-ready count per node class: worker-eligible ready work (prerequisites met, not head-only, not held by a checkpoint or approval) vs the total FREE WORKER SLOTS across online workers (the sum of each worker's target minus running; e.g. the Pro's 11); and head-only ready work vs free head slots, separately. 2) Top-up triggers when worker-eligible ready < free worker slots (+2 buffer), and asks the reflection for that many worker-runnable tasks (independent, file-disjoint where possible, no chains), with the head/integrator backlog noted in the prompt. Keep the minimum interval (3 min), and let it fire again as soon as the previous reflection has queued its tasks. 3) Also prefer shallow dependency chains in reflection output: tasks with `after` count as not ready for this purpose. 4) Expose it in the state and queue header: 'Workers: 9 free · 3 ready → topping up'. Respect Keep improving off (#383) and the near-limit guard. 5) Tests: with 11 free worker slots and 4 worker-ready plus 8 integrators, the top-up requests about 9 (11 + 2 − 4) worker-runnable tasks; with enough worker-ready tasks, no top-up; head-only work is not counted toward worker demand. Run only the touched test files.

## Done when

`node --test test/rapid-topup-capacity*.test.mjs` passes (worker-slot-based demand, integrators excluded, no top-up when enough worker-ready work)
