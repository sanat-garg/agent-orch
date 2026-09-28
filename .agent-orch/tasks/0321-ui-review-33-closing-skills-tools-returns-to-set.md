# Task #321: UI-REVIEW #33: closing Skills & tools returns to Settings when it was opened from there

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:34  
- files: public/ext.js, public/ext.css, test/ui-ext.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

Fix UI-REVIEW.md row 33 in public/ext.js only (do not touch app.js or index.html; other tasks hold them). Settings → 'Skills & tools ›' (`[data-ext-open]` rows, ext.js line ~121) calls `closeSettings(); exOpen(kind)`, so closing `#extModal` drops the owner back in the chat instead of Settings, and there is no back button. Change: remember `EX.fromSettings = true` when opened from a `[data-ext-open]` row (false when opened any other way), and on close of `#extModal` (find the close path in ext.js: the × button, backdrop, Escape and the sheet's dismiss) reopen Settings by calling the existing global settings opener from app.js (find its name: the function the gear button calls) when `fromSettings` was set; also add a '‹ Settings' back button at the left of the ext sheet header, shown only when `fromSettings`, styled like the editor's existing '‹ MCP servers' back control (public/ext.css if a class is needed). Extend test/ui-ext.test.mjs (playwright-core; copy its setup): open Settings, tap a Skills & tools row, close the sheet, and assert the Settings sheet is visible again; opened from elsewhere (call `exOpen('skills')` directly) closing does not show Settings. Mark row 33 fixed in place in .agent-orch/UI-REVIEW.md.

## Done when

`node --test test/ui-ext.test.mjs` passes and `grep -n 'fromSettings' public/ext.js` prints a line
