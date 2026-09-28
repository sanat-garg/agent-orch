# Task #422: retention.mjs AUDIT #63 (head half): sweep finished screen-prompt workspaces under browser-tasks/

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:14  
- files: retention.mjs, test/retention.test.mjs

## Prompt

Goal: AUDIT #63 says screen-prompt workspaces are never deleted. On the head each browser task (execution='browser') runs in `<dataDir>/orchestrator/browser-tasks/<task id>` (orchestrator.mjs builds it as path.join(dir, 'browser-tasks', String(task.id)) with dir = path.join(dataDir, 'orchestrator'); read-only check, do not edit orchestrator.mjs) with Playwright's screenshots in `.agent-orch/shots/` inside it; the images are already copied into the media store, so these are duplicates. Extend `gcRetention({dataDir, runsDir, db, now, runDays, mediaDays})` in retention.mjs (it already runs daily from orchestrator.mjs `retentionGc` with the DB, so no wiring is needed) with a `browserDir` option defaulting to path.join(dataDir, 'orchestrator', 'browser-tasks'): every entry whose name is a task id is removed when the DB says the task is done/failed/cancelled (any age) or has no row; a live task's workspace (queued/running/needs_integration/awaiting_review or any other status) always stays; with no DB, remove only entries whose mtime is older than runDays. Names that are not plain integers are left alone. Count them in the result as `browserTasks` and add their bytes to `bytes`; stay synchronous and never throw per entry. Update the header comment. Tests in test/retention.test.mjs following its fake data dir setup: a finished task's workspace goes, a running one stays, an unknown id goes, a non-numeric dir stays, and the counts are right.

## Done when

`npm test -- test/retention.test.mjs` passes and `grep -c "browserTasks" retention.mjs` prints at least 1
