# Task #155: Run concurrent tasks in isolated git worktrees and merge back safely

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 04:21

## Prompt

CFG.concurrency is already 2-3 (orchestrator.mjs ~line 27), but concurrent tasks share one working tree, so they can clobber each other's edits and commits. Make each work task run in its own git worktree: 1) On claim, create a worktree at <project>/../.agent-orch-worktrees/<project>-task-<id> (outside the repo, on branch agent-orch/task-<id> from the current HEAD), and run the agent and the done_when check there. Symlink or copy node_modules if it exists, so checks work. 2) On success, merge back into the project's main branch in the main working tree (serialised with a per-project merge lock): rebase the task branch onto the current main, fast-forward, commit, push as today, then remove the worktree and branch. On rebase conflicts, don't force it: mark the task 'needs integration', keep the worktree, and queue an integrator task (see the parallel-planning task) or surface the conflict in the drawer. 3) The live server's own project (agent-orch itself) works the same way: the running server keeps using the main tree, and only merged commits land there. 4) Chat-mode (non-task) runs keep using the main tree. 5) Resume after restart: find existing worktrees for running/interrupted tasks and reuse them. Clean up orphaned worktrees at boot. Tests in a temp git repo: two concurrent tasks editing different files both merge; two editing the same line produce a needs-integration result; a worktree is cleaned up after success.

## Done when

`npm test` passes with worktree tests (parallel merge of disjoint edits, conflict → needs integration, cleanup)
