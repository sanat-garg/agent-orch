# Task #267: UI-REVIEW #5: 44pt touch targets for chips, small buttons and icon buttons on touch screens

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 04:54  
- files: public/app.css, test/ui-mobile-targets.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

Mobile HIG finding #5 in .agent-orch/UI-REVIEW.md: on touch devices these controls are under Apple's 44×44pt minimum: `#send`/`.send` (36), `.icon-btn` (36, includes `#openSidebar`, `#drClose`, modal close buttons), `.chip` (30; `#modeChip`, `#modelChip`, `#fbChip`), `.orch-bar .chip` (28), `.btn.small` (32; drawer Cancel, priority select), `.cn-btn.btn.small` (26; Connect/Disconnect), `#usRefresh` (24), `.convo .more` (28), `details.dr-prompt summary` (20) and settings checkboxes (18). public/app.css already has several `@media (pointer: coarse)` blocks (lines ~245, 357, 537, 565, 631, 875, 915, 923): add one consolidated block near the end of the file that sets `min-height: 44px` on `.chip`, `.orch-bar .chip`, `.btn.small`, `.cn-btn.btn.small` and `details.dr-prompt summary`, makes `.icon-btn` and `.send` 44×44, and gives the small glyph buttons (`#usRefresh`, `.convo .more`) a `position: relative` + `::after { content: ''; position: absolute; inset: -10px }` hit area without growing their visuals. Keep the desktop (fine pointer) sizes untouched and don't let the orch bar or composer grow taller than one extra row at 390px wide (check test/ui-mobile-keyboard.test.mjs still passes). Add test/ui-mobile-targets.test.mjs (same harness as test/ui-mobile-keyboard.test.mjs, Chromium context with `hasTouch: true` and viewport 390×844) that asserts each of the selectors listed above that is visible on the chat screen has a bounding box or hit area of at least 44×44 CSS px (for the ::after buttons, measure the element's box plus 20px). Then mark row 5 of .agent-orch/UI-REVIEW.md as `high · **fixed**` like rows 1 and 2.

## Done when

`node --test test/ui-mobile-targets.test.mjs test/ui-mobile-keyboard.test.mjs` passes and `grep -n '^| 5 | high · \*\*fixed\*\*' .agent-orch/UI-REVIEW.md` prints a match

## Result — done (check passed) (2026-09-28 05:05)

AGENT-ORCH-STATUS: done — touch screens get 44pt targets; target and keyboard tests pass
