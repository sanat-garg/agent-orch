# Task #2278: History: ask an agent to undo a commit, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:41  
- files: public/commits.js, public/commits.css, test/ui-history-undo.test.mjs

## Prompt

Goal: in the project History sheet (public/commits.js, renderDetail), a commit's detail view gets an 'Ask to undo…' button. It drafts a request into the project's main chat without sending it, e.g. 'Undo commit <short sha> ("<subject>") with `git revert <sha>` as a new commit. Keep everything after it; never reset or rewrite main. Check the app still works afterwards.' Inspired by opcode's checkpoints (github.com/winfunc/opcode): undo should be one tap but always a new commit.

Follow #2265's pattern in public/app.js fileFeedback (search 'cw.draft.'): append to the chat's saved draft (store key 'cw.draft.'+cid, or input.value when that chat is open), close the sheet, openConvo(cid) if needed, setView('chat'), set input.value, dispatch an input event and toast 'Added to the chat's message box. Send it when ready'. The project's main chat id: look at how commits.js and app.js find the open project (CM.pid; the project's convo_id is in the orchestrator project data, e.g. O.projects or the open convo). Commit detail data has { sha, subject, task }; mention 'from task #N' when task is set.

Edge cases: no project chat available → the button explains in an inline status line and nothing is drafted; an existing draft is kept and the request is appended after a blank line. Keep changes to public/commits.js and public/commits.css (only the detail view; another task adds search to the header); do not edit app.js. Phone: 44px button under @media (pointer: coarse).

Test: new test/ui-history-undo.test.mjs copying test/ui-commits.test.mjs's setup: opening a commit and pressing 'Ask to undo…' puts a draft containing 'git revert' and the sha into the chat's box (not sent); with no chat available it shows the explanation.

## Done when

`npm test -- test/ui-history-undo.test.mjs` passes (the undo request is drafted into the chat box, not sent; with no chat it shows why).

## Result — in progress (1) (2026-10-19 15:58)

All tool calls are now being denied, including a plain `git status`, so I can't read the failing test output or re-run the test. The feature code is in place in public/commits.js and public/commits.css, and the test file test/ui-history-undo.test.mjs exists, but the last run reported all three tests failing (likely the fixture's `before` hook after the convo_id change) and I could not verify or fix it.

AGENT-ORCH-STATUS: continue — tests fail after convo_id fixture change; tool access blocked

## Result — done (check passed) (2026-10-19 16:17)

Screenshots confirm the button in the detail head on desktop and phone, and the drafted request landing in the chat box with the toast. The Done-when test passed (3/3), as did ui-static and ui-commits.

AGENT-ORCH-STATUS: done — History detail drafts git revert request into chat; tests pass
