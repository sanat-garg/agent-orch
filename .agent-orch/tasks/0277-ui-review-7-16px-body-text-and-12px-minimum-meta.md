# Task #277: UI-REVIEW #7: 16px body text and 12px-minimum metadata on phones

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 05:45  
- files: public/app.css, test/ui-static.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

Mobile HIG finding #7 in .agent-orch/UI-REVIEW.md: body copy is 14-15px and metadata 11-11.5px, which reads desktop-dense on an iPhone (Apple HIG typography: 17pt default body, 11pt absolute minimum; aim for 16px body so iOS Safari never zooms). In public/app.css, inside a `@media (max-width: 600px)` block (add one near the other mobile blocks around lines 1318-1360), raise `.msg.text`, `.tcard`, `.convo .ct` and `.dr-summary` to 16px and bring every metadata size under 12px up to 12px: `.tc-tag` (11.5), `.ms-age` (11), `.ms-open` and `.ms-note` (11.5), `.cn-step.muted` (11.5), `.att-size` (11.5) and `.fb-pop .m-head h2` (11). Keep line-heights so nothing clips; check the 375x667 layout still passes test/ui-away.test.mjs. Add a static test to test/ui-static.test.mjs that parses app.css, finds the max-width 600px block(s), and asserts those selectors have font-size >= 12px there and the four body selectors are 16px. Mark row 7 `**fixed**` in UI-REVIEW.md with a one-line note. Run `npm test -- test/ui-static.test.mjs` and `npm test -- test/ui-away.test.mjs`.

## Done when

`npm test -- test/ui-static.test.mjs` passes and `grep -q '| 7 | med · \*\*fixed\*\*' .agent-orch/UI-REVIEW.md`
