# Task #278: UI-REVIEW #13 and #14: sidebar footer in the body font at 44pt, centred small buttons; record rows 4, 8, 13 status

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 05:45  
- files: public/app.css, test/ui-static.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

Two small mobile HIG polish items from .agent-orch/UI-REVIEW.md plus bookkeeping. (a) Row 14: in public/app.css `.side-foot .host` (line ~175) uses `var(--mono)` for the 'Connected' footer text; switch it to the body font (drop the font-family) at 13px, and in a `@media (pointer: coarse)` block give `.side-foot` and `#logout` `min-height: 44px`. (b) Row 13: `.btn.small` should be `display: inline-flex; align-items: center; justify-content: center` so labels like Cancel sit centred (check nothing else relies on it being inline-block; test/ui-mobile-targets.test.mjs measures these). The drawer's priority `<select>` mentioned in row 13 no longer exists: note that in the row. (c) Bookkeeping: row 4 is already marked superseded; row 8 is effectively done (orchestrator settings live in the gear's Settings sheet, the bar is one 44pt row on touch and `html.kb-open .orch-bar { display: none }` hides it while typing, and `html.kb-open .controls .left` scrolls horizontally): mark row 8 `**fixed**` with that note. Mark rows 13 and 14 `**fixed**` too. Add assertions to test/ui-static.test.mjs: app.css has no `--mono` inside the `.side-foot .host` rule, `.btn.small` includes `inline-flex`, and a coarse-pointer rule sets `.side-foot` min-height 44px. Run `npm test -- test/ui-static.test.mjs` and `npm test -- test/ui-mobile-targets.test.mjs`.

## Done when

`npm test -- test/ui-static.test.mjs` passes and `grep -q '| 14 | low · \*\*fixed\*\*' .agent-orch/UI-REVIEW.md` and `! grep -E 'side-foot \.host \{[^}]*--mono' public/app.css`

## Result — done (check passed) (2026-09-28 05:49)

AGENT-ORCH-STATUS: done — Sidebar footer uses body font, 44pt on touch; rows marked fixed
