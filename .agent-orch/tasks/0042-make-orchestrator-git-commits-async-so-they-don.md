# Task #42: Make orchestrator git commits async so they don't block the server (AUDIT #10)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:50  
- starts after: #41

## Prompt

Fix AUDIT #10 in /home/ubuntu/agent-orch/orchestrator.mjs. `git(p, args)` (around line 1063) uses `execFileSync` with a 120 s timeout, and `gitCommit`/`ensureGit` make up to 4 calls per commit, freezing all HTTP/WS traffic during slow `git add -A` or hooks. Switch `git()` to a promisified `execFile` (util.promisify, same cwd/encoding/timeout, maxBuffer large enough, for example 16 MB) and make `gitCommit` and `ensureGit` async. Await them at every call site (finishWork, verifyFailed, fail, finishReflection and any others; grep for `gitCommit(` and `ensureGit(` and `git(`). Callers must keep their current ordering and error handling: a failing commit must still be caught and logged the same way, not become an unhandled rejection. Leave the other execFileSync uses (agent detection around lines 579/746/1078) alone unless they run per task. Run `npm test` and `node --check orchestrator.mjs`. Mark AUDIT #10 `**Fixed**` in .agent-orch/AUDIT.md. Never restart the live server.

## Done when

`! grep -q "function git(p, args) { return execFileSync" orchestrator.mjs` and `npm test` passes

## Result — done (2026-09-25 03:54)

AGENT-ORCH-STATUS: done — Orchestrator git commits now async and serialized; tests pass
