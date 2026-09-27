# Task #238: Integrate #222: Remote sign-in and per-machine agent status in Connections

- kind: work  
- source: planner  
- priority: 95 (normal)  
- created: 2026-09-27 14:32  
- files: connections.mjs, worker.mjs, cluster.mjs, public/app.js, public/app.css, test/cluster-login*.test.mjs

## Prompt

Task #222 ("Remote sign-in and per-machine agent status in Connections") finished in its own git worktree, but its branch `agent-orch/task-222` conflicts with `main`, which changed meanwhile (conflicting files: public/app.js, test/task-sound.test.mjs, test/ui-fallbacks.test.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #222's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #222's instructions were:

Let the owner sign agents in on worker machines from the web UI. The Connections modal gets a machine switcher (Controller / each node). For a remote node, Connect/Disconnect/model refresh are proxied over the cluster WebSocket as login.start/state/code/cancel messages: the worker runs the same connections.mjs tmux login specs locally (on macOS, check that tmux exists or install it via Homebrew instructions, else fall back to a pty via `script`) and streams the URL, code and prompts back, and the owner pastes codes that get forwarded. Status, account and models per node come from the node's inventory. Show clearly that limits are shared when the same account is signed in on several machines ('Same account as Controller: shares limits'). Tests with a fake worker: the login state round-trip and code forwarding.

## Done when

`npm test` passes with the remote login round-trip test, and the Connections modal renders a machine switcher when nodes exist

## Result — verify failed (1) (2026-09-27 15:00)

Command: npm test


  ---
  duration_ms: 132.319115
  type: 'test'
  ...
# Subtest: pause pushes WIP and keeps the worktree, resume finishes the job, cancel drops it
ok 281 - pause pushes WIP and keeps the worktree, resume finishes the job, cancel drops it
  ---
  duration_ms: 1982.75435
  type: 'test'
  ...
# error: could not apply 06e2d01... mine
# hint: Resolve all conflicts manually, mark them as resolved with
# hint: "git add/rm <conflicted_files>", then run "git rebase --continue".
# hint: You can instead skip this commit: run "git rebase --skip".
# hint: To abort and get back to the state before "git rebase", run "git rebase --abort".
# hint: Disable this message with "git config set advice.mergeConflict false"
# Could not apply 06e2d01... \# mine
# Subtest: worktrees
    # Subtest: two concurrent tasks editing different files both merge, and their worktrees are cleaned up
    ok 1 - two concurrent tasks editing different files both merge, and their worktrees are cleaned up
      ---
      duration_ms: 11271.796259
      type: 'test'
      ...
    # Subtest: two tasks editing the same line: the second needs integration, and its integrator merges it
    ok 2 - two tasks editing the same line: the second needs integration, and its integrator merges it
      ---
      duration_ms: 12419.922528
      type: 'test'
      ...
    # Subtest: boot keeps an interrupted task's worktree for reuse and parks an orphaned one on its branch
    ok 3 - boot keeps an interrupted task's worktree for reuse and parks an orphaned one on its branch
      ---
      duration_ms: 12003.16243
      type: 'test'
      ...
    # Subtest: a detached-HEAD worktree is re-attached to its branch with its uncommitted work, not deleted
    ok 4 - a detached-HEAD worktree is re-attached to its branch with its uncommitted work, not deleted
      ---
      duration_ms: 5413.757402
      type: 'test'
      ...
    # Subtest: mergeBack reports a conflict without touching main
    ok 5 - mergeBack reports a conflict without touching main
      ---
      duration_ms: 5027.77884
      type: 'test'
      ...
    # Subtest: a setext ======= heading merged in from main is not an unresolved conflict
    ok 6 - a setext ======= heading merged in from main is not an unresolved conflict
      ---
      duration_ms: 3983.367323
      type: 'test'
      ...
    # Subtest: a real integration conflict stays unresolved until its markers are removed
    ok 7 - a real integration conflict stays unresolved until its markers are removed
      ---
      duration_ms: 4034.448894
      type: 'test'
      ...
    1..7
ok 282 - worktrees
  ---
  duration_ms: 12474.877322
  type: 'suite'
  ...
# Subtest: non-object and odd WebSocket frames leave the server running (AUDIT \#33)
ok 283 - non-object and odd WebSocket frames leave the server running (AUDIT \#33)
  ---
  duration_ms: 1911.694225
  type: 'test'
  ...
1..283
# tests 310
# suites 12
# pass 309
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 369375.322841

## Result — done (check passed) (2026-09-27 15:16)

AGENT-ORCH-STATUS: done — npm test passes 310/310, merge conflicts resolved
