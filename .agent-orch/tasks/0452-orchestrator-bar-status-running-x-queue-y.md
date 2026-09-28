# Task #452: Orchestrator bar status: 'Running X · Queue Y'

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 14:49  
- files: public/app.js, public/app.css, test/ui-orchbar-status*.test.mjs

## Prompt

In the orchestrator bar above the composer (#orchBar, status element in public/app.js; keep the minimal-bar rule in .agent-orch/CONTEXT.md: one short status plus the Queue/Settings/Pause buttons), show the status as 'Running X · Queue Y', where X = running work tasks across all machines and Y = queued tasks (not running, not done/cancelled; include waiting-on-prerequisite ones). Show 'Paused · Queue Y' when paused and 'Idle' when X = Y = 0. It updates live from the WebSocket state. Keep the Queue button's own count consistent with Y, or drop its separate badge to avoid showing the number twice (choose dropping it). Numbers use tabular figures. It fits at 390px. Test: seeded state with 3 running and 7 queued renders 'Running 3 · Queue 7'; paused renders 'Paused · Queue 7'; empty renders 'Idle'. Run only the touched test files.

## Done when

`node --test test/ui-orchbar-status*.test.mjs` passes (Running 3 · Queue 7, Paused · Queue 7, Idle)
