# Task #282: removeWorktree always deletes the directory and ensureWorktree sweeps orphan task dirs

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 05:57  
- files: worktrees.mjs, orchestrator.mjs, test/worktree.test.mjs

## Prompt

Goal: no leftover directories under `<repo>/../.agent-orch-worktrees/`. Today /home/ubuntu/.agent-orch-worktrees/ holds seven `agent-orch-task-*` dirs (216, 217, 218, 219, 229, 231, 232) for long-finished tasks, each containing only `node_modules/.cache`: `git worktree remove --force` succeeded, so the `fs.rmSync` fallback in worktrees.mjs `removeWorktree` (near line 157) never ran, and nothing sweeps directories git no longer lists.

Do:
1. worktrees.mjs `removeWorktree`: after the `git worktree remove` attempt (success or not) and the prune, `fs.rmSync(dir, {recursive: true, force: true})` if the directory still exists.
2. Add a sweep (e.g. `pruneOrphanWorktrees(info, keep)`): for every `<repo>-task-<id>` dir in the worktrees parent that `git worktree list --porcelain` does not list, delete it unless `keep` (the ids of tasks that are running or need integration) contains its id. Call it from the orchestrator at startup after the requeue step (grep orchestrator.mjs for `requeued` / `interrupted task(s) after a restart`) with the live ids, and log one line when it removes anything.
3. Tests in test/worktree.test.mjs (copy its temp-repo setup): removing a worktree whose dir gained an untracked `node_modules/.cache` file leaves no directory; the sweep deletes an orphan dir and keeps one whose id is in `keep` and one git still lists.
4. Delete the seven stale dirs by hand (`rm -rf /home/ubuntu/.agent-orch-worktrees/agent-orch-task-{216,217,218,219,229,231,232}`) since the live server will not run the new code until its next restart. Do not touch any directory git lists or the worktree you are running in.

## Done when

`npm test -- test/worktree.test.mjs` && `! test -d /home/ubuntu/.agent-orch-worktrees/agent-orch-task-216` && `! test -d /home/ubuntu/.agent-orch-worktrees/agent-orch-task-232`

## Result — done (check passed) (2026-09-28 06:03)

AGENT-ORCH-STATUS: done — worktree dirs always removed; boot sweep deletes orphans; stale dirs gone
