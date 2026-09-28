# Task #417: Integrate #378: Rapid mode: file overlap never blocks a free slot; merges handle it

- kind: work  
- source: planner  
- priority: 95 (normal)  
- created: 2026-09-28 14:09  
- files: orchestrator.mjs, parallel.mjs, test/rapid-overlap*.test.mjs

## Prompt

Task #378 ("Rapid mode: file overlap never blocks a free slot; merges handle it") finished in its own git worktree, but its branch `agent-orch/task-378` conflicts with `main`, which changed meanwhile (conflicting files: orchestrator.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #378's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #378's instructions were:

The owner sees queued tasks not being delegated while machines have free slots. The planner confirmed at 12:54 (3 running, 9 free slots): every queued work task was blocked ONLY by the file-overlap gate. #368 (cluster.mjs, worker.mjs, server.mjs, public/app.js) blocked #312, #301, #344, #359, #314 and #364, and #347 (browser-live.mjs, browser-view.mjs, public/browser.js) blocked #363 and #348. Also #344 was started at 12:50:49 and then went back to 'queued', so check why (preemption? a failover? an overlap re-check?) and stop running tasks from being bumped for overlap. Since every task runs in its own git worktree and merge-back rebases, same-file edits in different hunks merge cleanly, and real conflicts already route to integrator tasks. Change the scheduler (orchestrator.mjs / parallel.mjs filesOverlap usage): 1) When rapid development mode is ON, file overlap is a SOFT preference, not a gate. Among ready tasks, prefer the ones that don't overlap running work, but if a slot is free and only overlapping tasks are ready, start them. Keep a per-file concurrency cap (default 3 tasks touching the same file at once) that auto-tunes: track merge outcomes per file over 24 h; if a file's rebase-conflict rate is over 30%, lower its cap by 1 (min 1); if under 10%, raise it by 1 (max 6). Show the caps in the Queue modal's lane header ('hot files: public/app.js ×3'). Tasks without declared files count as touching everything only in the sense of the soft preference, never as a hard block. 2) When rapid mode is OFF, keep today's strict behaviour. 3) Never preempt or requeue a running task because of file overlap. 4) The merge path: before rebasing, fetch the latest main; on conflict, try an automatic rebase once more after the other task's merge lands (a 30 s retry), and only then spawn the integrator. Record the conflict per file for the tuning. 5) Rapid-mode top-up and the planner context: include the hot files list, so new tasks are told to keep edits to hot files small and localised. 6) Tests: a free slot plus only an overlapping ready task → it starts in rapid mode and waits in strict mode; the per-file cap is enforced and tuned by recorded conflict rates; a running task is not requeued when an overlapping urgent task arrives; the conflict retry-then-integrator path works. Run only the touched test files.

## Done when

`node --test test/rapid-overlap*.test.mjs` passes (overlapping task starts in rapid mode, per-file cap and tuning, no requeue of running tasks, conflict retry then integrator)

## Result — done (check passed) (2026-09-28 14:32)

AGENT-ORCH-STATUS: done — orchestrator.mjs conflicts resolved, rapid-overlap tests pass, merge uncommitted

## Result — verify failed (1) (2026-09-28 14:32)

Command: merge main again

main changed meanwhile; conflicts in: .agent-orch/CONTEXT.md, orchestrator.mjs

## Result — done (check passed) (2026-09-28 14:33)

AGENT-ORCH-STATUS: done — merge conflicts resolved again, rapid-overlap tests pass
