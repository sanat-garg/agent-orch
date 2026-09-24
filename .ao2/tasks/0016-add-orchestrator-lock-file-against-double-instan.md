# Task #16: Add orchestrator lock file against double instances (AUDIT #2)

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-24 23:37  
- starts after: #15

## Prompt

Fix AUDIT.md item #2 in /home/ubuntu/claude-web/orchestrator.mjs. At startup (~line 1556) the orchestrator requeues every 'running' task and starts a scheduler, so a second server started on the same data dir steals and double-runs the live instance's tasks. In createOrchestrator, take an exclusive lock file at <data dir>/orchestrator/lock containing the PID. If the file exists and `process.kill(pid, 0)` shows that process is alive (and it isn't our own PID), log a warning and skip both the orphan requeue and the scheduler (the orchestrator stays read-only/inert). Otherwise write our PID, and remove the file on exit if it still holds our PID. Use an atomic create (fs.openSync with 'wx') and handle stale locks. Add a test in test/ that starts two server instances on the same temp CW_DATA_DIR and checks that the second one logs the lock warning, or test createOrchestrator directly if that's simpler. IMPORTANT: always use a temp CW_DATA_DIR in tests. Never touch the live data/ directory or restart the live server. Mention in README.md that test instances must set CW_DATA_DIR. Mark #2 as **Fixed** in .ao2/AUDIT.md.

## Done when

`npm test` passes and includes a test proving that a second orchestrator on the same data dir does not schedule tasks

## Result — done (check passed) (2026-09-24 23:51)

AO2-STATUS: done — Rename already committed; grep and all 12 tests pass
