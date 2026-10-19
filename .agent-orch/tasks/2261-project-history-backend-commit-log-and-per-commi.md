# Task #2261: Project history backend: commit log and per-commit diff API, with tests

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:22  
- files: commits.mjs, changes.mjs, server.mjs, test/commits.test.mjs

## Prompt

Add a read-only project commit history API to agent-orch, so the owner can browse what changed over time (idea from siteboon/claudecodeui's Git explorer; patterns only, don't copy its code). Read .agent-orch/CONTEXT.md first, plus changes.mjs, which already does numstat parsing and size-capped patches for one task's changes.

1. New module `commits.mjs` (header comment in the style of changes.mjs/digest.mjs). It's read-only: it never writes to the index, refs or working tree.
   - `projectCommits(top, { branch, before, limit = 50 })` → `{ branch, commits: [{ sha, subject, author, at, task, add, del, files }], more }`. Newest first, using `git log --first-parent` on the project's current branch. If `before` is given, start after that commit (its parent onward). `at` is epoch ms. `task` is the number N when the subject starts with `agent-orch #N:`, else null. add/del/files are totals from --numstat. Clamp `limit` to 1–200. `more` is true when older commits exist. A repo with no commits returns `{ commits: [], more: false }` and doesn't throw.
   - `commitDetail(top, sha, { maxBytes = 200_000 })` → `{ sha, subject, body, author, at, task, files: [{ path, add, del, binary }], patch, truncated }`. Use `git show` with the same flags and line-boundary cap as changes.mjs. If you need changes.mjs's helpers (parseNumstat, gitCapped, patchBuilder), export them from changes.mjs rather than duplicating them; that is the only changes.mjs edit allowed. A sha that isn't 4–40 hex characters throws an error with `code = 400`. An unknown sha throws with `code = 404`.
2. server.mjs: add two routes next to the existing `/api/orch/tasks/:id/changes` route, keeping the hunk small. This file is edited by many tasks at once.
   - `GET /api/orch/projects/:id/commits?before=&limit=`
   - `GET /api/orch/projects/:id/commit?sha=&max=`
   Resolve the folder with `orch.pathOf('project', id)` (404 'No such project' when missing) and `repoInfo(dir)` as the changes route does (500 when the folder isn't a git repo on a branch). Map the module's 400/404 codes to those statuses with a clear `error` message. Both paths match the existing `/api/orch/projects/:id/<word>` ownership regex; keep it that way, with no extra path segments. Never import server.mjs in a test; check it with `node --check`.
3. `test/commits.test.mjs`: run against a temp git repo (create it with `git init -b main` in a mkdtemp dir). Cover the main path: three commits, one with subject `agent-orch #7: x`, so the list is newest first with task 7 parsed, `limit=2` gives `more: true`, `before` pages to the last one, and the detail has per-file counts and a patch. Cover the failures: an unknown sha gives code 404, `'zz'` gives 400, and an empty repo gives an empty list.

API contract shared with a parallel UI task (public/commits.js). Don't change the field names.

## Done when

`npm test -- test/commits.test.mjs` passes and `node --check server.mjs` succeeds

## Result — done (check passed) (2026-10-19 14:28)

AGENT-ORCH-STATUS: done — commits.mjs history API, two server routes, tests passing
