# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-26 10:45 (reflect #175)._ Five of the six AUDIT round-4 bugs (#27, #28, #29, #31, #32) were fixed in parallel
by #170–#174. They merged cleanly, and the full suite passes: 237 tests in ~207 s. They're now marked **Fixed** in
AUDIT.md. The worktree and integrator paths, the riskiest new code, now keep work when HEAD is detached. They no longer
leave owners stuck in `needs_integration`, and they no longer misread Markdown headings as conflicts. These
server/orchestrator changes take effect only after the owner uses "Restart when idle".

BRIEF.md's stale #132/#133/#134 goals and DoD lines were replaced with a note that those pushes are finished. What's
left is hardening, not new scope. AUDIT #30 (low) is the last open finding. The HTTP/WS surface has grown a lot since
round 1 (connections, media, terminals, fallbacks, reorder, folders, restart-when-idle) and has never been audited as
a whole. The mobile PWA (goal 6) hasn't had a whole-app HIG review since the toasts, fallbacks and delegation-status
UI landed.

## Next (queued; all three run in parallel on disjoint files)
1. Fix AUDIT #30: `reviveBlocked` revives a dependent whose other failed prerequisite was retried first.
2. AUDIT round 5: security and robustness of every HTTP/WS endpoint in server.mjs (findings only, into AUDIT.md).
3. Mobile HIG review: screenshots of the main screens at 390×844 and a prioritised findings list in
   `.agent-orch/UI-REVIEW.md` (findings only; fixes are queued from it next round).

## Later
- Queue fixes for the round-5 AUDIT findings and the top UI-REVIEW items; mark #30 **Fixed** in AUDIT.md.
- Kiro live smoke once the owner signs in. Copilot's model list stays `auto` until the SDK or CLI exposes more (see AGENTS.md §6).
- Split public/app.js (~4.5k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- SIGTERM handler that marks runs interrupted (low value; orphans are requeued on start).
