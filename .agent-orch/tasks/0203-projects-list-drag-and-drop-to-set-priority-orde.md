# Task #203: Projects list: drag and drop to set priority order

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 14:32  
- files: public/app.js, public/app.css, orchestrator.mjs, server.mjs, test/project-order*.test.mjs

## Prompt

In the sidebar projects list (public/app.js), let the owner drag projects to reorder them, with the top being the highest priority. Use pointer events (long-press on touch, no HTML5 DnD) with a lifted card and a drop indicator, plus Alt+↑/↓ keyboard reordering. Persist it: add projects.position (with migration), and have POST /api/orch/projects/reorder {ids:[…]} set positions and derive projects.priority from the order (e.g. evenly spaced 90 → 10), so the scheduler's cross-project ranking follows the list. Keep the existing priority select in settings in sync, or replace it with a hint 'Drag projects in the sidebar to set priority'. Broadcast the new order over the WebSocket. Tests: the reorder endpoint sets positions and priorities, and the scheduler prefers the top project's ready task.

## Done when

`npm test` passes with project reorder tests, and the sidebar project rows are draggable via pointer events
