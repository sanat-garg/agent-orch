# Task #234: Worker terminal status view and a local cap on pooled CPU/RAM

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 12:53  
- starts after: #232, #229  
- files: worker.mjs, cluster.mjs, orchestrator.mjs, bin/install-worker-macos.sh, bin/install-worker.sh, test/worker-cap*.test.mjs, test/worker-status*.test.mjs

## Prompt

Two worker-side features (BRIEF goal 11; this replaces the cancelled web status page #233, so don't build any web page or listening port for status). 1) `node worker.mjs status`: a live-updating terminal view (plain ANSI, no deps, refreshing every 1 s, exit on q/Ctrl-C) for Macs and VPSs alike. It shows the machine name, the connection to the head (Connected/Reconnecting/Offline), the contribution cap in effect, CPU/RAM used by agent-orch jobs vs the cap (text bars), one line per running job (#id title truncated, agent·model, phase, elapsed, last activity), the count of jobs up next from the head, and the last 5 finished (outcome, duration). It reads state from the running worker daemon over a local unix socket (~/.agent-orch-worker/worker.sock, 0600), not a TCP port. Add `--once` for a single snapshot. The macOS installer prints how to open it, and optionally adds a Terminal login item running it. 2) The local contribution cap: `node worker.mjs limit --cpu <cores or %> --mem <GB or %> [--max-tasks N] [--only-on-ac]` and `node worker.mjs limit --show/--reset`. It's saved in ~/.agent-orch-worker/config.json and applied live (the daemon reloads it via the socket and reports it in inventory/heartbeats). The head MUST treat it as a hard ceiling: node slots = min(the head's own setting, local max-tasks, what fits in (local mem cap − the memory used by running jobs) / the agent's p90 footprint, and (local cpu cap / 1 core per task, or the measured per-agent CPU)). The worker also enforces it itself: it rejects job.offer when accepting would exceed the cap, and runs agent processes under the cap where the OS allows it (Linux: a systemd-run --scope with CPUQuota/MemoryMax per job, or cgroup v2; macOS: `taskpolicy -b` or a nice level for background, plus a memory watch that pauses the newest job if the cap is exceeded for 30 s). This is the ONE local setting allowed, and it amends #232's 'no local command changes behaviour' rule. The head's Machines view shows 'Pooled: 4 cores · 8 GB (set on this Mac)'. Tests: the cap parsing, the head slot computation honouring the local cap, the worker rejecting an offer over the cap, and the status socket snapshot.

## Done when

`npm test` passes with local-cap and status-socket tests, and `node worker.mjs status --once` against a test worker prints the connection state, cap and running job line

## Result — verify failed (1) (2026-09-27 22:44)

Command: npm test && node worker.mjs status --once

ed
  ---
  duration_ms: 88.318376
  type: 'test'
  ...
# Subtest: pause pushes WIP and keeps the worktree, resume finishes the job, cancel drops it
ok 382 - pause pushes WIP and keeps the worktree, resume finishes the job, cancel drops it
  ---
  duration_ms: 1271.668064
  type: 'test'
  ...
# error: could not apply bee35fb... mine
# hint: Resolve all conflicts manually, mark them as resolved with
# hint: "git add/rm <conflicted_files>", then run "git rebase --continue".
# hint: You can instead skip this commit: run "git rebase --skip".
# hint: To abort and get back to the state before "git rebase", run "git rebase --abort".
# hint: Disable this message with "git config set advice.mergeConflict false"
# Could not apply bee35fb... \# mine
# Subtest: worktrees
    # Subtest: two concurrent tasks editing different files both merge, and their worktrees are cleaned up
    ok 1 - two concurrent tasks editing different files both merge, and their worktrees are cleaned up
      ---
      duration_ms: 7105.766403
      type: 'test'
      ...
    # Subtest: two tasks editing the same line: the second needs integration, and its integrator merges it
    ok 2 - two tasks editing the same line: the second needs integration, and its integrator merges it
      ---
      duration_ms: 8269.144619
      type: 'test'
      ...
    # Subtest: boot keeps an interrupted task's worktree for reuse and parks an orphaned one on its branch
    ok 3 - boot keeps an interrupted task's worktree for reuse and parks an orphaned one on its branch
      ---
      duration_ms: 7218.315595
      type: 'test'
      ...
    # Subtest: a detached-HEAD worktree is re-attached to its branch with its uncommitted work, not deleted
    ok 4 - a detached-HEAD worktree is re-attached to its branch with its uncommitted work, not deleted
      ---
      duration_ms: 1977.978113
      type: 'test'
      ...
    # Subtest: mergeBack reports a conflict without touching main
    ok 5 - mergeBack reports a conflict without touching main
      ---
      duration_ms: 1707.113231
      type: 'test'
      ...
    # Subtest: a setext ======= heading merged in from main is not an unresolved conflict
    ok 6 - a setext ======= heading merged in from main is not an unresolved conflict
      ---
      duration_ms: 1143.315464
      type: 'test'
      ...
    # Subtest: a real integration conflict stays unresolved until its markers are removed
    ok 7 - a real integration conflict stays unresolved until its markers are removed
      ---
      duration_ms: 1414.914589
      type: 'test'
      ...
    1..7
ok 383 - worktrees
  ---
  duration_ms: 8298.747546
  type: 'suite'
  ...
# Subtest: non-object and odd WebSocket frames leave the server running (AUDIT \#33)
ok 384 - non-object and odd WebSocket frames leave the server running (AUDIT \#33)
  ---
  duration_ms: 1902.879371
  type: 'test'
  ...
1..384
# tests 411
# suites 12
# pass 410
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 395547.317574

## Result — done (check passed) (2026-09-27 23:00)

AGENT-ORCH-STATUS: done — full test suite passes; worker status view and local cap verified
