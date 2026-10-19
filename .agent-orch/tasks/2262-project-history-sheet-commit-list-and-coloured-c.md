# Task #2262: Project History sheet: commit list and coloured commit diff, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:22  
- files: public/commits.js, public/commits.css, public/index.html, public/app.js, server.mjs, test/ui-commits.test.mjs

## Prompt

Add a 'History' view to agent-orch's UI so the owner can browse the open project's commits: chat auto-commits and `agent-orch #N:` task merges (idea from siteboon/claudecodeui's Git explorer; patterns only). Read .agent-orch/CONTEXT.md first, then mirror public/shots.js, the top bar's Screenshots pill and sheet, for structure, lifecycle and styling.

The backend is being built in parallel by another task. Code against this exact contract:
- `GET /api/orch/projects/:id/commits?before=<sha>&limit=50` → `{ branch, commits: [{ sha, subject, author, at /*epoch ms*/, task /*number|null*/, add, del, files }], more }`, newest first.
- `GET /api/orch/projects/:id/commit?sha=<sha>` → `{ sha, subject, body, author, at, task, files: [{ path, add, del, binary }], patch, truncated }`. Errors are `{ error }` with status 400/404/500.

Build:
1. New `public/commits.js` and `public/commits.css` (an IIFE exposing `window.Commits = { sync, open }`, a header comment like shots.js, and app.js helpers such as `$`, `el`, `api`, `relTime`, `showTask`, `coarse`).
2. index.html: a `#commitsLink` pill beside `#shotsLink` (shown whenever a project is open, hidden in the term/browser views like shots), a `#commitsModal` sheet, plus `<link>` and `<script src="/commits.js">` tags next to the shots ones.
3. server.mjs: add `/commits.js` and `/commits.css` to the long static allowlist line (`p === '/shots.js' || …`). Change nothing else in server.mjs.
4. app.js: add a one-line `window.Commits?.sync();` next to each existing `window.Shots?.sync()` / `renderHeader()` call. Make no other app.js edits.

The sheet:
- Each commit row shows the subject, relative time, author and green +add / red −del, plus a 'Task #N' chip that opens the task via showTask.
- 'Load older' appears when `more` is true; it passes `before` = the last sha.
- Empty state: 'No commits yet'. Load errors show the server's error text with a Retry button.
- Tapping a commit opens a detail view in the same sheet: a Back button, the subject and body, the per-file list with counts, and the patch in a monospace block with added/removed/hunk lines coloured. Show a 'Diff truncated' note when `truncated` is true.
- Escape closes the sheet; focus returns to the pill.
- Phones: follow phone.css conventions inside commits.css (44px targets in `@media (pointer: coarse)`; modal `grid-template-columns: minmax(0, 100%)`).

Test `test/ui-commits.test.mjs`: copy the boot setup of a neighbouring UI test such as test/ui-shots.test.mjs or test/ui-digest.test.mjs (server.mjs on a spare port, CW_NO_ORCHESTRATOR or whatever it uses, a temp data dir, skip when Chromium can't launch). Stub both endpoints with `page.route` so the test doesn't depend on the backend task. Main path: the list renders 2 stubbed commits with their counts and the task chip, then opening one shows a coloured `+`/`-` line. Failure path: a stubbed 404 detail shows its error text. Also make sure `test/ui-static.test.mjs` still passes (new `$('id')`s must exist in index.html, and there must be no duplicate function names).

## Done when

`npm test -- test/ui-commits.test.mjs test/ui-static.test.mjs` passes

## Result — done (check passed) (2026-10-19 14:35)

AGENT-ORCH-STATUS: done — History sheet lists commits and shows coloured diffs; tests pass
