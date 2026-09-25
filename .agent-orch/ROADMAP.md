# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-25 (reflect #31)._ `npm test` passes 41/41. The rename (goal 4) is almost finished, but "Claude Web" is still
in orchestrator.mjs: the header, PLANNER_SYSTEM (which every planner session sees) and the git commit identity. The
multi-agent work (goal 5) is wired end to end: adapters, routing and UI. It has one real gap: an agent counts as
"available" when its binary is on PATH. Codex is installed but not logged in, so a "use codex for X" route would
send tasks into auth failures instead of falling back to Claude.
AUDIT: #1, #3, #4 and #7 are marked fixed. #2 (lock file, task #16) and #15 (unit name, fixed by the rename) are
fixed in code but not marked. #16 (the verifier runs only the first backticked command) is still open and has already
cost task #20 eight failed verifications. #5, #6 and #8–#14 are open. The DoD needs each one fixed or explicitly deferred.

## Next (queued)
1. Remove the remaining "Claude Web" strings and mark AUDIT #2 and #15 fixed.
2. AUDIT #16: make the verifier run every command-like backticked snippet in "Done when", with unit tests.
3. Agent login detection: `loggedIn()` per adapter, exposed on /api/agents. Routing treats a logged-out agent as unavailable.
4. AUDIT #8: close the parallel-request login lockout bypass, with a regression test.
5. AUDIT #14: an oversized request body gets a 413 instead of hanging, with a regression test.

## After that (not queued yet)
- UI: show "not logged in, run `codex login --device-auth`" in the agent picker and routes list (uses #3's field).
- AUDIT #9: expired sessions keep their WebSocket. #13: per-line JSONL parsing.
- AUDIT #6: deleting a chat mid-plan. #5: planner concurrency and duplicate plan tasks.
- AUDIT #10: async git in the orchestrator. #11: cancel the runCheck process group. #12: ensureRepo dedupe.
- A real end-to-end run on codex/agy once the owner logs them in (owner action: `codex login --device-auth`, `agy`).
- Close out the DoD: every AUDIT.md item marked Fixed or Deferred.

## Ideas / Later (goal 3: usability)
- Unit tests for orchestrator scheduling (with the SDK stubbed).
- UI polish pass: mobile layout, connection-status indicator, task log readability.
- Split app.js (2.5k lines) into native ESM modules.
