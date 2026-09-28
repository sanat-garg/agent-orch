# Task #421: worktrees.mjs: git operations retry lock races and network blips through retryGit

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:14  
- files: worktrees.mjs, test/worktree.test.mjs

## Prompt

Goal: the main tree of the live checkout is touched by several sessions and orchestrator auto-commits at once, so worktrees.mjs's git calls (`worktree add`/`prune`, `commitAll`'s add/commit, `mergeBack`'s rebase and fast-forward, `reattach`) can fail on `Unable to create '.git/index.lock': File exists` or `cannot lock ref` even though a retry a moment later would succeed; such a failure marks the task failed at merge time. taskrun.mjs exports `transientGit(text)` (is this stderr a lock race or a network blip) and `retryGit(fn, {attempts, backoffMs, jitter, sleep})` (task #409, test/git-retry.test.mjs). In worktrees.mjs, wrap the module's `git(cwd, args)` helper so every call goes through `retryGit` (keep the default attempts/backoff; the error thrown after the last attempt must be the original one, with its stderr), and make sure `ok()` (the boolean helper) does not retry on genuine non-transient failures any slower than before. Do not retry commands whose repetition is unsafe when partially done: `commit` after a successful `add` may be retried, but a `rebase`/`merge` that fails on a real conflict must not be (transientGit already returns false for conflicts; add a test that proves it stays that way). Tests in test/worktree.test.mjs: hold `<top>/.git/index.lock` for ~300 ms from the test while `commitAll` runs and assert it succeeds; a real conflict in `mergeBack` still reports needs-integration without extra attempts (count the git invocations via an injected sleep or by timing). Keep orchestrator.mjs and worker.mjs untouched (held by other tasks).

## Done when

`npm test -- test/worktree.test.mjs test/git-retry.test.mjs` passes and `grep -c "retryGit" worktrees.mjs` prints at least 1
