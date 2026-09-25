# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-25 (reflect #79)._ The brief's definition of done is met: README exists, `npm test` passes (116 tests,
~67 s), and all 26 AUDIT items are fixed. The biggest remaining risk is the next restart, not a missing feature.
The live service has run since 03:23 UTC, so about 45 commits (multi-agent routing, DB migrations, Connections,
drain) will go live at once, against the real DB and real chat history they have never run on. Codex is
installed but not signed in, and agy has no verified sign-in, so multi-agent routing is still untested for real.

Next steps: add a flag that boots the server with the orchestrator off, then preflight HEAD against a copy of
the live data dir (DB migrations, chat history load, a headless-browser UI render with no console errors).
That way the owner's restart is a known-good step, not a gamble.

**Owner action (still pending):** when the preflight report says OK, restart once by hand while no task runs
(`sudo systemctl restart agent-orch`), then sign in to Codex/agy from the sidebar's Connections panel.

## Next (queued)
1. `CW_NO_ORCHESTRATOR=1`: server boots with the orchestrator on the DB but never claims or requeues tasks.
2. Preflight: boot HEAD on a copy of the live data dir with that flag, check migrations, APIs and a UI render.
   Write the results to .agent-orch/PREFLIGHT.md (after 1).

## Later
- A real end-to-end codex/agy task run, once the owner has signed in (then a small routing audit on real output).
- SIGTERM handler that marks runs interrupted. Low value: orphans are already requeued on start.
- Split public/app.js (~2.7k lines) into native ESM modules, once there is a UI smoke check.
- Mobile layout review on a real phone.
- Scheduling tests take about 11 s of fixed waits. Tighten them only if the suite keeps growing.
