# Task #352: worktrees.mjs AUDIT #62: a symlinked worktrees root still matches git's list, so a reused worktree is never deleted

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:31  
- files: worktrees.mjs, test/worktree.test.mjs

## Prompt

Reliability fix in worktrees.mjs (read its header and .agent-orch/AUDIT.md Round 7 finding #62). `git worktree add` records the REAL path of a worktree, but worktreesRoot joins dirname(top) with '.agent-orch-worktrees' without resolving it. When that directory is a symlink (the owner moved it to a bigger disk), no listed worktree ever matches worktreePath, so ensureWorktree sees 'not listed', registered() doesn't include the path either, and it rmSyncs the directory through the symlink, deleting the task's uncommitted work; the next attempt then throws 'is a missing but already registered worktree' forever. Verified repro: symlink <parent>/.agent-orch-worktrees → <parent>/other, ensureWorktree(info, 7), write work.txt inside, call ensureWorktree(info, 7) again → work.txt is gone. Fix: resolve the worktrees root with fs.realpathSync when it exists (fall back to the joined path when it doesn't yet), and compare git's listed paths against realpath'd paths everywhere a match is made (ensureWorktree's `listed`, registered(), pruneOrphanWorktrees, the byDir check near line 208). Also make the second ensureWorktree of the repro reuse the worktree (`reused: true`) and keep work.txt. Add a test to test/worktree.test.mjs that builds the symlink repro on a temp repo (copy the file's existing setup helpers) and asserts work.txt survives and the worktree is reused; also assert pruneOrphanWorktrees under a symlinked root does not remove a registered worktree. AUDIT.md is held by other tasks: do not edit it. Verify with `npm test -- test/worktree.test.mjs`.

## Done when

`npm test -- test/worktree.test.mjs` passes and `grep -q 'realpath' worktrees.mjs`
