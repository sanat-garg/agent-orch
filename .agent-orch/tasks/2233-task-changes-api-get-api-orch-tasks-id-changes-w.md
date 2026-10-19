# Task #2233: Task changes API: GET /api/orch/tasks/:id/changes with tests

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:11  
- files: server.mjs, test/task-changes-api.test.mjs

## Prompt

changes.mjs already computes what a task changed (`taskChanges(info, id, {maxBytes})` → {source: 'branch'|'commit'|'none', commits, files: [{path, add, del, binary}], patch, truncated}; see its header comment and test/changes.test.mjs) but nothing serves it. Add a route in server.mjs next to the other per-task routes (the `/^\/api\/orch\/tasks\/(\d+)\/actions$/` GET block, ~line 2530): GET /api/orch/tasks/:id/changes → 404 {error:'No such task'} for an unknown id; otherwise resolve the task's project repo the same way changes.mjs's tests build `info` ({top, branch} of the project's main tree; look at how orchestrator.mjs/worktrees.mjs find a project's repo dir and branch) and return taskChanges' result as JSON. Optional `?max=` (bytes, clamp to 20 KB..1 MB, default 200 KB). Apply the same access rules as the neighbouring task routes: a non-admin may only read tasks of projects they own, and check server.mjs `userBlocked`'s allowlist. A git failure is a 500 with a readable {error}. Write test/task-changes-api.test.mjs: spawn server.mjs on a free port with a temp CW_DATA_DIR, as neighbouring server tests do (never import server.mjs), make a project with a merged task commit 'agent-orch #<id>: …', and assert the files/patch come back. Add one test that an unknown task id gets a 404.

## Done when

`npm test -- test/task-changes-api.test.mjs test/changes.test.mjs` passes.

## Result — done (check passed) (2026-10-19 14:14)

AGENT-ORCH-STATUS: done — GET /api/orch/tasks/:id/changes serves taskChanges; tests pass
