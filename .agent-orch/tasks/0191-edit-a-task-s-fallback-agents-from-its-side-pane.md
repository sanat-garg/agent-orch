# Task #191: Edit a task's fallback agents from its side panel

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 12:52  
- files: public/app.js, public/app.css, server.mjs, orchestrator.mjs, test/task-fallbacks*.test.mjs

## Prompt

In the task drawer (the side panel for a task, in public/app.js), add a 'Fallbacks' section for work tasks that aren't finished (queued, waiting on a limit or running). It shows the task's own fallback list (tasks.fallbacks snapshot) using the same stripped-down fallback editor as the composer (ordered list, add model, remove, drag or Alt+↑/↓ to reorder). Editing it saves only this task's list via a new PATCH /api/orch/tasks/:id/fallbacks {fallbacks} (validated against the discovered models; rejected with 409 for done/cancelled tasks). For a running task, the change applies from its next resume or limit event, and the panel says so. Show a small 'Custom' marker when the task's list differs from its chat's list, with 'Reset to chat's list'. The delegation status line (modelStatus) updates immediately. Tests: the PATCH endpoint (validation, 409 on done), and delegation using the edited list.

## Done when

`npm test` passes with task-fallback PATCH tests, and the task drawer renders a Fallbacks section for queued tasks

## Result — done (check passed) (2026-09-26 13:59)

AGENT-ORCH-STATUS: done — Task fallback editing verified; all 248 tests pass.
