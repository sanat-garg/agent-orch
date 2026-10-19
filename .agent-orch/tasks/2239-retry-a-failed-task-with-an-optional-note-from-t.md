# Task #2239: Retry a failed task with an optional note from the owner, with tests

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:11  
- files: orchestrator.mjs, public/app.js, public/app.css, test/retry-note.test.mjs

## Prompt

The task drawer's Retry button (public/app.js ~line 8528, `orchAction('retry')` → POST /api/orch/task/:id/action {action, value}) requeues a failed/cancelled task unchanged (orchestrator.mjs taskAction case 'retry', ~line 4601). Make it open a small sheet: a textarea 'What should it do differently? (optional)' plus Retry and Cancel buttons; ⌘/Ctrl+Enter retries. It's sent as `value`. In orchestrator.mjs, when 'retry' gets a non-empty string note (trimmed; reject over 2000 chars with {error:'Keep the note under 2000 characters'}), the next run's prompt must include it: append `\n\nOwner's note for this retry: <note>` to tasks.prompt in the same UPDATE, and log it in the retry event. An empty note behaves exactly as today. The drawer's instructions section then shows the note as part of the prompt. Use a sheet that works on phones (CONTEXT.md mobile rules; styles in public/app.css). Write test/retry-note.test.mjs with createOrchestrator and a fake query (copy a scheduling test's setup): a failed task retried with a note runs with the note in its prompt; a 2001-character note is refused and the task stays failed.

## Done when

`npm test -- test/retry-note.test.mjs` passes.

## Result — done (check passed) (2026-10-19 14:27)

AGENT-ORCH-STATUS: done — Retry sheet sends optional note, appended to prompt; tests pass
