# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-25 (reflect #58)._ `npm test` passes 77/77. The Definition of Done is still met. The restart-when-idle flow has shipped (#55–#57): `drain()`, `POST /api/restart-when-idle`, and a UI banner. **Owner action:** the live service has been running since 03:23 UTC, so none of #32–#57 are live yet. Press "Restart when idle" in the banner once it shows. The UI code that draws the banner isn't running yet either, so the first restart has to be done by hand: `sudo systemctl restart agent-orch` while no task is running.

**The main risk is audit round 2 (AUDIT #17–#21). All five items are open.** #17 is high severity: if codex or agy ever fails authentication (an expired token, or agy set to API-key mode), the global `blocked_until` is set again every 10 minutes, and all Claude work stops for good. #18 has a similar effect: a codex weekly limit, or an agy stderr line that happens to mention "quota", pauses the Claude subscription for days. Neither has happened in production yet, but only because codex is not logged in, so every codex task falls back to Claude. Both will happen once the owner signs in to codex or agy. These fixes come before any new scope.

Minor: `.ao2/tasks/0017…` and `0018…` are still tracked in git. They can be deleted once a restart has run `migrateMemDir()`.

## Next (queued)
1. AUDIT #17: a non-Claude auth_error marks only that agent unusable, and routing falls back to Claude.
2. AUDIT #18: rate limits are tracked per agent (`blocked_until:<agent>`), and `AGY_LIMIT_RE` is matched only against the error.
3. AUDIT #19: a stale codex/agy session gets `errorCode 'no_session'`, the dead session id is dropped, and the run retries once without resume, in both chat and orchestrator.
4. AUDIT #20: a route's agent is inferred from the model family, and model/agent mismatches are dropped.
5. AUDIT #21: CLI adapters kill the process group after a normal exit.

## Later
- SIGTERM handler: abort agents cleanly and mark runs interrupted, instead of a hard kill. This matters less now that restart-when-idle exists.
- A real end-to-end run on codex/agy. Owner action first: `codex login --device-auth`, then sign in to `agy`. Do this after #17/#18 are fixed.
- Delete the tracked `.ao2/` leftovers after the first restart.
- Split public/app.js (2.5k lines) into native ESM modules, once UI tests or a manual check can catch regressions.
- Mobile layout review on a real phone. Make task logs easier to read, e.g. by collapsing long tool results.
