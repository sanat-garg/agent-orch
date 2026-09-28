# Task #290: One-time kv migration dropping rows for the removed agents antigravity, opencode, kiro and copilot

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 08:13  
- files: orchestrator.mjs, test/kv-migrate.test.mjs

## Prompt

The orchestrator kv table still holds rows for agents removed in goal 10 of BRIEF.md: `planner_session:2:antigravity`, `unknown_limit_streak:antigravity`, `unknown_limit_streak:antigravity:3p`, `unknown_limit_streak:copilot`. Add a one-time migration in orchestrator.mjs next to the existing `parallel_cap_migrated` pattern (grep for it): guarded by kv `removed_agents_kv_migrated`, it deletes every kv row whose key ends with `:<agent>` or contains `:<agent>:` for agent in antigravity, opencode, kiro, copilot, then sets the guard. Keep it to a few lines in the file's terse style. Add a test in test/parallel.test.mjs or a small new test/kv-migrate.test.mjs (copy a neighbouring `createOrchestrator` setup): seed such rows plus a `planner_session:2:claude` row into a fresh DB before boot, boot, and assert the removed-agent rows are gone while the claude row and the guard remain. Do not restart the live server on port 3000; the migration runs live on the owner's next restart.

## Done when

`grep -q 'removed_agents_kv_migrated' orchestrator.mjs` and `npm test -- test/kv-migrate.test.mjs`

## Result — done (check passed) (2026-09-28 08:41)

AGENT-ORCH-STATUS: done — boot migration drops removed-agent kv rows; test passes
