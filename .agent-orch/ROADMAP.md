# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-25 (reflect #37)._ `npm test` passes 48/48. All five tasks from reflect #31 landed. The rename (goal 4) is done.
Multi-agent routing (goal 5) now falls back to Claude when an agent isn't logged in. The UI still doesn't use this:
the chat picker enables an agent group when `available` (on PATH) is true and ignores `loggedIn`, so a logged-out
Codex looks usable, and its chat turns fail on auth.
AUDIT: #1–#4, #7, #8 and #14–#16 are fixed. Still open: #5, #6, #9, #10, #11, #12 and #13. I checked each open item
against the current code. #6 is only half-covered: the interrupt path clears `planQueue`, but the DELETE handler
(server.mjs ~1126) doesn't. The DoD needs every AUDIT item fixed or explicitly deferred, so closing them is the main job.

## Next (queued)
1. AUDIT #9: the WS keepalive calls `syncSessions()` and closes expired or revoked sessions with 4001.
2. AUDIT #6: DELETE clears `planQueue`, and `orchestratorTurn` stops when the convo is gone.
3. AUDIT #13: parse JSONL line by line in `readLog` and `taskDetail`, skipping corrupt lines.
4. UI: the agent picker and routes list show "not logged in" (with the login command) based on `loggedIn`.
5. AUDIT #10: make orchestrator git commits async so they don't block the event loop.

## After that (not queued yet)
- AUDIT #11: pass the abort signal to `runCheck` and kill the process group on abort/close.
- AUDIT #12: per-dir inflight dedupe in `gh.ensureRepo`.
- AUDIT #5: a per-project planner-busy guard shared by chat `planTurn` and plan tasks, and dedupe of rate-limit plan tasks.
- Close out the DoD: every AUDIT.md item marked Fixed or Deferred, and README checked against the current setup.
- A real end-to-end run on codex/agy once the owner logs in (owner action: `codex login --device-auth`, `agy`).

## Ideas / Later (goal 3: usability)
- Unit tests for orchestrator scheduling (with the SDK stubbed).
- UI polish pass: mobile layout, connection-status indicator, task log readability.
- Split app.js (2.5k lines) into native ESM modules.
