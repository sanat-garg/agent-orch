# Task #2265: Draft follow-up requests from changed files in the task drawer, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:29  
- files: public/app.js, public/app.css, test/ui-diff-feedback.test.mjs

## Prompt

Build on the completed Changes section (#2234). Add a file-level feedback action with a compact note field and Add to chat button. Transfer the task number/title, selected file path and nonblank owner note into the task project's main chat draft, using O.detail.project.convo_id; append to existing draft text and open that chat without sending automatically. Preserve notes across drawer refreshes and keep them separate by task/file. If the target chat is unavailable, show a clear message and retain the note. Follow BloopAI/vibe-kanban's diff-feedback interaction as inspiration, without copying code; line selection and stored review threads are outside this task. Modify public/app.js only around changesSection/fileDiff and narrowly scoped helpers, and append scoped styles in public/app.css. Avoid retry controls, composer send logic, server.mjs and index.html, which have active workers. Add test/ui-diff-feedback.test.mjs following test/ui-task-changes.test.mjs's isolated browser setup. Test draft transfer to the correct project, preservation of an existing draft, no automatic send, blank-note rejection and unavailable-chat handling. Support keyboard use and phone touch targets. Test only on localhost; never restart the live app.

## Done when

`npm test -- test/ui-diff-feedback.test.mjs test/ui-task-changes.test.mjs test/ui-static.test.mjs` passes.
