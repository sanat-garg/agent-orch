# Journal

_Append-only record of completed work, written by the orchestrator._

## 2026-09-25 03:21 — #17 Fix chat context rollover orphaning the new runtime (AUDIT #3) [done (check passed)]

Literal runtimes.get(convo.id) === rt guard present; tests pass

## 2026-09-25 03:22 — #18 Stop losing messages sent while WebSocket reconnects (AUDIT #7) [done (check passed)]

Unsent messages stay in composer with a reconnecting notice
