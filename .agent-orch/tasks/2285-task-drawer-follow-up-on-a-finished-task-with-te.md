# Task #2285: Task drawer: Follow up on a finished task, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:41  
- files: public/app.js, public/app.css, test/ui-task-followup.test.mjs

## Prompt

Goal: a done task's drawer (public/app.js, the action row around ~8700 where failed/cancelled tasks get Retry) gets 'Follow up…'. It opens a small inline note field ('What should change?'); 'Add to chat' appends 'Follow-up on task #N (<title>):\n<note>' to the project chat's draft and opens that chat without sending. This is the task-level sibling of #2265's per-file notes: reuse that code (fileFeedback, search 'cw.draft.'), factoring the shared 'append to the project chat draft and open it' steps into one helper both use instead of duplicating them.

Edge cases: empty note → 'Write a note first' and focus stays in the field; no project chat → explain inline and keep the note. Only for status 'done' (awaiting_review keeps its review panel). Keep app.js edits localised to the drawer; scoped CSS in public/app.css only if needed.

Test: new test/ui-task-followup.test.mjs copying test/ui-diff-feedback.test.mjs's setup: a done task's Follow up adds the note with the task number to the chat box (not sent); an empty note shows 'Write a note first'. Also run test/ui-diff-feedback.test.mjs to confirm per-file notes still work.

## Done when

`npm test -- test/ui-task-followup.test.mjs test/ui-diff-feedback.test.mjs` passes.
