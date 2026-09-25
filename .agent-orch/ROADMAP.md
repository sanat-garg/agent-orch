# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-25 (reflect #53)._ `npm test` passes 74/74. The Definition of Done is met: README, a real test suite, and all 16 AUDIT items Fixed. The pacing governor and the scheduler now have unit tests (#50, #51). Route fallbacks show their reason on the task badge (#52).

**The biggest gap is operational.** The live service started at 03:23 UTC, so almost none of the fixes from #32–#52 are running yet. There is no safe way to pick them up. Restarting kills running agents mid-task (they get requeued with RESUME), and the process has no SIGTERM handling. The orchestrator keeps committing to its own repo, so this happens again after every push. A "restart when idle" flow closes this gap, and it is how the owner will pick up every future change.

**Second risk: the multi-agent code (#26–#34, #52) is new and was never audited.** That covers agents.mjs, resolveRoute, agentChatTurn and the login detection. Codex is still "Not logged in", so today only the Claude fallback path runs in production.

Minor: `.ao2/tasks/0017…` and `0018…` are still tracked in git. They are expected until a restart runs `migrateMemDir()`, and can be deleted after that.

## Next (queued)
1. Audit round 2 of the multi-agent and routing code. Record findings as AUDIT #17+ (no fixes in this task).
2. Orchestrator `drain()`: stop claiming new tasks, then resolve once running tasks finish. Test it.
3. Server: `restartPending` (HEAD differs from the boot commit) in state, plus `POST /api/restart-when-idle`, which drains and then exits so systemd restarts the app. Test it on a test port.
4. UI: a banner saying "N new commits since start", with a "Restart when idle" button.
5. (next reflection) Fix the AUDIT #17+ items one per task.

## Later
- SIGTERM handler: abort agents cleanly and mark runs interrupted, instead of a hard kill.
- A real end-to-end run on codex/agy. Owner action first: `codex login --device-auth`, then `agy` sign-in.
- Split public/app.js (2.5k lines) into native ESM modules, once UI tests or a manual check can catch regressions.
- Mobile layout review on a real phone. Task log readability, e.g. collapsing long tool results.
