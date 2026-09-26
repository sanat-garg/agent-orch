# Task #166: Parallel e2e: prove two file-disjoint tasks run concurrently and both merge

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 09:57  
- files: bin/orch-e2e.mjs, .agent-orch/PARALLEL-E2E.md

## Prompt

bin/orch-e2e.mjs runs one real orchestrator task on a throwaway server and scratch project (see its header). Add a `--parallel` mode: queue two work tasks with disjoint `files` (e.g. one creates a.mjs + test/a.test.mjs, the other b.mjs + test/b.test.mjs), no `after`, then assert from the task views/DB that (1) their started/finished intervals overlap, (2) each ran in its own worktree under ../.agent-orch-worktrees, (3) both are done and both changes are on main in the scratch repo and pushed to its bare origin, (4) no worktrees or agent-orch/task-* branches remain. Print a clear summary including 'overlap: yes|no'. Keep existing single-task behaviour unchanged. Run it once with `node bin/orch-e2e.mjs --parallel --agent claude --model <cheapest listed Claude model>` (use a temp CW_DATA_DIR and spare port as the script already does; never touch port 3000). If it reveals a scheduler or merge bug, record it rather than fixing orchestrator.mjs here. Write the command, the output summary and any bug found to .agent-orch/PARALLEL-E2E.md.

## Done when

`grep -q 'overlap: yes' .agent-orch/PARALLEL-E2E.md`

## Result — done (check passed) (2026-09-26 09:59)

AGENT-ORCH-STATUS: done — parallel e2e passed live on haiku: tasks overlapped, both merged
