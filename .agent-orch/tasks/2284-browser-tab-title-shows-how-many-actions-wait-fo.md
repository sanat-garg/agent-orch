# Task #2284: Browser tab title shows how many actions wait for you, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:41  
- files: public/app.js, test/ui-title-badge.test.mjs

## Prompt

Goal: on desktop, when held actions wait for the owner's approval, the browser tab title starts with the count, e.g. '(2) My project · agent-orch', so the owner notices from another tab. Use the same count the Home Screen badge already uses (public/app.js ~line 3538: 'held actions waiting for the owner, across every task this page knows'): factor the count into one small function both the badge and the title use, and have updateHeader (~line 927, document.title) and the badge update both refresh the title. No count → the plain title as today. In Zen mode keep the plain title (CONTEXT.md: Zen hides notices).

Keep app.js edits small and localised to those two spots; app.js is edited by other running tasks. No new files besides the test.

Test: new test/ui-title-badge.test.mjs using playwright-core with a neighbouring app UI test's setup (stub the data that feeds approvals): two pending approvals → document.title starts with '(2) '; after they're resolved → no prefix.

## Done when

`npm test -- test/ui-title-badge.test.mjs` passes.

## Result — done (check passed) (2026-10-19 16:25)

AGENT-ORCH-STATUS: done — tab title prefixes pending approval count; test passes
