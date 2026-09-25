# Task #115: Drag-and-drop task cards in the queue, moving dependents with them

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 14:02  
- starts after: #114

## Prompt

UI for reordering the task queue (public/app.js, app.css) using the POST /api/orch/tasks/:id/move API from the previous task. Queued task cards become draggable via Pointer Events (works with mouse AND touch; on touch, use a long-press of ~350 ms to pick up, so scrolling still works; no HTML5 DnD, which fails on iOS). While dragging: the card and its dependent subtree lift together (a stacked preview with a '+N dependents' label), the other cards animate apart to show the drop slot, invalid slots (above a prerequisite) are visibly disabled, and a hint says 'Needs #12 first' when hovering one. The list auto-scrolls near the edges. On drop, optimistically reorder, call the API, and on 409 animate back and toast the reason. Running and done cards aren't draggable. Show a small 'after #N' link on cards that have a prerequisite, so dependencies are visible. Keyboard alternative: Alt+↑/↓ on a focused card. Respect prefers-reduced-motion. Test on a separate port with CW_DATA_DIR=$(mktemp -d) and CW_NO_ORCHESTRATOR=1.

## Done when

`node --check public/app.js && npm test` passes, and app.js uses pointer events plus a long-press to drag queued task cards and calls /api/orch/tasks/:id/move
