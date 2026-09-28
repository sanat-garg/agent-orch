# Task #276: Integrator merge deletes the integrated task's branch from origin; remove the stale task-258 branch

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 05:45  
- files: orchestrator.mjs, test/integrator-fail.test.mjs, test/worktree.test.mjs

## Prompt

Gap: in orchestrator.mjs, the merged-task cleanup near line 3152 (`if (remote || task.wip_sha) await git(project.path, ['push', '-q', 'origin', '--delete', taskBranch(tid)])`) deletes only the finishing task's own `agent-orch/task-<id>` branch. When the finishing task is an integrator (`task.integrates` set), the task it integrated was the one that ran remotely or pushed WIP, so its `agent-orch/task-<integrates>` branch stays on GitHub forever; `origin/agent-orch/task-258` (integrated by #261) is such a leftover. Fix: after a successful merge, when `task.integrates` is set, look up the integrated task (getTask) and, if it has node_id other than the controller or a wip_sha, also `push --delete` taskBranch(task.integrates) (swallow errors like the existing call). Extend test/integrator-fail.test.mjs or test/worktree.test.mjs (whichever already has a bare origin fixture; test/cluster-e2e.test.mjs shows how a temp bare repo stands in for GitHub) with one test: an integrator merging a task whose row has wip_sha set removes that task's branch from the bare origin. Finally, one-off cleanup: `git ls-remote --heads origin` in /home/ubuntu/agent-orch, confirm `agent-orch/task-258` is the only stray task branch and that #258 is done (JOURNAL.md 2026-09-28 03:44 says #261 integrated it), then `git push origin --delete agent-orch/task-258`. Do not touch any `claude/*` or `backup/*` branch. Run the test file you edited.

## Done when

`npm test -- test/integrator-fail.test.mjs` passes and `! git ls-remote --heads origin agent-orch/task-258 | grep -q task-258`
