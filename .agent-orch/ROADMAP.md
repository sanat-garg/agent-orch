# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-25 (reflect #73)._ `npm test` passes. Audit round 3 (#71) found five real bugs in the newest code
(AUDIT #22–#26): races in sign-in start/cancel, a Connections panel stuck after a reconnect or restart, a
"Restart when idle" that kills in-flight chat replies, pasted codes starting with `-` being read as tmux flags,
and old limit notices that read "until now". All of them are in shipped but not yet live code, so fixing them
now is the most valuable work before the owner starts relying on these features.

**Owner action (still pending):** the live service has run since 03:23 UTC, so nothing from #32 onward is live.
Restart it once by hand while no task runs (`sudo systemctl restart agent-orch`), then sign in to Codex/agy from
the sidebar's Connections panel.

## Next (queued)
1. AUDIT #25: send pasted codes with `--`, and fail if the send fails.
2. AUDIT #22: make login start/cancel/finish race-safe (after 1, same file).
3. AUDIT #23: refetch connections on WS reconnect, have cancel return state, and kill orphaned login tmux at boot (after 2).
4. AUDIT #24: restart-when-idle waits for busy chat and planner turns, and can be cancelled.
5. AUDIT #26: past limit notices show an absolute time, not "now".

## Later
- A real end-to-end codex/agy task run, once the owner has signed in.
- SIGTERM handler that marks runs interrupted. Low value: orphans are already requeued on start.
- Split public/app.js (~2.7k lines) into native ESM modules, once there is a UI smoke check.
- Mobile layout review on a real phone.
- The test suite takes about 60 s. Check for slow fixed sleeps if it keeps growing.
