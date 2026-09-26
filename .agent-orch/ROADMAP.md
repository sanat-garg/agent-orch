# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-26 09:55 (reflect #164)._ `npm test` passes (229 tests), but the suite now takes about 4.6 minutes, and
every task pays that cost several times. The live service (started 07:11) runs worktree + parallel-planning code,
yet every task since #156 was created before that code existed (`files` NULL), so **no two tasks have ever run in
parallel on the live app**. The last bug audit (round 3) predates a lot of new, riskier code: worktrees that
merge into the live checkout, parallel scheduling, delegation/fallbacks, and three new CLI adapters. README doesn't
mention OpenCode, Kiro, Copilot, worktrees or parallel work. CONTEXT.md was cut from 18 KB to ~8 KB this round.

BRIEF.md's "Immediate goals" and Definition of Done still name the retired #132/#133 Auto Delegate work; the planner
should refresh them next time it talks with the owner.

## Next (queued, file-disjoint so they run in parallel: the first live parallel run)
1. AUDIT round 4: worktrees/merge, parallel scheduling, delegation, new adapters (findings only).
2. Parallel e2e: `bin/orch-e2e.mjs --parallel` proves two file-disjoint tasks overlap and both merge.
3. README: new agents, fallbacks, worktrees and parallel tasks.
4. Test suite speed: cut fixed waits in the slowest test files.

## Later
- Fix the round-4 AUDIT findings (queue after #1 reports).
- Kiro live smoke once the owner signs in; Copilot model list beyond `auto`.
- Split public/app.js (~4.5k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- SIGTERM handler that marks runs interrupted (low value; orphans are requeued on start).
