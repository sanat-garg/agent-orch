# Task #288: UI-REVIEW round 2: HIG review of the Settings sheet, Machines, Stats, Extensions, Files, Approvals and the live browser view on a 390px phone

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 08:13  
- files: .agent-orch/UI-REVIEW.md, .agent-orch/shots/ui-review2-*.png

## Prompt

Mobile Human Interface Guidelines review, findings only (no code changes). Read .agent-orch/UI-REVIEW.md: round 1 (task #178) reviewed 13 screens at 390 px and its rows are mostly marked fixed. The screens added or reworked since were never reviewed: the gear's Settings sheet as it is now (auto-restart switch, fallback lists, parallel settings), the Machines/cluster panel, Stats, Extensions, Files, Approvals (the approval gate UI) and the live browser view (public/browser.js, #browserModal). Use the apple-design skill (~/.claude/skills/apple-design/SKILL.md and its references) as round 1 did. Reproduce round 1's setup: a test server on a free port with `CW_NO_ORCHESTRATOR=1` or a temp `CW_DATA_DIR`, seeded with a login and enough data to show each screen (round 1's setup notes in UI-REVIEW.md and .agent-orch/queue-fixture.html show how; playwright-core is available, see test/ui-*.test.mjs for the browser setup), and capture each screen at 390×844 into .agent-orch/shots/ with names prefixed `ui-review2-`. Check safe areas, 44pt touch targets in `@media (pointer: coarse)`, 16px body text on phones, sheet presentation instead of popovers, focus and keyboard behaviour, contrast in both themes, and layout at the 390 px width. Append a section `## Round 2 (2026-09-28, task #<your id>)` to UI-REVIEW.md with a table in the same columns as round 1 (row number continuing from 18, severity, screen and screenshot, guideline cited as `file › section`, what is wrong, suggested fix), plus a short list of what you checked and found fine. Do not fix anything; fixes are queued from your rows by the next reflection. Never touch the live server on port 3000.

## Done when

`grep -q '^## Round 2' .agent-orch/UI-REVIEW.md` and `ls .agent-orch/shots/ui-review2-*.png`
