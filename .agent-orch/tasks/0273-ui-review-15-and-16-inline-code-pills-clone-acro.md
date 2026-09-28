# Task #273: UI-REVIEW #15 and #16: inline code pills clone across lines, 44pt tool rows, system-font time cells

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 05:17  
- files: public/app.css, test/ui-static.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

Fix rows 15 and 16 of .agent-orch/UI-REVIEW.md, both small typography changes in public/app.css. Row 15: give `.msg.text code` `box-decoration-break: clone; -webkit-box-decoration-break: clone` so an inline code pill that wraps keeps its padding and border on each line, and raise `.tool > summary` to `min-height: 44px` inside a `@media (pointer: coarse)` block (keep desktop as is). Row 16: time cells in the Away sheet (`.aw-list time`, app.css line ~1182) and the task drawer's move log use `font-family: var(--mono)`; switch those time cells to the system font with `font-variant-numeric: tabular-nums` (find the drawer move-log time rule by grepping app.css for the class app.js uses when rendering `tasks.moves`, see `modelStatus`/move rendering). Add assertions to test/ui-static.test.mjs (it already reads app.css statically) that `.msg.text code` contains `box-decoration-break: clone` and that the `.aw-list time` rule no longer contains `var(--mono)`. Mark rows 15 and 16 fixed in place in UI-REVIEW.md.

## Done when

`node --test test/ui-static.test.mjs` and `grep -q 'box-decoration-break: clone' public/app.css` and `! grep -E 'aw-list time.*var\(--mono\)' public/app.css` and `grep -E '^\| 16 \|' .agent-orch/UI-REVIEW.md | grep -q fixed`
