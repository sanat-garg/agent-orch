# Task #444: Assign API: list a machine's runnable tasks and start one on it immediately

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 14:40  
- files: orchestrator.mjs, server.mjs, test/assign*.test.mjs

## Prompt

Backend for manual assignment from a machine card. Contract (the UI task codes against it; keep it exact): GET /api/cluster/nodes/:id/assignable → {tasks:[{id, title, urgency, agent, model, files, waitingSince}]}: queued work tasks with NO unfinished prerequisites (every task_deps/depends_on done), not held by a review checkpoint/approval/Take-over, and eligible for that node (its agents signed in per inventory; plan/reflect/review/chat are head-only; integrators allowed wherever #435's rules allow; browser tasks only on the node owning their profile), ordered like the scheduler. POST /api/orch/tasks/:id/assign {node} → 200 {started:true, taskId, node}, or 409 {error} with a plain reason ('#N waits for #M', 'Codex isn't signed in on this Mac', 'already running', 'node offline'). Implementation (orchestrator.mjs, server.mjs; login-protected): set tasks.run_on = node (the existing pin that `place` honours) and start it NOW on that node, bypassing queue order AND the node's slot target (an explicit owner override; log 'assigned by owner to <node>'). Don't bypass real blockers (prerequisites, an offline node, a signed-out agent). Rapid-overlap rules don't block it. If the node's CPU is saturated, start anyway but include {warning:'CPU busy'} in the response. The assignment appears in the task's event history and the Machines view immediately (via the WebSocket). Tests: assignable excludes tasks with an unfinished prerequisite, other-node browser tasks and head-only kinds on a worker; assign starts a task on a node already at its target; a task whose prerequisite is unfinished gets 409 with the reason; an offline node gets 409. Run only the touched test files.

## Done when

`node --test test/assign*.test.mjs` passes (assignable filtering, immediate start over the target, 409 reasons for prerequisite/offline)

## Result — done (check passed) (2026-09-28 14:57)

AGENT-ORCH-STATUS: done — assign API lists runnable tasks and starts them immediately
