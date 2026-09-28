# Task #467: Integrate #453: Fix the post-restart claim stall: 19 free slots, ready tasks, nothing starts

- kind: work  
- source: planner  
- priority: 95 (normal)  
- created: 2026-09-28 16:57  
- files: orchestrator.mjs, server.mjs, public/app.js, test/claim-stall*.test.mjs

## Prompt

Task #453 ("Fix the post-restart claim stall: 19 free slots, ready tasks, nothing starts") finished in its own git worktree, but its branch `agent-orch/task-453` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md, orchestrator.mjs, public/app.js). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #453's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #453's instructions were:

URGENT stall. After the server restart at 14:48:26 on 2026-09-28, only the 2 requeued integrators started (#439 and #448, both integrators on the head). For 3+ minutes nothing else started, although rapid mode reported '19 slots, 0 running, 19 free' and at least 8 queued work tasks had no unfinished prerequisites (#344, #418, #438, #444, #445, #447, #449, #450, #452). There was no error in `journalctl -u agent-orch`. The scheduler did prepare #445 (commit b898c75 'agent-orch: uncommitted changes before #445') but never logged 'started #445'. Suspects, in order: (a) the rolling-restart path (orchestrator.mjs ~2689-2725: prepareRestart sets draining=true and waits up to 5 min for integrators, since restartBlocker = 'integrator #N is merging'), which, if a restart is pending, stops ALL claiming, including worker-bound work that survives restarts anyway, while integrators run; (b) head-capacity or integrator slot reservation (#384) counting the running integrators so the effective slots drop to 0 while the 'slots' figure says 19; (c) the claim path failing silently after the pre-claim commit (e.g. the push queue from #427, the placement from #436/#384, or a thrown error that's swallowed); (d) the '0 running' figure not counting integrators, leading to inconsistent accounting. Do: 1) Reproduce with the test harness: a state with 2 running head integrators and N ready work tasks with online fake workers, and run tick(). Add a debug-level 'claim decision' log for every ready task per tick when nothing was claimed ('#445 not started: <reason>'), rate-limited to once per minute per task, and surface the top reason in the queue header ('Waiting: restart pending (integrator #439 merging)'). 2) Fix the root cause. Whatever it is, the rules are: a pending rolling restart never blocks claims of work placed on WORKERS (those survive restarts), and it only holds new HEAD-local claims, at most for the restart window; integrators and reserved slots never reduce the worker capacity; and a failed claim after the pre-claim commit logs and retries instead of silently doing nothing. 3) Make the rapid-mode 'running' figure count everything running (integrators included), so the numbers are consistent. 4) Tests: with a restart pending and head integrators running, ready work is still placed on workers; a claim-path exception is logged and the next tick retries; the queue header shows the stall reason when nothing can start. Run only the touched test files, then verify on the LIVE server after deploy (the rolling restart) that more than the integrators are running within 2 minutes when ready tasks exist.

## Done when

`node --test test/claim-stall*.test.mjs` passes (worker claims continue during a pending restart, claim errors retried, stall reason surfaced)

## Result — done (check passed) (2026-09-28 17:02)

AGENT-ORCH-STATUS: done — merge conflicts resolved; claim-stall and related tests pass

## Result — verify failed (1) (2026-09-28 17:02)

Command: merge main again

main changed meanwhile; conflicts in: .agent-orch/CONTEXT.md

## Result — done (check passed) (2026-09-28 17:02)

AGENT-ORCH-STATUS: done — CONTEXT.md conflict resolved; claim-stall tests pass
