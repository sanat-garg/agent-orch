# Task #2293: Integrate #2249: Save and reuse project prompts from the composer, with tests (ui)

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-10-19 16:14  
- files: public/prompts.js, public/prompts.css, public/index.html, server.mjs, test/ui-prompt-library.test.mjs

## Prompt

Task #2249 ("Save and reuse project prompts from the composer, with tests (ui)") finished in its own git worktree, but its branch `agent-orch/task-2249` conflicts with `main`, which changed meanwhile (conflicting files: server.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #2249's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #2249's instructions were:

Add a small saved-prompt library in new public/prompts.js and public/prompts.css, inspired by winfunc/opcode's reusable instructions library. Read .agent-orch/AREAS.md first. Let the owner save the current composer draft with a required name, edit/delete saved prompts, and insert one at the cursor without replacing surrounding text or sending it. Store entries per signed-in user and project in this browser, clearly labelled as browser-local. Preserve unsent drafts and show storage/validation errors. Add a desktop composer control and a phone '+' sheet entry dynamically from the module, with its own click handler. Keep app.js and the queued slash-command implementation untouched. The only server.mjs/index.html edits should register the new script and stylesheet. Test save/reload/insert, empty input rejection, and project isolation using local fixtures.

## Done when

`npm test -- test/ui-prompt-library.test.mjs test/ui-static.test.mjs` passes.

## Result — verify failed (1) (2026-10-19 16:25)

Command: npm test -- test/ui-prompt-library.test.mjs test/ui-static.test.mjs

- server details live in the controller node detail, the Machines view's side panel; no separate modal
  ---
  duration_ms: 5.66704
  type: 'test'
  ...
# Subtest: top bar keeps its content row below the iPhone safe-area inset: 56px, 44px on phones (UI-REVIEW \#1, \#450)
ok 17 - top bar keeps its content row below the iPhone safe-area inset: 56px, 44px on phones (UI-REVIEW \#1, \#450)
  ---
  duration_ms: 0.565044
  type: 'test'
  ...
# Subtest: composer follows the on-screen keyboard via visualViewport and --kb (UI-REVIEW \#2)
ok 18 - composer follows the on-screen keyboard via visualViewport and --kb (UI-REVIEW \#2)
  ---
  duration_ms: 0.291962
  type: 'test'
  ...
# Subtest: inline code pills clone across lines, 44pt tool rows on touch, system-font time cells (UI-REVIEW \#15, \#16)
ok 19 - inline code pills clone across lines, 44pt tool rows on touch, system-font time cells (UI-REVIEW \#15, \#16)
  ---
  duration_ms: 0.519684
  type: 'test'
  ...
# Subtest: phones get 16px body copy and 12px-minimum metadata (UI-REVIEW \#7)
ok 20 - phones get 16px body copy and 12px-minimum metadata (UI-REVIEW \#7)
  ---
  duration_ms: 1.060448
  type: 'test'
  ...
# Subtest: every script and stylesheet index.html loads is on the server's static list (else it 404s)
ok 21 - every script and stylesheet index.html loads is on the server's static list (else it 404s)
  ---
  duration_ms: 2.382777
  type: 'test'
  ...
# Subtest: top-level function names are unique across the classic public/*.js scripts (a later one silently wins)
ok 22 - top-level function names are unique across the classic public/*.js scripts (a later one silently wins)
  ---
  duration_ms: 7.522814
  type: 'test'
  ...
# Subtest: sidebar footer in the body font at 44pt on touch; .btn.small centres its label (UI-REVIEW \#13, \#14)
ok 23 - sidebar footer in the body font at 44pt on touch; .btn.small centres its label (UI-REVIEW \#13, \#14)
  ---
  duration_ms: 0.285842
  type: 'test'
  ...
# Subtest: Sign out lives in the Connections window, not the sidebar footer; the version sits under the logo
ok 24 - Sign out lives in the Connections window, not the sidebar footer; the version sits under the logo
  ---
  duration_ms: 0.506564
  type: 'test'
  ...
# Subtest: touch screens get 16px fields and 44pt targets in Settings, Skills, Files, Browser, Stats, Machines, drawer, queue (UI-REVIEW \#20, \#22)
ok 25 - touch screens get 16px fields and 44pt targets in Settings, Skills, Files, Browser, Stats, Machines, drawer, queue (UI-REVIEW \#20, \#22)
  ---
  duration_ms: 3.648346
  type: 'test'
  ...
# Subtest: the Browser view opens from Settings (no header tab), with the live view in place, a prompt box and an activity panel
ok 26 - the Browser view opens from Settings (no header tab), with the live view in place, a prompt box and an activity panel
  ---
  duration_ms: 1.630252
  type: 'test'
  ...
1..26
# tests 26
# suites 0
# pass 25
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 12816.904668

## Result — done (check passed) (2026-10-19 16:37)

AGENT-ORCH-STATUS: done — merge conflict fixed; prompt-library test race fixed; check passes
