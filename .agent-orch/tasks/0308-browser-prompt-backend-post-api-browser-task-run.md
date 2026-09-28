# Task #308: Browser prompt backend: POST /api/browser/task runs an agent on the live screen now

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 11:07  
- files: orchestrator.mjs, server.mjs, test/browser-task*.test.mjs

## Prompt

Backend for 'get work done on the browser screen by an AI agent'. Contract (the UI task codes against it; keep it exact): POST /api/browser/task {prompt, identity, node} → 201 {taskId}. GET /api/browser/tasks?identity=&node= → the recent and running browser tasks for that profile [{id, title, status, startedAt, finishedAt, resultText, steps:[{ts, kind:'nav'|'click'|'type'|'read'|'shot'|'approval'|'text', label, mediaId?}]}]. POST /api/browser/task/:id/stop. Live updates reuse the existing orun/task WebSocket messages (the task id is enough). Implementation (orchestrator.mjs, server.mjs): create a work task in the current project (or a 'Browser' project, created on demand) with capabilities ['browser'], the given identity, pinned to the node that owns the profile (the existing 'Run on' pinning), urgency urgent and moved to the front (Do next), a title derived from the prompt (first ~60 characters), and no git changes expected. Completion: browser tasks need no shell done_when; they're done when the agent finishes, with its final message as resultText (outcome 'done' unless the agent reports it couldn't finish), and they skip the git merge and worktree creation entirely. Steps are derived from the run's normalised tool events (Playwright MCP tool names → kinds, the element or URL as the label, screenshots → mediaId). Approvals from the gate appear as steps with kind 'approval'. If the live view currently has 'Take over' on, the new task waits until 'Hand back'. Validation: 400 for an empty prompt or an unknown identity/node, and a login-protected route. Tests with a stub agent: create → the task is queued at the front with the capability, identity and node; steps are mapped from fake events; stop cancels; no worktree is created. Run only the touched test files.

## Done when

`node --test test/browser-task*.test.mjs` passes (create/front-of-queue/pinning, step mapping, stop, no worktree)

## Result — done (check passed) (2026-09-28 11:17)

AGENT-ORCH-STATUS: done — Browser task API verified; pinned agents run without git lifecycle.
