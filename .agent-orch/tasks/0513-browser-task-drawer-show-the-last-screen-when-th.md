# Task #513: Browser task drawer: show the last screen when the session ends

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 19:17  
- files: public/app.js, public/app.css, test/ui-final-screen*.test.mjs

## Prompt

In the task drawer (the side panel; public/app.js, the 'What happened' media and screenshot rendering from #89/#475), a browser task (capabilities ['browser'], incl. Claude in Chrome runs from #496/#512 whose screenshots come from the extension's `computer screenshot` results, and Playwright runs) currently shows its FIRST screenshot prominently. Change the ordering: 1) When the task has finished (done, failed or cancelled), show its LAST screenshot first as a larger 'Final screen' image (fit-to-width in the drawer, click opens the lightbox in fit mode), then the earlier screenshots as thumbnails in reverse chronological order (newest first). Screenshots are ordered by their event timestamp (or seq), not by media id or insertion order. 2) While it's running, show the most recent screenshot as the 'Current screen', updating live as new ones arrive. 3) The chat receipts and Browser tab thumbnail use the same last-screen rule. 4) Tests: a finished browser task with 3 screenshots renders the last one as the Final screen and the others newest first; a running task updates the Current screen on a new screenshot event; the ordering uses timestamps even if ids are out of order. Run only the touched test files.

## Done when

`node --test test/ui-final-screen*.test.mjs` passes (last screenshot as Final screen, newest-first thumbnails, live Current screen, timestamp ordering)

## Result — done (check passed) (2026-09-28 19:21)

AGENT-ORCH-STATUS: done — browser task screens now show latest first, ordered by time
