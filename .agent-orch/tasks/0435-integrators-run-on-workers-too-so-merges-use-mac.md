# Task #435: Integrators run on workers too, so merges use Mac capacity

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 14:24  
- files: orchestrator.mjs, worker.mjs, cluster-git.mjs, test/integrate-on-worker*.test.mjs

## Prompt

Integrator tasks ('Integrate #N', tasks with `integrates`) are head-only today (orchestrator.mjs ~line 343 comment and the ~1502 placement assertion: 'they need the controller's conflicted worktree'). With 8 ready integrators and 1 head slot they serialize, and everything waiting on them stalls, while Macs sit idle. With #345 (workers fetch and push through the head's git endpoint), make integrators placeable on workers: 1) An integrator job carries the integrated task's branch (agent-orch/task-<N>), the current main sha and the conflicting files. The worker fetches both via the head git endpoint, creates a worktree on a new branch agent-orch/integrate-<id> from main, merges or rebases the task branch, and gives the agent the conflict hunks to resolve (the same prompt as head integrators), then runs the done_when check and pushes agent-orch/integrate-<id>. 2) The head lands it: if main hasn't moved, fast-forward main to it; if it moved, try an automatic rebase of the integrate branch onto the new main (the retry from #378/#427); only if that conflicts again, queue another integrator, and cap the chain at 3 before alerting the owner. Record 'merged by integrator #id on <node>'. The head-git push rules allow a worker to push agent-orch/integrate-<id> for integrators assigned to it. 3) Placement: integrators prefer the head while it has free reserved integration slots (#384); otherwise they go to any worker by the normal spread rule. Remove the head-only assertion for integrators (keep it for plan/reflect/review/chat). 4) Tests with a fake worker and a local bare 'origin' via the head endpoint: a conflicting task branch is integrated on the worker and main fast-forwards; main moving meanwhile leads to a rebase then landing; a repeated conflict queues at most 3 integrators then alerts; plan/reflect remain head-only. Run only the touched test files.

## Done when

`node --test test/integrate-on-worker*.test.mjs` passes (worker integration lands on main, moved-main rebase, bounded re-integration, plan/reflect still head-only)
