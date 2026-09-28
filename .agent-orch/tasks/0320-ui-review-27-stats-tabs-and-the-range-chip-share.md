# Task #320: UI-REVIEW #27: Stats tabs and the range chip share one row on phones and the subtitle scrolls with the body

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:34  
- files: public/stats.js, public/stats.css, test/ui-stats.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

Fix UI-REVIEW.md row 27 (Stats header) in public/stats.js and public/stats.css only (the Stats sheet markup is built in stats.js: `#sxTabs`, `#sxRange`, `#sxSub`; do not touch app.css or index.html, other tasks hold them). On a phone the pinned header (grabber, title, subtitle, tabs row, range row) takes ~187pt of a 743pt sheet. Change, for `max-width: 600px` only: put `#sxTabs` and `#sxRange` on one row, with the range as a compact menu chip showing the current range ('All ▾') that opens the existing range buttons as a small popover/sheet-style list below it (a `<details>`/button + list is fine; 44pt touch target, 16px text on touch per CONTEXT.md); move `#sxSub` into the scrolling body so only the grabber, title and the tabs/range row stay pinned. Desktop keeps today's two rows and the subtitle position. Keep aria-pressed on the range buttons and the keyboard handling in stats.js (~line 938-950) working. Extend test/ui-stats.test.mjs's 375×667 test: the pinned header (the sticky element above the scrolling body) is under 120px tall, `#sxTabs` and the range chip have the same offsetTop, and picking a range from the chip changes `SX.range`/the rendered data; the desktop test still passes. Mark row 27 fixed in place in .agent-orch/UI-REVIEW.md.

## Done when

`node --test test/ui-stats.test.mjs` passes and `grep -n 'sx-range-chip\|sxRangeChip' public/stats.js` prints a line
