# Task #2274: Download a schedule run's retained output, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:35  
- files: public/schedules.js, public/schedules.css, test/ui-schedule-output-download.test.mjs

## Prompt

Add Download output to each command-run entry rendered by runs() in public/schedules.js, with scoped public/schedules.css styling. Use the already-loaded /api/orch/schedules/:id/runs data to create a UTF-8 text download containing schedule title, run ID, start time, status/exit code when available, then the exact retained output. Choose a safe filename containing schedule/run IDs. Label a running run's output as a snapshot and make clear that this exports retained output. Empty output still produces an identified report; a failed API load must show its error and offer no bogus download. Keep schedule creation, copying, Run now and backend behavior unchanged. Inspiration: [winfunc/opcode](https://github.com/winfunc/opcode)'s accessible execution logs, adapted to sharing scheduled-job results. Add test/ui-schedule-output-download.test.mjs verifying report bytes and filename, empty output, running snapshot labeling, API failure and phone usability. No new endpoint or dependency is needed.

## Done when

`npm test -- test/ui-schedule-output-download.test.mjs` passes.

## Result — verify failed (1) (2026-10-19 15:42)

Command: npm test -- test/ui-schedule-output-download.test.mjs

t (node:internal/timers:585:17)
    process.processTimers (node:internal/timers:521:7)
  ...
# Subtest: a run with no output still downloads an identified report
not ok 2 - a run with no output still downloads an identified report
  ---
  duration_ms: 135.18315
  type: 'test'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2274/test/ui-schedule-output-download.test.mjs:131:1'
  failureType: 'hookFailed'
  error: |-
    server did not start:
    [push] made a new VAPID key pair
    
  code: 'ERR_TEST_FAILURE'
  stack: |-
    Timeout._onTimeout (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-2274/test/ui-schedule-output-download.test.mjs:64:43)
    listOnTimeout (node:internal/timers:585:17)
    process.processTimers (node:internal/timers:521:7)
  ...
# Subtest: a running run's download is labelled a snapshot
not ok 3 - a running run's download is labelled a snapshot
  ---
  duration_ms: 0.131801
  type: 'test'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2274/test/ui-schedule-output-download.test.mjs:145:1'
  failureType: 'hookFailed'
  error: |-
    server did not start:
    [push] made a new VAPID key pair
    
  code: 'ERR_TEST_FAILURE'
  stack: |-
    Timeout._onTimeout (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-2274/test/ui-schedule-output-download.test.mjs:64:43)
    listOnTimeout (node:internal/timers:585:17)
    process.processTimers (node:internal/timers:521:7)
  ...
# Subtest: a failed runs load shows its error and offers no download
not ok 4 - a failed runs load shows its error and offers no download
  ---
  duration_ms: 0.301682
  type: 'test'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2274/test/ui-schedule-output-download.test.mjs:163:1'
  failureType: 'hookFailed'
  error: |-
    server did not start:
    [push] made a new VAPID key pair
    
  code: 'ERR_TEST_FAILURE'
  stack: |-
    Timeout._onTimeout (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-2274/test/ui-schedule-output-download.test.mjs:64:43)
    listOnTimeout (node:internal/timers:585:17)
    process.processTimers (node:internal/timers:521:7)
  ...
# Subtest: on a phone the button is a full touch target inside the sheet and still downloads
not ok 5 - on a phone the button is a full touch target inside the sheet and still downloads
  ---
  duration_ms: 0.105801
  type: 'test'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2274/test/ui-schedule-output-download.test.mjs:179:1'
  failureType: 'hookFailed'
  error: |-
    server did not start:
    [push] made a new VAPID key pair
    
  code: 'ERR_TEST_FAILURE'
  stack: |-
    Timeout._onTimeout (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-2274/test/ui-schedule-output-download.test.mjs:64:43)
    listOnTimeout (node:internal/timers:585:17)
    process.processTimers (node:internal/timers:521:7)
  ...
1..5
# tests 5
# suites 0
# pass 0
# fail 5
# cancelled 0
# skipped 0
# todo 0
# duration_ms 65954.634178

## Result — done (check passed) (2026-10-19 16:16)

AGENT-ORCH-STATUS: done — run output downloads verified; test now tolerates slow server boot
