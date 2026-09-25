# Task #39: Deleting a chat mid-plan stops queued planner turns (AUDIT #6)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:50  
- starts after: #38

## Prompt

Fix AUDIT #6 in /home/ubuntu/agent-orch/server.mjs. The chat DELETE handler (around line 1126, it calls `orch.abortPlan(c.id)` and `orch.detachConvo(c.id)`) does not clear `planQueue`. When the aborted turn returns, the loop in `orchestratorTurn` (around line 623) picks up the queued text and calls `orch.planTurn` again for the deleted convo, which reactivates the paused project. Fix: add `planQueue.delete(c.id)` in the DELETE handler, and in `orchestratorTurn`'s for-loop stop (`break`) when `!findConvo(convo.id)` (use whatever convo lookup helper server.mjs already has). Also skip saving or broadcasting for a deleted convo in the finally block if that would recreate it. Keep the change minimal. Mark AUDIT #6 `**Fixed**` in .agent-orch/AUDIT.md with a one-line note. Run `npm test`. Never restart the live server.

## Done when

`grep -q 'planQueue.delete(c.id)' server.mjs` and `npm test` passes

## Result — done (check passed) (2026-09-25 03:52)

AGENT-ORCH-STATUS: done — Deleting a chat mid-plan now drops its queued planner turns
