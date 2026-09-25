# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-25 (reflect #49)._ `npm test` passes 55/55. All 16 AUDIT items are Fixed. The README covers setup, security and multi-agent. The Definition of Done for this push is met.
Goals 1, 2, 4 and 5 are done. "claude-web" and "ao2" now appear only in migration code (DB, memory dir, tasks-block aliases, rename script), and that is deliberate.
Codex is installed but `codex login status` says "Not logged in". Antigravity's data dir exists. So Claude fallback is what actually runs today.

Biggest remaining risk: the pacing governor (`decide()` in orchestrator.mjs ~606) and task scheduling (`runnable`/`claimNext`, `cascadeBlock`/`reviveBlocked`, `blocked_until`) are the core of "use the limits around the clock". Neither has any tests. A regression there silently wastes or overspends capacity. Hardening them is worth more than new features.

## Next (queued)
1. Export `decide()` and unit-test its tiers: weekly thresholds, the urgent-only rule, the 5h push-harder and one-slot rules, and stale or too-old readings.
2. Scheduling tests: urgency and priority ordering, `depends_on` gating, one running task per project, a failed parent cascading to its children and reviving them, and `blocked_until` pausing claims.
3. UX: when a route falls back to Claude, record the reason on the task and show it on the task's agent badge.

## Later
- A real end-to-end run on codex/agy. Owner action first: `codex login --device-auth`, then `agy` sign-in.
- Split public/app.js (2.5k lines) into native ESM modules, once UI tests or a manual check can catch regressions.
- Mobile layout review on a real phone. Task log readability, e.g. collapsing long tool results.
