# Task #143: Show the execution forecast in the composer and on queued tasks

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 23:22  
- starts after: #141

## Prompt

Display the forecast from delegate.mjs forecast() (the `forecast` field on /api/delegate/preview and on queued tasks). 1) Composer: when Auto Delegate is on, the compact summary next to the model selector shows forecast.summary (e.g. 'Astra at 4:45 → Opus at 5:00'), formatted client-side in the browser's timezone, with a small clock icon when startsAt is in the future. The fallback editor popup shows the full segment timeline as a small vertical list. 2) Queued task cards (wherever taskCard renders) show the summary as the subtitle when the task is waiting on limits, and the drawer shows the full timeline. 3) Keep it live: re-render on the WebSocket state/limit updates, and tick relative times every 30 s. No layout overflow at 390px. Screenshots via bin/shot.mjs with seeded limits.

## Done when

`node --check public/app.js && npm test` passes, and app.js renders forecast.summary in both the composer summary and taskCard
