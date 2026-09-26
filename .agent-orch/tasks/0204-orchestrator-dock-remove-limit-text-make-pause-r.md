# Task #204: Orchestrator dock: remove limit text, make Pause/Resume prominent

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 14:32  
- files: public/index.html, public/app.css, public/app.js

## Prompt

In the orchestrator dock above the chat prompt (the bar with #obStatus, #obCounts, #obQueue, #obSettingsBtn and #obPause in public/index.html ~lines 117-140), remove the raw limit status text such as 'Claude: five_hour reached · re…' from #obStatus; that information lives in the usage card and the task statuses. Keep the status short: 'Running 2 · 5 queued', 'Paused' or 'Idle'. Make Pause/Resume a prominent button: a filled primary style when the orchestrator is paused ('▶ Resume', accent background), and a clear secondary style with a pause icon when running ('⏸ Pause'), at least 36px tall (44px on touch), with a label always visible (not icon-only) and a confirmation-free toggle with an immediate visual state change. Make sure the dock doesn't wrap awkwardly at 390px. Screenshots on desktop and mobile, paused and running.

## Done when

`node --check public/app.js && npm test` passes, `! grep -n "reached · re" public/app.js`, and #obPause renders with distinct paused/running button styles

## Result — verify failed (1) (2026-09-26 19:10)

Command: node --check public/app.js && npm test && ! grep -n "reached · re" public/app.js

copy '/usr/share/git-core/templates/hooks/pre-merge-commit.sample' to '/tmp/cw-wt-aYdvNb/proj/.git/hooks/pre-merge-commit.sample': Disk quota exceeded
        
      code: 'ERR_TEST_FAILURE'
      stack: |-
        genericNodeError (node:internal/errors:983:15)
        wrappedFn (node:internal/errors:537:14)
        checkExecSyncError (node:child_process:916:11)
        execFileSync (node:child_process:952:15)
        git (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-204/test/worktree.test.mjs:14:31)
        makeRepo (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-204/test/worktree.test.mjs:20:3)
        TestContext.<anonymous> (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-204/test/worktree.test.mjs:217:28)
        Test.runInAsyncScope (node:async_hooks:214:14)
        Test.run (node:internal/test_runner/test:1047:25)
        Test.start (node:internal/test_runner/test:944:17)
      ...
    # Subtest: a real integration conflict stays unresolved until its markers are removed
    not ok 7 - a real integration conflict stays unresolved until its markers are removed
      ---
      duration_ms: 12.070426
      type: 'test'
      location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-204/test/worktree.test.mjs:230:3'
      failureType: 'testCodeFailure'
      error: |-
        Command failed: git init -q -b main
        error: copy-fd: write returned: Disk quota exceeded
        fatal: cannot copy '/usr/share/git-core/templates/hooks/pre-merge-commit.sample' to '/tmp/cw-wt-7YCHZT/proj/.git/hooks/pre-merge-commit.sample': Disk quota exceeded
        
      code: 'ERR_TEST_FAILURE'
      stack: |-
        genericNodeError (node:internal/errors:983:15)
        wrappedFn (node:internal/errors:537:14)
        checkExecSyncError (node:child_process:916:11)
        execFileSync (node:child_process:952:15)
        git (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-204/test/worktree.test.mjs:14:31)
        makeRepo (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-204/test/worktree.test.mjs:20:3)
        TestContext.<anonymous> (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-204/test/worktree.test.mjs:231:28)
        Test.runInAsyncScope (node:async_hooks:214:14)
        Test.run (node:internal/test_runner/test:1047:25)
        Test.start (node:internal/test_runner/test:944:17)
      ...
    1..7
not ok 248 - worktrees
  ---
  duration_ms: 41334.256734
  type: 'suite'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-204/test/worktree.test.mjs:81:1'
  failureType: 'subtestsFailed'
  error: '7 subtests failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: non-object and odd WebSocket frames leave the server running (AUDIT \#33)
ok 249 - non-object and odd WebSocket frames leave the server running (AUDIT \#33)
  ---
  duration_ms: 9090.393338
  type: 'test'
  ...
1..249
# tests 267
# suites 9
# pass 225
# fail 42
# cancelled 0
# skipped 0
# todo 0
# duration_ms 438963.311698

## Result — done (check passed) (2026-09-26 19:29)

AGENT-ORCH-STATUS: done — Temporary fixture isolation fixed; exact verification passes all 267 tests.
