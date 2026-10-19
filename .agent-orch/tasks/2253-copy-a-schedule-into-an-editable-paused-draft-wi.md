# Task #2253: Copy a schedule into an editable paused draft, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:17  
- files: public/schedules.js, public/schedules.css, test/ui-schedule-copy.test.mjs

## Prompt

Extend public/schedules.js with Copy on each schedule. Reuse the existing editor and create API to prefill a new schedule with the source command or agent prompt, cron, timezone, done_when and supported agent/model choices. Let the owner choose the destination project and edit a suggested copy title. Clearly state that saving creates a paused schedule; submit enabled:false only after the owner saves. Do not mutate the original, copy run history or execution IDs, or invoke Run now. Preserve the source timezone through cron preview and submission instead of silently replacing it with the browser timezone. Keep required-field and server errors visible in the draft. Add tests for copying a command schedule to another project, preserving an agent schedule's execution fields, and failed creation retaining the draft. Use isolated test data, never live schedules.

## Done when

`npm test -- test/ui-schedule-copy.test.mjs` passes.
