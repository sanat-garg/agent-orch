# Task #59: Non-Claude auth failure blocks only that agent, not the whole orchestrator (AUDIT #17)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 04:24

## Prompt

Fix AUDIT #17 in .agent-orch/AUDIT.md (read it first). In orchestrator.mjs `handle` (around the `if (res.outcome === 'auth_error')` branch near line 1451), every auth_error sets the global kv `blocked_until` to now()+600 and says Claude is not signed in. Change it so that when the run's agent is not 'claude', the global block is left alone. Instead, mark that agent as unusable for a while, e.g. kv `agent_auth_failed:<agent>` = now()+600 (or a helper exported from agents.mjs that forces loginCache false for that agent). Make `resolveRoute`'s availability check treat that agent as logged out, so the next attempt falls back to Claude with a route_note like '<Agent> sign-in failed'. Requeue the task, and log '<agent label> is not signed in' rather than the Claude message. Claude auth failures keep the current behaviour. Add a test (test/routing.test.mjs, or a new file that follows the child-process pattern in test/scheduling.test.mjs, using the stub binaries in test/fixtures/) showing that after a codex auth_error, `blocked_until` stays 0 and the retried task runs on Claude. Mark AUDIT #17 `**Fixed** (task #N)` with a one-line note, and update the Routing bullet in .agent-orch/CONTEXT.md. Never touch the live server on port 3000.

## Done when

`npm test` passes and `grep -n 'Fixed' .agent-orch/AUDIT.md` shows a Fixed line under item 17

## Result — done (check passed) (2026-09-25 08:47)

AGENT-ORCH-STATUS: done — non-Claude auth failures now fall back to Claude; tests pass
