# Task #296: UI-REVIEW #20 and #22: phone fields at 16px and 44pt touch targets on Stats, Skills, Files, Machines, Browser, drawer and queue cards

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 08:44  
- files: public/app.css, public/stats.css, public/ext.css, public/files.css, public/browser.css, test/ui-static.test.mjs, test/ui-touch-targets.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

Fix rows 20 and 22 of .agent-orch/UI-REVIEW.md Round 2 (read them; the measurements and the exact selectors are there). Both are CSS only.

#20: iOS Safari zooms when a field under 16px takes focus and the PWA stays zoomed. Add one `@media (pointer: coarse)` rule next to the existing `.msg-edit` rule at public/app.css:252 setting `font-size: 16px` for `.st-row select, .st-dir textarea, #stGatePatterns, #extBody input, #extBody textarea, #extBody select, .fx-search input, .bv-bar input, .dr-due input` (keep `font-family: var(--mono)` where it is set). Selectors that live in ext.css, files.css or browser.css may go in those files' own `(pointer: coarse)` blocks instead; keep each rule near the base rule it overrides.

#22: in `(pointer: coarse)` blocks: `.sx-tabs button, .range-picker button, .ext-tabs button, .fx-view button { min-height: 44px; min-width: 44px }`; `.mc-ctl .seg-sm button { height: 44px; min-width: 44px }`; `.fx-search, .bv-bar input, .bw-add input { height: 44px }`; `.dr-body details > summary { min-height: 44px; display: flex; align-items: center }`; and give `.tc-ctl` and `.tc-rb` on queue cards a `position: relative` plus `::after { content: ''; position: absolute; inset: -10px }` hit area. Check every selector exists (grep public/) and adjust to the real class names; check the layouts still fit 390px (the Stats tabs row and the range picker must not wrap into three lines: shrink padding or font before letting them wrap). Tag each new rule with a `/* UI-REVIEW #20 */` or `/* UI-REVIEW #22 */` comment as the round 1 fixes did.

Add assertions to test/ui-static.test.mjs (see how earlier rows were guarded there) that the coarse-pointer block sets 16px for those field selectors and 44px for those controls, or add test/ui-touch-targets.test.mjs measuring them with playwright-core as a touch device the way test/ui-away.test.mjs does, if a fixture with these sheets is cheap to open. Mark rows 20 and 22 fixed in place in UI-REVIEW.md.

## Done when

`npm test -- test/ui-static.test.mjs test/ui-contrast.test.mjs test/ui-away.test.mjs` passes and `grep -q 'UI-REVIEW #22' public/app.css`
