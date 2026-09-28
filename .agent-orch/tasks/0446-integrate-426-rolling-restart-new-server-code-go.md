# Task #446: Integrate #426: Rolling restart: new server code goes live within minutes, even when busy

- kind: work  
- source: planner  
- priority: 95 (normal)  
- created: 2026-09-28 14:40  
- files: server.mjs, orchestrator.mjs, restart.mjs, public/app.js, test/rolling-restart*.test.mjs

## Prompt

Task #426 ("Rolling restart: new server code goes live within minutes, even when busy") finished in its own git worktree, but its branch `agent-orch/task-426` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md, orchestrator.mjs, public/app.js, server.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #426's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #426's instructions were:

In rapid mode the head never goes idle, so auto-restart-once-idle (#280/#281, the restart drain #293) never fires. On 2026-09-28 the server had run since 13:50 while 31 commits landed (including #384's head capacity and #378's overlap rule), so the fixes weren't live and delegation stalled. Implement rolling restarts in server.mjs/orchestrator.mjs (plus the restart helpers): 1) When new server-side code lands on main (any *.mjs outside test/ or public/ changed since the running build; public/ changes need no restart, just a client reload notice) and auto-restart is on, schedule a restart within 2 min, not 'when idle'. 2) Before exiting: preflight the new HEAD (existing #293 check: `node --check` for every server module, plus a quick boot test in a temp CW_DATA_DIR with CW_NO_ORCHESTRATOR=1); refuse and alert if it fails. Pause head-local running tasks gracefully (keep session and worktree; they resume automatically after boot, as pause/resume do). Do NOT touch worker-run jobs: workers keep running and re-attach (#220 re-adoption), and verify that path. Let an in-flight merge finish, and let a planner/chat turn in flight finish (up to 60 s). Then exit so systemd restarts it. 3) After boot: resume the paused head tasks, re-adopt worker jobs, and toast clients 'Updated to vX.YY'. Limit it to at most one rolling restart per 10 min (coalescing commits), and skip it while an integrator is mid-merge. 4) Settings: the Auto-restart option becomes 'Apply updates: Automatically within 2 min (default) / When idle / Manually', and the updates banner has 'Restart now'. 5) Tests: a code change triggers a scheduled restart even with running tasks; head tasks are paused and resumed across a simulated restart; worker jobs are left alone; a failing preflight blocks the restart; the coalescing window holds. Run only the touched test files.

## Done when

`node --test test/rolling-restart*.test.mjs` passes (restart scheduled while busy, head tasks paused/resumed, worker jobs untouched, preflight failure blocks, coalescing)

## Result — done (check passed) (2026-09-28 14:42)

AGENT-ORCH-STATUS: done — merge conflicts resolved; rolling-restart, version, and UI tests pass
