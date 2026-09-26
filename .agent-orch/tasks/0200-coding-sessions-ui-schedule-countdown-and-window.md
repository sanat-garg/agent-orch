# Task #200: Coding sessions UI: schedule, countdown and window alignment view

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 14:32  
- starts after: #199  
- files: public/app.js, public/app.css, public/index.html, test/ui-sessions*.test.mjs

## Prompt

UI for the coding sessions backend (sessions.mjs, /api/sessions). 1) A 'Schedule coding session' entry in the sidebar (and in the orchestrator settings) opens a sheet that asks: start time (a time picker defaulting to the next full hour, plus quick choices like 'Tonight 9 PM' and 'Tomorrow 9 AM'), duration (default 4 h), and which agents/accounts to prepare (checkboxes; signed-in agents with 5 h windows are pre-checked). Before confirming, show the plan: 'Windows start at 3:00 PM (priming). Your session 6:00-10:00 PM: Claude 6-8 PM old window, 8 PM fresh window', etc., as a small timeline bar per agent. 2) After scheduling, a compact card in the sidebar shows the countdown, priming status per agent (pending / primed ✓ with its reset time / couldn't align, with the reason), and Edit and Cancel. During the session, a subtle banner shows 'Coding session · 2h 14m left · Claude window refreshes at 8:00 PM', and autonomous work shows as held for those agents. 3) Times are in the browser's timezone. It must work well on iPhone. Screenshots via bin/shot.mjs.

## Done when

`node --check public/app.js && npm test` passes, and the sidebar renders a 'Schedule coding session' entry that posts to /api/sessions
