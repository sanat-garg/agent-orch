# Task #272: UI-REVIEW #10: Connections opens as a bottom sheet on phones, no focus ring on touch, status lines wrap

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 05:17  
- files: public/index.html, public/app.css, public/app.js, test/ui-connections-sheet.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

Fix row 10 of .agent-orch/UI-REVIEW.md. In public/index.html `#connsModal` is a plain `.modal` that opens full screen on phones with no grabber, unlike `#awayModal` and `#queueModal` which carry `class="modal sheet"`. Give `#connsModal` the same `sheet` presentation (grabber, large title, close button, dimmed backdrop, scrolling body with bottom safe-area padding) by reusing the existing sheet classes in public/app.css; on desktop it should keep its current look. In public/app.js `openConnections()` (around line 6741) calls `.focus()` on the close button, which paints a heavy focus square for touch users: skip that auto-focus when `matchMedia('(pointer: coarse)').matches`, and add `.icon-btn:focus:not(:focus-visible) { outline: none }` to app.css so mouse/touch focus never shows a ring while keyboard focus still does. Let the `.cn-*` status line (account email, step text) wrap to two lines instead of truncating on phones. Verify at 390×844 with playwright-core: extend test/ui-away.test.mjs's modal-fit checks or add test/ui-connections-sheet.test.mjs (copy the server + cookie + chromium setup from test/ui-away.test.mjs) asserting that at 390×844 the Connections panel has the sheet grabber, its top is below the viewport top (not full screen), the close button is not `document.activeElement` under a coarse-pointer emulation (`hasTouch: true` context), and nothing overflows horizontally. Mark row 10 fixed in place in UI-REVIEW.md.

## Done when

`node --test test/ui-connections-sheet.test.mjs` and `grep -E '^\| 10 \|' .agent-orch/UI-REVIEW.md | grep -q fixed`
