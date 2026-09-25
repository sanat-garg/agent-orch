# Task #57: UI: 'updates since start' banner with a Restart when idle button

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 04:13  
- starts after: #56

## Prompt

Read .agent-orch/CONTEXT.md first. The server now exposes `restartPending`, `commitsSinceBoot` and the orchestrator's `draining` in state, plus `POST /api/restart-when-idle`. In public/app.js, public/index.html and public/app.css, show a small, dismissible banner in the orchestrator/status area when restartPending is true: 'N new commits since the server started'. It has a 'Restart when idle' button that POSTs to the endpoint and then reads 'Restarting after running tasks finish…' while `draining` is true. The existing WebSocket reconnect logic should handle the restart. Match the existing vanilla JS style and CSS variables, and make sure it works on the mobile layout. Add a small server test that GET / (or the served app.js) contains the endpoint path 'restart-when-idle'. Never click or call the endpoint against the live server on port 3000.

## Done when

`grep -q restart-when-idle public/app.js && npm test`

## Result — done (check passed) (2026-09-25 04:22)

AGENT-ORCH-STATUS: done — Update banner with Restart-when-idle button added; tests pass
