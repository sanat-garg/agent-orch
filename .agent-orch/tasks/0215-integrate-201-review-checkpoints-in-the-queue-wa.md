# Task #215: Integrate #201: Review checkpoints in the queue: wait for owner approval after a task

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-09-27 11:44  
- files: orchestrator.mjs, server.mjs, public/app.js, public/app.css, test/checkpoint*.test.mjs

## Prompt

Task #201 ("Review checkpoints in the queue: wait for owner approval after a task") finished in its own git worktree, but its branch `agent-orch/task-201` conflicts with `main`, which changed meanwhile (conflicting files: orchestrator.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #201's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #201's instructions were:

Add review breaks so important work doesn't drift in the wrong direction. 1) Backend: a task kind 'review' (a checkpoint) that never runs an agent. It becomes 'awaiting review' when its prerequisite finishes, and blocks everything after it until the owner approves. Approve continues the queue. 'Request changes' {note} queues a follow-up fix task (with the note and the reviewed task's diff context) before the checkpoint's dependents, and re-arms the checkpoint after it. Endpoints: POST /api/orch/tasks/:id/checkpoint (insert a checkpoint after task :id; dependents re-link to follow it), POST /api/orch/tasks/:id/approve, POST /api/orch/tasks/:id/request-changes. 2) The tasks JSON block accepts {"kind":"review","title":…, "after": i}, and the planner prompt tells the planner to add a checkpoint after important/risky or direction-setting tasks (a new architecture, a UI redesign, data migrations). 3) UI: in the Queue modal and on task cards, a '+ Review break' action on any queued or running task inserts a checkpoint after it. Checkpoint cards look distinct (a flag icon, 'Wait for your review'). When it's awaiting review, it shows the reviewed task's summary, its changed-files list and screenshots, with 'Approve & continue' and 'Request changes' buttons, and a chat notice plus the completion sound. 4) The drag-and-drop reorder moves checkpoints with their dependents. Tests: dependents wait while it's awaiting review; approve releases them; request-changes inserts a fix task and re-arms the checkpoint.

## Done when

`npm test` passes with checkpoint tests (blocking, approve, request-changes), and task cards offer a '+ Review break' action

## Result — verify failed (1) (2026-09-27 12:07)

Command: npm test

en any command snippet is unsafe
  ---
  duration_ms: 0.251481
  type: 'test'
  ...
# Subtest: extractCommand keeps a backslash-escaped backtick inside the snippet
ok 191 - extractCommand keeps a backslash-escaped backtick inside the snippet
  ---
  duration_ms: 0.365242
  type: 'test'
  ...
# error: could not apply a6b1194... mine
# hint: Resolve all conflicts manually, mark them as resolved with
# hint: "git add/rm <conflicted_files>", then run "git rebase --continue".
# hint: You can instead skip this commit: run "git rebase --skip".
# hint: To abort and get back to the state before "git rebase", run "git rebase --abort".
# hint: Disable this message with "git config set advice.mergeConflict false"
# Could not apply a6b1194... \# mine
# Subtest: worktrees
    # Subtest: two concurrent tasks editing different files both merge, and their worktrees are cleaned up
    ok 1 - two concurrent tasks editing different files both merge, and their worktrees are cleaned up
      ---
      duration_ms: 6642.559885
      type: 'test'
      ...
    # Subtest: two tasks editing the same line: the second needs integration, and its integrator merges it
    ok 2 - two tasks editing the same line: the second needs integration, and its integrator merges it
      ---
      duration_ms: 7803.806532
      type: 'test'
      ...
    # Subtest: boot keeps an interrupted task's worktree for reuse and parks an orphaned one on its branch
    ok 3 - boot keeps an interrupted task's worktree for reuse and parks an orphaned one on its branch
      ---
      duration_ms: 6906.746179
      type: 'test'
      ...
    # Subtest: a detached-HEAD worktree is re-attached to its branch with its uncommitted work, not deleted
    ok 4 - a detached-HEAD worktree is re-attached to its branch with its uncommitted work, not deleted
      ---
      duration_ms: 1947.962536
      type: 'test'
      ...
    # Subtest: mergeBack reports a conflict without touching main
    ok 5 - mergeBack reports a conflict without touching main
      ---
      duration_ms: 1424.320135
      type: 'test'
      ...
    # Subtest: a setext ======= heading merged in from main is not an unresolved conflict
    ok 6 - a setext ======= heading merged in from main is not an unresolved conflict
      ---
      duration_ms: 1169.011131
      type: 'test'
      ...
    # Subtest: a real integration conflict stays unresolved until its markers are removed
    ok 7 - a real integration conflict stays unresolved until its markers are removed
      ---
      duration_ms: 1201.325554
      type: 'test'
      ...
    1..7
ok 192 - worktrees
  ---
  duration_ms: 7835.061309
  type: 'suite'
  ...
# Subtest: non-object and odd WebSocket frames leave the server running (AUDIT \#33)
ok 193 - non-object and odd WebSocket frames leave the server running (AUDIT \#33)
  ---
  duration_ms: 1851.36143
  type: 'test'
  ...
1..193
# tests 217
# suites 11
# pass 169
# fail 48
# cancelled 0
# skipped 0
# todo 0
# duration_ms 282490.160416

## Result — done (check passed) (2026-09-27 12:21)

AGENT-ORCH-STATUS: done — merged latest main; npm test passes 256/256 with checkpoint tests
