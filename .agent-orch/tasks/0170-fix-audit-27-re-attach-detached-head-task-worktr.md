# Task #170: Fix AUDIT #27: re-attach detached-HEAD task worktrees instead of deleting them

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 10:31  
- files: worktrees.mjs, test/worktree.test.mjs

## Prompt

Read .agent-orch/AUDIT.md finding #27 (Round 4) first. Bug: worktrees.mjs `listWorktrees` only lists worktrees whose porcelain block has `branch refs/heads/agent-orch/task-N`, so a task worktree on a detached HEAD (after a rebase killed mid-mergeBack, or an agent running `git checkout <sha>`) is invisible. `ensureWorktree` then prunes, `rmSync`s the still-registered directory (losing uncommitted work) and `worktree add` fails with 'missing but already registered worktree'; `taskWorktree` returns null and the task may run in the live main tree. Fix in worktrees.mjs: (1) make `listWorktrees` also recognise entries by directory name (`<repo>-task-<id>` under the worktrees root), whatever their HEAD; (2) when reusing such a worktree, abort a leftover rebase if `rebase-merge`/`rebase-apply` exists in its git dir, and if HEAD is detached, commit any uncommitted work and then `git switch` it back to (or reset the branch to include) `agent-orch/task-N` so no commits are lost; (3) never `rmSync` a directory that `git worktree list` still has registered. Make sure `cleanupWorktrees` also sees these entries. Add a regression test in test/worktree.test.mjs reproducing the AUDIT repro: create the worktree with `ensureWorktree(info, 7)`, commit a file, `git checkout --detach`, write uncommitted `wip.txt`; then `ensureWorktree(info, 7)` must succeed, return reused: true, keep `wip.txt` and the committed file, and leave HEAD on `agent-orch/task-7`. Do NOT edit .agent-orch/AUDIT.md (a later reflection marks it). Never restart the live server on port 3000.

## Done when

`node --test test/worktree.test.mjs` passes, including a new test for a detached-HEAD worktree keeping its uncommitted file.

## Result — done (check passed) (2026-09-26 10:37)

AGENT-ORCH-STATUS: done — Detached-HEAD task worktrees re-attach and keep work; tests pass
