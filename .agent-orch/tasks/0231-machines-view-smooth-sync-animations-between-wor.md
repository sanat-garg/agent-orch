# Task #231: Machines view: smooth sync animations between workers and the head

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-27 12:46  
- starts after: #229, #223  
- files: public/app.js, public/app.css, public/index.html, test/ui-cluster-anim*.test.mjs

## Prompt

Add polished, smooth animation to the Machines view (#223) using the telemetry and phases from the reporting task. 1) A cluster diagram: the head (controller) in the centre and worker nodes around it (a responsive radial layout on desktop, a vertical list on phones), with each node showing its name, OS icon, CPU/RAM ring gauges and running-task chips. 2) Live sync: every heartbeat gives a soft pulse on the node and its link. While a job streams events, small particles flow along the link from worker to head (throttled to the event rate, a max of ~6/s per link), and dispatch animates a task chip travelling head → worker. Completion animates the chip returning and merging into the head, with a brief check. Phase changes cross-fade on the chip ('installing' → 'running' → 'checking' → 'pushing'). Offline nodes fade to grey with a dashed link, asleep Macs show a moon, and draining nodes show an amber ring. 3) Performance: render with a single <canvas> or SVG with requestAnimationFrame, pause when hidden (document.hidden), cap at 60 fps, and avoid layout thrash. Respect prefers-reduced-motion (static state changes only). Colours come from the theme variables, in light and dark. 4) Tapping a node opens its detail (metrics charts from /api/cluster/nodes/:id/metrics, phases, and a 'View logs' button fetching the log tail). Take screenshots and a short screen capture (a Playwright video) with fake nodes emitting events, saved to .agent-orch/shots/.

## Done when

`node --check public/app.js && npm test` passes, and a seeded UI test with fake nodes renders the cluster diagram and animates a dispatch → merge cycle (the chip reaches the head)

## Result — verify failed (1) (2026-09-27 23:48)

Command: node --check public/app.js && npm test

failed
  ---
  duration_ms: 86.955997
  type: 'test'
  ...
# Subtest: pause pushes WIP and keeps the worktree, resume finishes the job, cancel drops it
ok 381 - pause pushes WIP and keeps the worktree, resume finishes the job, cancel drops it
  ---
  duration_ms: 1297.47707
  type: 'test'
  ...
# error: could not apply f580d62... mine
# hint: Resolve all conflicts manually, mark them as resolved with
# hint: "git add/rm <conflicted_files>", then run "git rebase --continue".
# hint: You can instead skip this commit: run "git rebase --skip".
# hint: To abort and get back to the state before "git rebase", run "git rebase --abort".
# hint: Disable this message with "git config set advice.mergeConflict false"
# Could not apply f580d62... \# mine
# Subtest: worktrees
    # Subtest: two concurrent tasks editing different files both merge, and their worktrees are cleaned up
    ok 1 - two concurrent tasks editing different files both merge, and their worktrees are cleaned up
      ---
      duration_ms: 7250.26425
      type: 'test'
      ...
    # Subtest: two tasks editing the same line: the second needs integration, and its integrator merges it
    ok 2 - two tasks editing the same line: the second needs integration, and its integrator merges it
      ---
      duration_ms: 8312.292229
      type: 'test'
      ...
    # Subtest: boot keeps an interrupted task's worktree for reuse and parks an orphaned one on its branch
    ok 3 - boot keeps an interrupted task's worktree for reuse and parks an orphaned one on its branch
      ---
      duration_ms: 7456.58202
      type: 'test'
      ...
    # Subtest: a detached-HEAD worktree is re-attached to its branch with its uncommitted work, not deleted
    ok 4 - a detached-HEAD worktree is re-attached to its branch with its uncommitted work, not deleted
      ---
      duration_ms: 2106.221141
      type: 'test'
      ...
    # Subtest: mergeBack reports a conflict without touching main
    ok 5 - mergeBack reports a conflict without touching main
      ---
      duration_ms: 1863.161609
      type: 'test'
      ...
    # Subtest: a setext ======= heading merged in from main is not an unresolved conflict
    ok 6 - a setext ======= heading merged in from main is not an unresolved conflict
      ---
      duration_ms: 1191.147007
      type: 'test'
      ...
    # Subtest: a real integration conflict stays unresolved until its markers are removed
    ok 7 - a real integration conflict stays unresolved until its markers are removed
      ---
      duration_ms: 1251.95434
      type: 'test'
      ...
    1..7
ok 382 - worktrees
  ---
  duration_ms: 8344.379365
  type: 'suite'
  ...
# Subtest: non-object and odd WebSocket frames leave the server running (AUDIT \#33)
ok 383 - non-object and odd WebSocket frames leave the server running (AUDIT \#33)
  ---
  duration_ms: 1979.069365
  type: 'test'
  ...
1..383
# tests 410
# suites 12
# pass 408
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 441135.763402

## Result — done (check passed) (2026-09-28 00:05)

AGENT-ORCH-STATUS: done — Branch on main; check passes 427/427 in worktree
