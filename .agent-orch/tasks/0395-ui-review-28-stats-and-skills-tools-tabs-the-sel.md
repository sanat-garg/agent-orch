# Task #395: UI-REVIEW #28 (Stats and Skills & tools tabs): the selected segment gets its own --seg-on colour in dark mode and a 600 weight

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 13:14  
- files: public/stats.css, public/ext.css, test/ui-contrast.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

UI-REVIEW.md row #28: in dark mode the selected thumb of the segmented tab controls is `--panel` on a `--raised` track, 1.05:1, so which tab is active rests on text colour alone. Fix the two parts that live in free files: public/stats.css (`.sx-tabs button[aria-selected="true"]`) and public/ext.css (`.ext-tabs button[aria-selected="true"]`). Both files already have their own `@media (prefers-color-scheme: dark) { :root { … } }` block (stats.css line 5; add one to ext.css if it has none): define `--seg-on: #45423c` there and a light `--seg-on: var(--panel)` in the light `:root`, use `background: var(--seg-on)` for both selected rules and set `font-weight: 600` on the selected button in both. The selected label (`--text` #ecebe6 on #45423c) must stay ≥ 4.5:1: verify with the contrast helper in test/ui-contrast.test.mjs and pick a slightly darker `--seg-on` if it does not. Extend test/ui-contrast.test.mjs with one test that parses stats.css's and ext.css's dark blocks, asserts `--seg-on` is defined, differs from app.css's dark `--raised` by at least 1.4:1, and that dark `--text` on `--seg-on` is ≥ 4.5:1. Mark row #28 in .agent-orch/UI-REVIEW.md as partly fixed in place ('Fixed for the Stats and Skills & tools tabs (#<this task>); the Files switch and Max tasks wait for app.css'). The Files switch and Max tasks parts are NOT in scope (app.css is held). Run only `npm test -- test/ui-contrast.test.mjs`.

## Done when

`npm test -- test/ui-contrast.test.mjs` && `grep -q -- '--seg-on' public/stats.css` && `grep -q -- '--seg-on' public/ext.css`

## Result — done (check passed) (2026-09-28 13:52)

AGENT-ORCH-STATUS: done — Stats and Skills & tools selected tabs: --seg-on, weight 600
