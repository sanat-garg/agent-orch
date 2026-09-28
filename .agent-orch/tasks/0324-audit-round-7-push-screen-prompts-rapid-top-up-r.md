# Task #324: AUDIT round 7: push, screen prompts, rapid top-up, retention GC, worktree sweep, the verifier and agent-share

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:34  
- files: .agent-orch/AUDIT.md

## Prompt

Add 'Round 7' to .agent-orch/AUDIT.md (same format as Round 6: a numbered heading per finding continuing from #52, severity, What, Failure, Fix, with file:line anchors). Audit only by reading code and running small ad-hoc node snippets or the touched tests; change no source files. Scope, in this order: push.mjs and the `/api/push/*` routes plus server.mjs `notify` and orchestrator.mjs `notifyOwner` (subscription validation, key file permissions, what a compromised subscription endpoint learns, rate limiting, pushes for tasks of paused/deleted projects, payload contents leaking task titles); browser-task.mjs and `POST /api/browser/task` / `listBrowserTasks` / `stopBrowserTask` in orchestrator.mjs (input caps, identity/node validation, what happens when the profile is taken over or the worker vanishes, the failure heuristics in `browserTaskStatus`); the rapid-mode top-up in orchestrator.mjs (quota guards, runaway reflection loops, ready-depth counting with cancelled/failed prerequisites); retention.mjs (media referenced only by approvals or push, run logs of needs_integration tasks, clock skew); worktrees.mjs orphan sweep (a worktree of a running task on a worker, symlinked node_modules, paths with spaces); taskrun.mjs's Done-when verifier (`CMD_START`/refusal regex bypasses such as `$(...)`, backticks inside words, `;`, `||`, env prefixes); agent-share.mjs beyond #46. Aim for 10-16 real findings with concrete failure scenarios; skip anything already listed in Rounds 1-6 unless it regressed. Finish with a short prioritised summary at the end of the round.

## Done when

`grep -n '^## Round 7' .agent-orch/AUDIT.md` prints a line and `grep -c '^### 5[3-9]\.\|^### 6[0-9]\.' .agent-orch/AUDIT.md` prints a number of at least 8

## Result — done (check passed) (2026-09-28 11:52)

AGENT-ORCH-STATUS: done — AUDIT.md Round 7 adds 15 findings (#53–#67), priorities included
