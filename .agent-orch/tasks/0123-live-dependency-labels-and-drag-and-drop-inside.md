# Task #123: Live dependency labels and drag-and-drop inside the Queue dock

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 18:21  
- starts after: #115

## Prompt

Integrate the queue reordering (POST /api/orch/tasks/:id/move and the drag-and-drop from task #115) with the single Queue dock (#queueDock, from the 'Single Queue dock' task; if the dock doesn't exist yet, stop and report that). 1) Drag-and-drop works ONLY in the dock. Remove any drag handling from other card lists (chat receipts, drawer links). The dragged card carries its dependent subtree, and invalid slots above prerequisites are disabled, as #115 specified. 2) Live dependency labels: whenever the order changes (move broadcast), a task starts or finishes, or a task is cancelled/retried, update without a reload: the card subtitle ('waiting for #N', 'after #N', 'next up', 'running'), the task drawer's 'Starts after' and 'Then' sections (orchestrator.mjs sends dependsOn/followers, and public/app.js ~lines 2801-2804 renders them), and the order numbers in the dock. The server must broadcast a single 'order' message with the new ordered ids plus depends_on per task after every move/claim/finish, and the client re-renders from it (no per-card refetch storms). 3) Dock cards animate to their new positions with FLIP. Tests: a server test that a move emits the order broadcast with the updated sequence.

## Done when

`npm test` passes with an order-broadcast test, and app.js wires the pointer-drag handlers only to cards inside #queueDock
