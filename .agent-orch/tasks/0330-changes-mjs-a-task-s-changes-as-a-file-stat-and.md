# Task #330: changes.mjs: a task's changes as a file stat and a capped patch, from its merged commit or live branch

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:43  
- files: changes.mjs, test/changes.test.mjs

## Prompt

New module changes.mjs (the backend of a future task drawer 'Changes' section; the route and UI follow later, do not touch server.mjs, orchestrator.mjs or public/). Export `async function taskChanges(info, id, { maxBytes = 200_000 } = {})` where `info` is worktrees.mjs repoInfo(projectPath) ({top, branch, ...}; read worktrees.mjs first and reuse its git helpers/GIT_ID where sensible) and `id` the task id. Sources, in order: (1) a live worktree branch `agent-orch/task-<id>` (worktrees.mjs taskBranch) that exists: diff from `git merge-base <info.branch> <task branch>` to the branch tip, plus uncommitted changes in the worktree dir if it exists (worktreePath); source 'branch'; (2) else the squash commit(s) on info.branch whose subject starts with `agent-orch #<id>:` (`git log --format=%H --grep` anchored with a regex, oldest first): the combined diff of those commits; source 'commit'; (3) else return {source: 'none', files: [], patch: '', truncated: false}. Return {source, commits: [sha...], files: [{path, add, del, binary}] from `git diff --numstat`, patch: the unified diff text (`git diff` / `git show --format=` with `--no-color`), truncated: true when the patch was cut at maxBytes (cut at a line boundary)}. Never throw for a missing branch/commit: return source 'none'; git failures on a broken repo reject. Write test/changes.test.mjs copying test/worktree.test.mjs's temp-repo setup: create a repo with a base commit, a task branch with one commit and one uncommitted edit → source 'branch' with both changes; merge it as a squash commit titled `agent-orch #7: thing` and delete the branch → source 'commit' with the file stat; an unknown id → 'none'; maxBytes 50 → truncated true. Add a one-line module pointer to .agent-orch/CONTEXT.md only if that file is not being edited by another task (it currently is: skip it, the roadmap tracks the wiring).

## Done when

`npm test -- test/changes.test.mjs` passes and `grep -n 'export async function taskChanges' changes.mjs` prints a line.

## Result — done (check passed) (2026-09-28 11:47)

AGENT-ORCH-STATUS: done — changes.mjs taskChanges returns branch/commit/none diffs; tests pass
