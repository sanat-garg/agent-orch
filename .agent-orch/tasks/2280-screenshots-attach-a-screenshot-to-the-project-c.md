# Task #2280: Screenshots: attach a screenshot to the project chat, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:41  
- files: public/shots.js, public/shots.css, test/ui-shots-attach.test.mjs

## Prompt

Goal: in the Screenshots sheet (public/shots.js), each screenshot (the large newest one and each grid thumbnail's lightbox or a small button) gets 'Attach to chat'. It fetches the image, wraps it in a File named '<task>-<name>.png' (keep the real extension/type), closes the sheet, opens the project's main chat (openConvo(cid) if not open, setView('chat'), closeSidebar()), and calls app.js's global addAttachments([file]) so it appears in the composer's attachment tray, ready to send with a note like 'this button is misaligned'. Don't send anything.

Find the project's chat id the same way shots.js already knows the open project (SH.pid; look for convo_id in orchestrator project data in app.js). Edge cases: fetch fails or non-OK → toast an error ('Couldn't attach that screenshot') and keep the sheet open; no project chat → explain inline. Respect Compare mode (button not shown while comparing). 44px targets on phones (public/shots.css). Don't edit app.js.

Test: new test/ui-shots-attach.test.mjs copying test/ui-shots.test.mjs's setup: pressing Attach to chat adds a tray item with the screenshot's name; a 404 image shows the error toast and adds nothing.

## Done when

`npm test -- test/ui-shots-attach.test.mjs` passes (attach adds the screenshot to the tray; a failed fetch shows an error and adds nothing).

## Result — verify failed (1) (2026-10-19 16:18)

Command: npm test -- test/ui-shots-attach.test.mjs

a note and send'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'task-2-home-after.png is in the message: add a note and send'
  actual: |-
    task-2-home-after.png is in the message: add a note and send
    ×
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-2280/test/ui-shots-attach.test.mjs:140:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
# Subtest: a screenshot that fails to load shows an error toast, keeps the sheet open and adds nothing; Compare hides the buttons
not ok 2 - a screenshot that fails to load shows an error toast, keeps the sheet open and adds nothing; Compare hides the buttons
  ---
  duration_ms: 1552.216117
  type: 'test'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2280/test/ui-shots-attach.test.mjs:145:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    
    + "Couldn't attach that screenshot\n×"
    - "Couldn't attach that screenshot"
                                      ^
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: "Couldn't attach that screenshot"
  actual: |-
    Couldn't attach that screenshot
    ×
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-2280/test/ui-shots-attach.test.mjs:153:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: a project without a chat explains inline instead of attaching; phone targets are 44px
not ok 3 - a project without a chat explains inline instead of attaching; phone targets are 44px
  ---
  duration_ms: 30523.259149
  type: 'test'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2280/test/ui-shots-attach.test.mjs:170:1'
  failureType: 'testCodeFailure'
  error: |-
    locator.waitFor: Timeout 30000ms exceeded.
    Call log:
      - waiting for locator('#shotsLink') to be visible
        - locator resolved to hidden <button hidden="" type="button" id="shotsLink" aria-haspopup="dialog" class="repo-link sh-link" aria-controls="shotsModal">…</button>
        62 × locator resolved to hidden <button type="button" id="shotsLink" aria-haspopup="dialog" aria-label="Screenshots" class="repo-link sh-link" aria-controls="shotsModal" title="Latest screenshots from this project's tasks (1)">…</button>
    
  code: 'ERR_TEST_FAILURE'
  name: 'TimeoutError'
  stack: |-
    open (/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2280/test/ui-shots-attach.test.mjs:112:36)
    async TestContext.<anonymous> (/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2280/test/ui-shots-attach.test.mjs:171:33)
  ...
1..3
# tests 3
# suites 0
# pass 0
# fail 3
# cancelled 0
# skipped 0
# todo 0
# duration_ms 37886.701219

## Result — done (check passed) (2026-10-19 16:21)

AGENT-ORCH-STATUS: done — Attach to chat on screenshots; all 3 tests pass
