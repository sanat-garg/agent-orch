# Task #767: Integrate #761: Files backend: download a file, or a streamed zip of several

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-09-28 23:16  
- files: files.mjs, server.mjs, test/files-download*.test.mjs

## Prompt

Task #761 ("Files backend: download a file, or a streamed zip of several") finished in its own git worktree, but its branch `agent-orch/task-761` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #761's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #761's instructions were:

Add a download endpoint (files.mjs + server.mjs, login-protected, same path rules as #437: absolute or project-relative paths, realpath, readable by the server user; PROTECTED files (secrets, keys, auth files) are refused, and inside a folder they're skipped with a note). Contract (the UI task codes against it; keep it exact): GET /api/files/download?path=<p> for ONE regular file streams it with Content-Disposition: attachment; filename*=UTF-8''<name>, the right Content-Type, and Content-Length. GET /api/files/download?path=<p1>&path=<p2>… (several) OR a single directory streams a ZIP generated on the fly (never written to disk; use the system `zip` via stdin/stdout if installed, `sudo apt-get install -y zip` on this server, or a small streaming pure-node ZIP writer, dependency-free) named '<folder>.zip' for one dir or 'agent-orch-files.zip' for several. Entry paths inside the zip are relative to the common parent, with symlinks stored as their targets only if they point inside the selection, else skipped. Caps: 2 GB total and 50k entries; over the cap, 413 with a clear error. Cancel generation when the client disconnects. Errors are JSON {error} with 400/403/404. Tests: a single file downloads with the attachment header and the exact bytes; two files produce a valid zip whose entries match (unzip it in the test); a directory zips recursively; a protected file is refused (403), and inside a folder it's skipped; a disconnect stops the zip process. Run only the touched test files.

## Done when

`node --test test/files-download*.test.mjs` passes (single file bytes and header, multi-file and directory zips valid, protected refused/skipped, disconnect stops)

## Result — done (check passed) (2026-09-28 23:17)

AGENT-ORCH-STATUS: done — CONTEXT.md conflict resolved; download backend and UI tests pass
