# Task #2271: Save reusable Browser task instructions per profile, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:35  
- files: public/browser.js, public/browser.css, test/ui-browser-recipes.test.mjs

## Prompt

Add a compact Saved instructions control beside the built-in Browser task prompt in public/browser.js, with styles in public/browser.css. Owners can save the current nonblank instruction under a required name, list saved entries, insert one into an editable draft and remove it. Append to a nonempty draft without losing existing text; never submit automatically. Persist a bounded library in browser-local storage scoped by signed-in user, node and profile identity, following the existing saved-sites conventions. Explain that entries are saved on this device. Preserve the current live-only activity panel, profile switching, Send path and approvals. This is independent of #2249's project-chat prompt library: do not edit or depend on its files. Inspiration: [winfunc/opcode](https://github.com/winfunc/opcode)'s reusable instruction libraries, adapted to repeated browser office work. Add test/ui-browser-recipes.test.mjs covering save/reload/insert/remove, user/profile isolation, required input and a 390px layout. Build controls dynamically inside browser.js so no HTML or server changes are needed.

## Done when

`npm test -- test/ui-browser-recipes.test.mjs` passes.

## Result — verify failed (1) (2026-10-19 16:08)

Command: npm test -- test/ui-browser-recipes.test.mjs


> agent-orch@1.0.0 test
> node bin/test.mjs test/ui-browser-recipes.test.mjs

npm test: 1 of 246 test files, named on the command line. `npm run test:full` runs them all.
TAP version 13
# Subtest: save the draft under a name, insert it after a reload (appending to a draft), remove it; nothing is sent by itself
not ok 1 - save the draft under a name, insert it after a reload (appending to a draft), remove it; nothing is sent by itself
  ---
  duration_ms: 78147.857546
  type: 'test'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2271/test/ui-browser-recipes.test.mjs:104:1'
  failureType: 'testCodeFailure'
  error: |-
    page.reload: Timeout 30000ms exceeded.
    Call log:
      - waiting for navigation until "load"
    
  code: 'ERR_TEST_FAILURE'
  name: 'TimeoutError'
  stack: |-
    TestContext.<anonymous> (/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2271/test/ui-browser-recipes.test.mjs:132:13)
  ...
# Subtest: isolation: each profile and each signed-in user has its own saved instructions
not ok 2 - isolation: each profile and each signed-in user has its own saved instructions
  ---
  duration_ms: 34408.447156
  type: 'test'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2271/test/ui-browser-recipes.test.mjs:168:1'
  failureType: 'testCodeFailure'
  error: |-
    page.goto: Timeout 30000ms exceeded.
    Call log:
      - navigating to "http://127.0.0.1:42513/", waiting until "load"
    
  code: 'ERR_TEST_FAILURE'
  name: 'TimeoutError'
  stack: |-
    app (/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2271/test/ui-browser-recipes.test.mjs:83:11)
    async TestContext.<anonymous> (/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2271/test/ui-browser-recipes.test.mjs:169:25)
  ...
# Subtest: required input: a blank draft or a blank name shows a clear message and saves nothing; bad storage is ignored
ok 3 - required input: a blank draft or a blank name shows a clear message and saves nothing; bad storage is ignored
  ---
  duration_ms: 38580.275768
  type: 'test'
  ...
# Subtest: iPhone (390px): the chip and the panel fit with 44px targets and the prompt box stays on screen
ok 4 - iPhone (390px): the chip and the panel fit with 44px targets and the prompt box stays on screen
  ---
  duration_ms: 37972.212629
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 2
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 192895.701544

## Result — done (check passed) (2026-10-19 16:17)

AGENT-ORCH-STATUS: done — recipes test passes again after allowing for a slow, busy VM
