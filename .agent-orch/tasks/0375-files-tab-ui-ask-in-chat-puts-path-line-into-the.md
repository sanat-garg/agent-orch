# Task #375: Files tab ui: Ask in chat puts path:line into the composer from Quick Look and a Contents hit

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:54  
- files: public/files.js, public/files.css, test/ui-files.test.mjs

## Prompt

Feature in public/files.js and public/files.css only (app.js is held by other work; use only what files.js already uses from it: $, el, api, store, toast, currentConvo). Give the owner a way from a file to a question about it: (1) in Quick Look's header add an 'Ask in chat' button (44px on touch) that inserts the file's project-relative path (plus `:line` when Quick Look was opened from a Contents hit) into the composer `#input` at the caret (or appends with a space), fires an 'input' event so the composer resizes, closes Quick Look and the Files view (call the same close path the Files view's Back/Escape uses; find how app.js switches views by reading files.js's own open/close code, never edit app.js), focuses the composer and toasts nothing; (2) on each Contents result row add a small trailing 'Ask' icon button (and a context/long-press item is not needed) that does the same with `path:line`; (3) in the Names results and the folder listing, a selected row's Enter-key alternative Shift+Enter does the same for the path. Add a `fxAskAbout(rel, line)` helper with the shared logic. Style in files.css consistent with the existing fx toolbar buttons. Add a test to test/ui-files.test.mjs (create it copying test/ui-ext.test.mjs's server setup if the earlier Changed-view task has not created it yet; if it exists, add a test case): open a file in Quick Look, click 'Ask in chat', and assert `#input` value contains the relative path and the Files view is hidden. Keep `npm test -- test/ui-static.test.mjs` green (no duplicate function names across public/*.js). Run only those two test files while working.

## Done when

`npm test -- test/ui-files.test.mjs test/ui-static.test.mjs` passes and `grep -q 'fxAskAbout' public/files.js`

## Result — done (check passed) (2026-09-28 13:03)

AGENT-ORCH-STATUS: done — Ask in chat inserts path[:line] from Files, tested
