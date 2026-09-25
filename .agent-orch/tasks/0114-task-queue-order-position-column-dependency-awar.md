# Task #114: Task queue order: position column, dependency-aware reorder API

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 14:02

## Prompt

Backend for manual queue reordering in orchestrator.mjs plus server.mjs. 1) Add tasks.position REAL (migrate: initialise from the current effective order). Scheduler: among runnable tasks of the same project, the manual position is the primary order and urgency/priority breaks ties. Deadline-driven urgent promotion and plan/user kinds still go first; document this in a comment. 2) POST /api/orch/tasks/:id/move {before: taskId|null, after: taskId|null} moves a QUEUED task and its whole dependent subtree (every queued task whose depends_on chain leads to it) as a block, keeping their relative order. Reject (409 with a clear message) a move that would place a task before any of its prerequisites (the depends_on chain upward) or place a subtree member before its root. Running, done and cancelled tasks can't move. The move is atomic in one transaction. Broadcast the new order over the WebSocket. 3) The task list API returns position, depends_on and a computed `prereqs` (ids that must finish first) and `dependents` for the UI. Tests: moving a task moves its dependents; a move above a prerequisite is rejected; the scheduler respects the new order.

## Done when

`npm test` passes with reorder tests for moving a subtree, rejecting a move above a prerequisite, and scheduler order
