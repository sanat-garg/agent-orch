# Task #275: Fix the duplicate dragMove in app.js (sidebar project drag is dead) and guard top-level names

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 05:45  
- files: public/app.js, test/ui-static.test.mjs

## Prompt

Bug: public/app.js declares `function dragMove` twice at top level: the sidebar project-list drag (near line 600, `function dragMove(y)`, called from liftCard and the pointermove handler around lines 571-619) and the Queue sheet's card drag (near line 6518, `function dragMove()`, using Q.drag, called around lines 6502-6550). public/*.js are loaded as classic scripts, so the later declaration wins and the sidebar's calls hit the Queue version, which returns immediately because Q.drag is unset: lifting a project card never moves it (Alt+Up/Down still works). Fix: rename the Queue one to `qDragMove` (matching its neighbours qShift/endDrag) and update all its call sites; leave the sidebar one alone. Then add a test to test/ui-static.test.mjs: read public/app.js, files.js, stats.js, ext.js and browser.js, collect every top-level `function NAME(` / `async function NAME(` (lines starting at column 0), and assert the names are unique across all five files, listing duplicates in the assertion message. Also assert that the sidebar drag still calls `dragMove(` with an argument and the queue calls `qDragMove(`. Run `npm test -- test/ui-static.test.mjs` and `npm test -- test/reorder.test.mjs`.

## Done when

`npm test -- test/ui-static.test.mjs` passes and `grep -c '^function dragMove' public/app.js` prints 1 and `grep -q 'qDragMove' public/app.js`
