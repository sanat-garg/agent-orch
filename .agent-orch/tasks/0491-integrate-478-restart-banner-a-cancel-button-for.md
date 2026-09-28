# Task #491: Integrate #478: Restart banner: a Cancel button for 'Restarting once idle'

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-09-28 18:16  
- files: restart.mjs, server.mjs, public/app.js, test/restart-cancel*.test.mjs

## Prompt

Task #478 ("Restart banner: a Cancel button for 'Restarting once idle'") finished in its own git worktree, but its branch `agent-orch/task-478` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #478's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #478's instructions were:

The updates banner that says 'Restarting once idle (automatic)…' (or the rolling-restart equivalent 'restarting in 30 s / waiting…') needs a 'Cancel' button. Clicking it calls a new POST /api/restart/cancel (login-protected) that cancels the pending restart (the rolling timer or idle drain; undrain so claiming resumes at once), and the banner changes to 'Update ready: vX.YY · Restart now', with the restart deferred until the owner clicks Restart now or new server code lands again (a new commit re-arms the automatic restart unless 'Apply updates' is Manual). Log the cancel as an event. Tests: cancel stops a scheduled rolling restart and resumes claiming; the banner shows the deferred state; a new commit re-arms. Run only the touched test files.

## Done when

`node --test test/restart-cancel*.test.mjs` passes (cancel stops the restart and resumes claims, banner deferred state, re-arm on a new commit)

## Result — verify failed (1) (2026-09-28 18:17)

Command: node --test test/restart-cancel*.test.mjs

TAP version 13
# Subtest: cancel stops a scheduled rolling restart; that HEAD is not re-armed, a newer one is
ok 1 - cancel stops a scheduled rolling restart; that HEAD is not re-armed, a newer one is
  ---
  duration_ms: 309.835903
  type: 'test'
  ...
# Subtest: the banner shows Cancel while a restart is pending and "Update ready" once deferred
ok 2 - the banner shows Cancel while a restart is pending and "Update ready" once deferred
  ---
  duration_ms: 4.250148
  type: 'test'
  ...
# Subtest: cancelling the idle drain resumes claiming at once and defers the update
ok 3 - cancelling the idle drain resumes claiming at once and defers the update
  ---
  duration_ms: 4863.622767
  type: 'test'
  ...
# Subtest: cancelling a rolling restart defers it; a new commit re-arms it
not ok 4 - cancelling a rolling restart defers it; a new commit re-arms it
  ---
  duration_ms: 4732.176166
  type: 'test'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-478/test/restart-cancel.test.mjs:148:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    
    + {
    +   version: '4.37'
    + }
    - null
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: ~
  actual:
    version: '4.37'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-478/test/restart-cancel.test.mjs:163:10)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
1..4
# tests 4
# suites 0
# pass 3
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10567.780633

## Result — done (check passed) (2026-09-28 18:19)

AGENT-ORCH-STATUS: done — a re-armed restart clears the deferral at once; the restart-cancel tests pass
