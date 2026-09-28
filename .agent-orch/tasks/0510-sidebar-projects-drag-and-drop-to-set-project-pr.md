# Task #510: Sidebar projects: drag and drop to set project priority

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 19:08  
- files: public/app.js, public/app.css, orchestrator.mjs, server.mjs, test/project-order*.test.mjs

## Prompt

Make project priority settable by dragging projects in the sidebar project list (public/app.js, app.css, plus orchestrator.mjs/server.mjs if the backend is missing). History: #203 (the original drag-to-prioritise task) was cancelled, and #275 later fixed 'the duplicate dragMove in app.js (sidebar project drag is dead)', so some drag code may exist. First inspect what's there (projects.position column? a reorder endpoint? dragMove handlers?) and complete or repair it rather than duplicating it. Required: 1) pointer-events drag (mouse, with a long-press on touch; no HTML5 DnD) of a project row with a lifted row, a drop indicator line, and auto-scroll in a long list; plus Alt+↑/↓ on a focused row. 2) Persist with POST /api/orch/projects/reorder {ids:[...]} (create it if missing): set projects.position and derive projects.priority from the order (evenly spaced from 90 at the top to 10 at the bottom), broadcast over the WebSocket, and have the scheduler's cross-project ranking follow it. 3) A subtle 'Priority order' hint on the list header ('Drag to set priority'). Remove any obsolete priority select that conflicts, or keep it in sync. 4) Tests: dragging project C above A posts the new order; the endpoint sets positions and priorities; the scheduler picks the top project's ready task first; keyboard reorder works. Run only the touched test files.

## Done when

`node --test test/project-order*.test.mjs` passes (drag posts order, endpoint sets priority from position, scheduler honours it, keyboard reorder)

## Result — done (check passed) (2026-09-28 19:12)

AGENT-ORCH-STATUS: done — project drag/keyboard priority order tested; header hint added
