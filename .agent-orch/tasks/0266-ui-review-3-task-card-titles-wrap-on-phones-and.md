# Task #266: UI-REVIEW #3: task-card titles wrap on phones and the model chip drops under the title

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 04:54  
- files: public/app.css, public/app.js, test/ui-mobile-cards.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

Mobile HIG finding #3 in .agent-orch/UI-REVIEW.md: in the chat's task cards (`.tcard`, built in public/app.js near `tc-title`/`tc-tags`, styled in public/app.css around line 936 and in the `@media (max-width: 800px)` block near line 1137) `.tc-tags { max-width: 45% }` leaves the title truncated to a few words on a 390px screen and the model chip itself truncates. Fix in the mobile media block only: let `.tcard` wrap (`flex-wrap: wrap`), put `.tc-tags` on its own full-width row under the title (`order` after `.tc-main`, `max-width: none`, keep the chevron/right controls aligned), and let `.tc-title` wrap to at most two lines (`white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden`). In app.js, when `matchMedia('(max-width: 800px)')` matches, have the card's model chip use a short form (model name plus 'moved' when delegated) instead of the full 'moved from …' text; look at `modelChip`/`modelStatus` and reuse their strings. Desktop layout must not change. Add a playwright-core test test/ui-mobile-cards.test.mjs (copy the harness of test/ui-mobile-keyboard.test.mjs: server on a free port, CW_DATA_DIR temp dir, skip when Chromium is missing) that seeds a task with a 90-character title and a delegated model, opens the chat at 390×844 and asserts: the title element's height spans two lines (scrollHeight <= clientHeight, and clientHeight > 1.5× its line-height), and `.tc-tags` sits below `.tc-main` (its top >= the title's bottom). Then mark row 3 of .agent-orch/UI-REVIEW.md as `high · **fixed**` the same way rows 1 and 2 are.

## Done when

`node --test test/ui-mobile-cards.test.mjs` passes and `grep -n '^| 3 | high · \*\*fixed\*\*' .agent-orch/UI-REVIEW.md` prints a match

## Result — done (check passed) (2026-09-28 05:02)

AGENT-ORCH-STATUS: done — Phone task cards wrap titles to two lines; chip moved below
