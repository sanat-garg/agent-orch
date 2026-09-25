# Task #102: Edit or retract saved chat messages before the orchestrator reads them

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22  
- starts after: #101

## Prompt

When the planner is busy or rate-limited, chat messages are saved (deferMessage in orchestrator.mjs, the 'messages' table) and answered later. Let the owner edit or retract them until a plan task picks them up. 1) Backend: a stable id for each deferred message, sent to the chat with the 'Saved…' notice; PATCH /api/orch/messages/:id {text} and DELETE /api/orch/messages/:id, allowed only while the message is still pending (not yet consumed by a plan task; make the consume step atomic so there's no race). When all pending messages are retracted, cancel the queued 'Answer owner's message' plan task. 2) UI: a pending user bubble shows a small 'Pending · Edit · Undo' affordance. Edit turns the bubble into an inline editor (Save/Cancel, Enter to save, Esc to cancel), and Undo removes the bubble and puts its text back into the composer. Once consumed, the bubble shows 'Read by planner' and the actions disappear. This must work on touch (no hover-only controls). Tests: edit and delete while pending succeed, and after consumption they return 409.

## Done when

`npm test` passes with pending-message edit/delete tests including the 409-after-consume case
