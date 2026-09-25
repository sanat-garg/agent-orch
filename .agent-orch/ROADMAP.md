# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-25 (reflect #70)._ `npm test` passes 105/105. All 21 AUDIT items are fixed, and the Definition of Done is met. Multi-agent routing is hardened, and web sign-in (Connections panel, #67–#69) has shipped.

**Owner action:** the live service has been running since 03:23 UTC, so nothing from #32 onward is live yet. That includes the Connections panel, the restart banner and the AUDIT #17–#21 fixes. Restart it once by hand while no task is running: `sudo systemctl restart agent-orch`. After that, use the banner. Then sign in to Codex/agy from the sidebar's Connections panel so routing rules can actually use them (codex is currently "Not logged in").

The newest code (#55–#69) has not been audited: tmux sign-in scraping, restart-when-idle/drain, and timezone notices. The last audit found five real bugs in similar fresh code, so another audit is the most valuable next step.

## Next (queued)
1. Audit round 3: connections.mjs sign-in flows, drain/restart-when-idle, update banner, limit notices. Findings go into AUDIT.md as #22+.
2. Remove the tracked `.ao2/` leftovers from git.

## Later
- Fix the round 3 audit findings (queued by the next reflection).
- A real end-to-end codex/agy task run, once the owner has signed in.
- SIGTERM handler that marks runs interrupted. Low value: orphans are already requeued on start.
- Split public/app.js (~2.7k lines) into native ESM modules, once there is a UI smoke check.
- Mobile layout review on a real phone.
