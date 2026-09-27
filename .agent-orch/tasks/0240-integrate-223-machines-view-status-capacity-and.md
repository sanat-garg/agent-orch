# Task #240: Integrate #223: Machines view: status, capacity and running tasks per machine

- kind: work  
- source: planner  
- priority: 95 (normal)  
- created: 2026-09-27 15:57  
- files: public/app.js, public/app.css, public/index.html, test/ui-machines*.test.mjs

## Prompt

Task #223 ("Machines view: status, capacity and running tasks per machine") finished in its own git worktree, but its branch `agent-orch/task-223` conflicts with `main`, which changed meanwhile (conflicting files: orchestrator.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #223's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #223's instructions were:

Add a 'Machines' section (in Server details, or its own sidebar entry next to Connections, whichever fits the current layout best; keep #orchBar minimal per CONTEXT.md). Show one card per node: the name, OS/arch icon (Linux/macOS), online/offline/asleep/draining state and last seen, CPU cores and load, RAM used/available with a bar, the agents signed in, running tasks (title, agent/model, elapsed; tap to open the drawer) and slots in use / max. Per-node controls: rename, max parallel tasks (Auto/1-4), Drain, Disable and Remove (revoke, with confirmation). Include a summary line: 'Cluster: 3 machines · 7 cores · 14.2 GB free · 4 of 6 slots running'. The lanes view in the Queue modal labels each lane with its machine. Live updates via the WebSocket. It must work at 390px. Screenshots via bin/shot.mjs with seeded fake nodes.

## Done when

`node --check public/app.js && npm test` passes, and a seeded UI test shows one machine card per node with a Drain control

## Result — verify failed (1) (2026-09-27 16:45)

Command: node --check public/app.js && npm test

led
  ---
  duration_ms: 85.158837
  type: 'test'
  ...
# Subtest: pause pushes WIP and keeps the worktree, resume finishes the job, cancel drops it
ok 295 - pause pushes WIP and keeps the worktree, resume finishes the job, cancel drops it
  ---
  duration_ms: 1384.372407
  type: 'test'
  ...
# error: could not apply f3aa227... mine
# hint: Resolve all conflicts manually, mark them as resolved with
# hint: "git add/rm <conflicted_files>", then run "git rebase --continue".
# hint: You can instead skip this commit: run "git rebase --skip".
# hint: To abort and get back to the state before "git rebase", run "git rebase --abort".
# hint: Disable this message with "git config set advice.mergeConflict false"
# Could not apply f3aa227... \# mine
# Subtest: worktrees
    # Subtest: two concurrent tasks editing different files both merge, and their worktrees are cleaned up
    ok 1 - two concurrent tasks editing different files both merge, and their worktrees are cleaned up
      ---
      duration_ms: 8597.112317
      type: 'test'
      ...
    # Subtest: two tasks editing the same line: the second needs integration, and its integrator merges it
    ok 2 - two tasks editing the same line: the second needs integration, and its integrator merges it
      ---
      duration_ms: 9857.520109
      type: 'test'
      ...
    # Subtest: boot keeps an interrupted task's worktree for reuse and parks an orphaned one on its branch
    ok 3 - boot keeps an interrupted task's worktree for reuse and parks an orphaned one on its branch
      ---
      duration_ms: 8393.338413
      type: 'test'
      ...
    # Subtest: a detached-HEAD worktree is re-attached to its branch with its uncommitted work, not deleted
    ok 4 - a detached-HEAD worktree is re-attached to its branch with its uncommitted work, not deleted
      ---
      duration_ms: 2527.557421
      type: 'test'
      ...
    # Subtest: mergeBack reports a conflict without touching main
    ok 5 - mergeBack reports a conflict without touching main
      ---
      duration_ms: 2156.51666
      type: 'test'
      ...
    # Subtest: a setext ======= heading merged in from main is not an unresolved conflict
    ok 6 - a setext ======= heading merged in from main is not an unresolved conflict
      ---
      duration_ms: 1463.693412
      type: 'test'
      ...
    # Subtest: a real integration conflict stays unresolved until its markers are removed
    ok 7 - a real integration conflict stays unresolved until its markers are removed
      ---
      duration_ms: 1725.587762
      type: 'test'
      ...
    1..7
ok 296 - worktrees
  ---
  duration_ms: 9915.583875
  type: 'suite'
  ...
# Subtest: non-object and odd WebSocket frames leave the server running (AUDIT \#33)
ok 297 - non-object and odd WebSocket frames leave the server running (AUDIT \#33)
  ---
  duration_ms: 3349.405313
  type: 'test'
  ...
1..297
# tests 324
# suites 12
# pass 323
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 332655.231655

## Result — done (check passed) (2026-09-27 17:34)

AGENT-ORCH-STATUS: done — Stale-node-cache race fixed; exact check passes 324/324

## Result — verify failed (2) (2026-09-27 17:34)

Command: merge main again

main changed meanwhile; conflicts in: public/ext.css, test/ui-static.test.mjs

## Result — verify failed (3) (2026-09-27 17:56)

Command: node --check public/app.js && npm test

iled
  ---
  duration_ms: 63.599243
  type: 'test'
  ...
# Subtest: pause pushes WIP and keeps the worktree, resume finishes the job, cancel drops it
ok 324 - pause pushes WIP and keeps the worktree, resume finishes the job, cancel drops it
  ---
  duration_ms: 1375.147124
  type: 'test'
  ...
# error: could not apply 17a48b9... mine
# hint: Resolve all conflicts manually, mark them as resolved with
# hint: "git add/rm <conflicted_files>", then run "git rebase --continue".
# hint: You can instead skip this commit: run "git rebase --skip".
# hint: To abort and get back to the state before "git rebase", run "git rebase --abort".
# hint: Disable this message with "git config set advice.mergeConflict false"
# Could not apply 17a48b9... \# mine
# Subtest: worktrees
    # Subtest: two concurrent tasks editing different files both merge, and their worktrees are cleaned up
    ok 1 - two concurrent tasks editing different files both merge, and their worktrees are cleaned up
      ---
      duration_ms: 7239.60354
      type: 'test'
      ...
    # Subtest: two tasks editing the same line: the second needs integration, and its integrator merges it
    ok 2 - two tasks editing the same line: the second needs integration, and its integrator merges it
      ---
      duration_ms: 8150.346975
      type: 'test'
      ...
    # Subtest: boot keeps an interrupted task's worktree for reuse and parks an orphaned one on its branch
    ok 3 - boot keeps an interrupted task's worktree for reuse and parks an orphaned one on its branch
      ---
      duration_ms: 7431.593035
      type: 'test'
      ...
    # Subtest: a detached-HEAD worktree is re-attached to its branch with its uncommitted work, not deleted
    ok 4 - a detached-HEAD worktree is re-attached to its branch with its uncommitted work, not deleted
      ---
      duration_ms: 2073.75659
      type: 'test'
      ...
    # Subtest: mergeBack reports a conflict without touching main
    ok 5 - mergeBack reports a conflict without touching main
      ---
      duration_ms: 1462.485183
      type: 'test'
      ...
    # Subtest: a setext ======= heading merged in from main is not an unresolved conflict
    ok 6 - a setext ======= heading merged in from main is not an unresolved conflict
      ---
      duration_ms: 1292.253972
      type: 'test'
      ...
    # Subtest: a real integration conflict stays unresolved until its markers are removed
    ok 7 - a real integration conflict stays unresolved until its markers are removed
      ---
      duration_ms: 1185.679884
      type: 'test'
      ...
    1..7
ok 325 - worktrees
  ---
  duration_ms: 8183.217963
  type: 'suite'
  ...
# Subtest: non-object and odd WebSocket frames leave the server running (AUDIT \#33)
ok 326 - non-object and odd WebSocket frames leave the server running (AUDIT \#33)
  ---
  duration_ms: 1950.533647
  type: 'test'
  ...
1..326
# tests 353
# suites 12
# pass 352
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 331054.234799

## Result — done (check passed) (2026-09-27 18:23)

AGENT-ORCH-STATUS: done — Merge resolved, tooltip race fixed, 353/353 tests pass
