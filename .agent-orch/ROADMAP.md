# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-25 (reflect #43)._ `npm test` passes 50/50. All five tasks from reflect #37 landed: AUDIT #6, #9, #10 and #13, plus the "needs sign-in"
state in the UI. Goals 1, 4 and 5 are in place.
AUDIT still has three open items, and I checked each one against the code:
- **#5:** `planningProjects` only blocks reflections. Plan-kind tasks (orchestrator.mjs ~1338) can still resume `chat_session_id` while a chat `planTurn` runs. `plannerRun`'s rate-limit branch (~1252) adds "Answer owner's message" without the "already queued" check.
- **#11:** `runCheck` has no abort signal and doesn't kill the process group on close.
- **#12:** `ensureRepo` has no inflight dedupe; only `push` has one.

The README doesn't mention multi-agent at all: no Codex or agy, and nothing on logins or routes. Closing these items meets the Definition of Done.

## Next (queued)
1. AUDIT #12: per-dir inflight dedupe in `gh.ensureRepo`.
2. AUDIT #11: `runCheck` takes the task's abort signal and kills the process group on abort and on close.
3. AUDIT #5: a per-project planner-busy guard shared by chat `planTurn` and plan tasks, and dedupe of rate-limit plan tasks.
4. README: a multi-agent section covering installing and logging in to Codex and agy, how routing rules work, and the Claude fallback.
5. DoD closeout: every AUDIT.md item is marked Fixed or Deferred, and the README is checked against the live setup.

## After that (not queued yet)
- A real end-to-end run on codex/agy once the owner logs in. Owner action: `codex login --device-auth`, then `agy`.
- Unit tests for orchestrator scheduling (priority, preemption, blocked_until) with the SDK stubbed.

## Ideas / Later (goal 3: usability)
- UI polish pass: mobile layout, connection-status indicator, task log readability.
- Split app.js (2.5k lines) into native ESM modules.
- Show why a route fell back to Claude directly on the task card.
