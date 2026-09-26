# Task #201: Review checkpoints in the queue: wait for owner approval after a task

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 14:32  
- files: orchestrator.mjs, server.mjs, public/app.js, public/app.css, test/checkpoint*.test.mjs

## Prompt

Add review breaks so important work doesn't drift in the wrong direction. 1) Backend: a task kind 'review' (a checkpoint) that never runs an agent. It becomes 'awaiting review' when its prerequisite finishes, and blocks everything after it until the owner approves. Approve continues the queue. 'Request changes' {note} queues a follow-up fix task (with the note and the reviewed task's diff context) before the checkpoint's dependents, and re-arms the checkpoint after it. Endpoints: POST /api/orch/tasks/:id/checkpoint (insert a checkpoint after task :id; dependents re-link to follow it), POST /api/orch/tasks/:id/approve, POST /api/orch/tasks/:id/request-changes. 2) The tasks JSON block accepts {"kind":"review","title":…, "after": i}, and the planner prompt tells the planner to add a checkpoint after important/risky or direction-setting tasks (a new architecture, a UI redesign, data migrations). 3) UI: in the Queue modal and on task cards, a '+ Review break' action on any queued or running task inserts a checkpoint after it. Checkpoint cards look distinct (a flag icon, 'Wait for your review'). When it's awaiting review, it shows the reviewed task's summary, its changed-files list and screenshots, with 'Approve & continue' and 'Request changes' buttons, and a chat notice plus the completion sound. 4) The drag-and-drop reorder moves checkpoints with their dependents. Tests: dependents wait while it's awaiting review; approve releases them; request-changes inserts a fix task and re-arms the checkpoint.

## Done when

`npm test` passes with checkpoint tests (blocking, approve, request-changes), and task cards offer a '+ Review break' action
