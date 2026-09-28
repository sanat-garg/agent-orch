# Task #248: Land worker skills/subagents/MCP sync from branch claude/heuristic-visvesvaraya-d78c0d

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-28 01:13  
- files: cluster-protocol.mjs, cluster.mjs, extensions.mjs, worker.mjs, server.mjs, orchestrator.mjs, README.md, .agent-orch/CLUSTER.md, .agent-orch/CONTEXT.md, test/ext-sync.test.mjs, test/worker.test.mjs, test/cluster.test.mjs, test/cluster-protocol.test.mjs, test/cluster-e2e.test.mjs, test/fixtures/cluster-controller.mjs, test/fixtures/worker-agent-stub.mjs

## Prompt

Local branch `claude/heuristic-visvesvaraya-d78c0d` (one commit, 'Cluster workers get the controller's skills, subagents and MCP servers', based 6 commits behind main) implements the remaining cluster gap: the head ships the owner's skills, subagents and MCP servers to a worker with each job (extensions.mjs export/import, cluster-protocol.mjs feature + frame, cluster.mjs, worker.mjs writes them into its own home before the run; tests in test/ext-sync.test.mjs, test/worker.test.mjs, test/cluster*.test.mjs). Land it on main: in your worktree run `git merge claude/heuristic-visvesvaraya-d78c0d` (or cherry-pick aae07b1). Expected conflicts: cluster-protocol.mjs, cluster.mjs (main added FEATURES/WORKER_ACCEPTS entries, health and power frames since), README.md, .agent-orch/CLUSTER.md, .agent-orch/CONTEXT.md. Resolve by keeping BOTH sides' additions in code and docs; for CONTEXT.md keep main's text and only change the sentence 'Remote workers get the persona only (…)' to say workers now receive skills, subagents and MCP servers with each job. Make sure the new frame type is listed in FEATURES and WORKER_ACCEPTS the way the other frames are, and that test/compute-only.test.mjs still passes (worker.mjs must not import server/orchestrator/cluster). Run `node --test test/ext-sync.test.mjs test/worker.test.mjs test/cluster.test.mjs test/cluster-protocol.test.mjs test/compute-only.test.mjs` with TMPDIR on the home disk, then the full `npm test`. Append a JOURNAL.md line.

## Done when

`test -f test/ext-sync.test.mjs` and `npm test` passes
