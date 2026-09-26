# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-26 10:30 (reflect #169)._ The previous round landed cleanly: the first live parallel run (#165–#168 ran
file-disjoint), a live parallel e2e proved concurrent tasks overlap and both merge, README covers the new agents,
fallbacks and worktrees, and the suite dropped from ~278 s to ~198 s. AUDIT round 4 found six real bugs (#27–#32) in
the newest, riskiest code. The worst (#27) can delete a worktree's uncommitted work and run a task in the live main
tree; #28/#29 can leave a task stuck in `needs_integration` forever; #32 is a hole in the "never API credits" rule.
None are fixed yet, so fixing them is the clear next push: it hardens what exists and adds no new scope.

BRIEF.md's "Immediate goals" and Definition of Done still name the retired #132/#133 Auto Delegate work; the planner
should refresh them next time it talks with the owner.

## Next (queued; worktree fixes are serial, the rest run in parallel)
1. AUDIT #27: detached-HEAD worktrees are recognised and re-attached, never deleted (worktrees.mjs).
2. AUDIT #29: `unresolvedFiles` stops flagging setext `=======` headings (worktrees.mjs).
3. AUDIT #28: a failed/cancelled integrator propagates to its owner and the owner's dependents (orchestrator.mjs).
4. AUDIT #31: plain dotted directory names (`.agent-orch`, `.github`) cover their contents (parallel.mjs).
5. AUDIT #32: OpenCode's subscription guard checks global config and `OPENCODE_CONFIG_CONTENT` (agents.mjs).

Tasks deliberately don't edit AUDIT.md (it would serialise them all); the next reflection marks #27–#32 **Fixed**
from the commits.

## Later
- AUDIT #30 (low): `reviveBlocked` with two failed prerequisites retried in the "wrong" order.
- Mark round-4 findings fixed in AUDIT.md after the fixes land.
- Kiro live smoke once the owner signs in; Copilot model list beyond `auto`.
- Split public/app.js (~4.5k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- SIGTERM handler that marks runs interrupted (low value; orphans are requeued on start).
