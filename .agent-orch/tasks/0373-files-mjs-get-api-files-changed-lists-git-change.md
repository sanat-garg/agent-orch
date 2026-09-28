# Task #373: files.mjs: GET /api/files/changed lists git-changed files and /api/files/diff serves one file's diff

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:54  
- files: files.mjs, test/files.test.mjs

## Prompt

Backend for a 'Changed' view in the Files tab (public/files.js is done in a later task; do not edit it here). In files.mjs add two read-only routes to handleFiles's regex and header comment: `GET /api/files/changed?cid=` → {branch, entries: [{path, status, add, del, binary}], truncated} where status is one of 'M','A','D','R','?' (renamed: the new path) from `git status --porcelain=v1 -z --untracked-files=all` run in the project's real root (resolveInside(root,'')), add/del from `git diff --numstat -z HEAD --` (untracked files count their line total as add, 0 when binary), sorted by path, capped at 2000 entries (truncated), and `{branch: null, entries: [], notGit: true}` with 200 when the folder is not a git repo (`git rev-parse --show-toplevel` fails). `GET /api/files/diff?cid=&path=` → text/plain unified diff of that one file against HEAD (`git diff --no-color --no-ext-diff HEAD -- <path>`; for an untracked file `git diff --no-index /dev/null <path>`, which exits 1 with output: accept it), under the same sandbox CSP as sendFile, capped at 200 KB with an X-Truncated: 1 header, 404 when the path is unchanged/missing. Use execFile('git', …) with timeout 20 s and maxBuffer 16 MB, never a shell; paths from git are relative to the toplevel, so when the project root is a subfolder of the repo, run git with `-C root` and `--relative`. Respect the existing rules: the path must pass resolveInside, .agent-orch-worktrees and node_modules entries are skipped. Tests in test/files.test.mjs with a temp git repo (git init, a commit, then modify one file, add an untracked one, delete one): changed lists M/?/D with counts; diff returns the hunk for the modified file and the /dev/null diff for the untracked one; a non-git folder gives notGit. Run only `npm test -- test/files.test.mjs`.

## Done when

`npm test -- test/files.test.mjs` passes and `grep -q 'api/files/changed' files.mjs`

## Result — done (check passed) (2026-09-28 13:01)

AGENT-ORCH-STATUS: done — Changed-files and per-file diff routes added and tested
