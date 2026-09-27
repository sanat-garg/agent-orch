# Task #219: Scheduler: place tasks on remote nodes and merge their pushed branches

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 11:58  
- starts after: #217, #218  
- files: orchestrator.mjs, cluster.mjs, test/cluster-e2e*.test.mjs

## Prompt

Wire remote execution into orchestrator.mjs using cluster.mjs (the hub) and worker.mjs (the daemon). 1) Placement: when claiming a task, pick a node among online, enabled, non-draining nodes that have the task's agent installed and signed in (per inventory) and enough headroom (the node's MemAvailable minus the agent's p90 footprint from #209 is at least its safety floor, and the node's running count is under max_slots). Prefer nodes with the most headroom, and keep the controller for chat/planner work when workers are available (configurable). Total parallelism is the sum over nodes, with owner caps in settings. 2) Dispatch: for a remote node, send job.start with the task prompt/system/agent/model, the project's GitHub repo URL (the project must have a GitHub remote; else local only), the base sha (current main HEAD, pushed first if needed) and the branch name. Mirror job.event into the normal run log and WebSocket so the UI shows remote runs exactly like local ones (plus a node label). 3) Completion: on job.done, fetch agent-orch/task-<id> from origin into the controller's repo and run the EXISTING merge-back path (rebase onto main, fast-forward, push, needs_integration on conflict). Record node_id on runs and tasks. 4) Usage/limit records from remote runs feed usage.mjs as usual (same account → shared limits). 5) A 'local' fallback: with no workers online, behave exactly as today. E2E test: a test server (CW_DATA_DIR temp) plus a worker.mjs process on the same machine using a separate home dir and a temp bare repo as origin and a stub agent: two tasks, one placed on the worker and one local, both merged into main.

## Done when

`npm test` passes with a cluster e2e test in which a task runs on a paired local worker process and its branch is merged into main by the controller
