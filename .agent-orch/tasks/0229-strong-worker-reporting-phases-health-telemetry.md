# Task #229: Strong worker reporting: phases, health telemetry, crash reports, auto-drain

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 12:46  
- starts after: #220  
- files: worker.mjs, cluster.mjs, cluster-protocol.mjs, resources.mjs, server.mjs, test/cluster-telemetry*.test.mjs

## Prompt

Make workers report richly to the head (controller). 1) Job phases: the worker sends job.phase messages as work moves through queued → cloning/fetching → installing deps → running agent → checking → committing → pushing → done, each with a timestamp and duration, plus progress hints (for example the number of tool calls so far, files changed and the last tool line). Store them per run and show them in the task drawer as a compact timeline. 2) Health telemetry every 10 s: CPU% per core, load, MemAvailable, swap, disk free on the repo volume, network reachability to GitHub, the agent CLIs' versions and sign-in states, running job ids, uptime, the worker version and the git sha. On macOS also battery % / charging and thermal pressure. Store a rolling 24 h time series per node in <DATA>/metrics/nodes/<id>.jsonl (compacted), and serve GET /api/cluster/nodes/:id/metrics?range=. 3) Errors: worker exceptions, crashed agent processes and failed installs are sent as structured job.error/node.error with a stack or stderr tail, and GET /api/cluster/nodes/:id/logs?tail=200 fetches the worker's log tail on demand over the socket. 4) Auto-health: a node with 3 failed jobs in 30 min that the other nodes don't reproduce, disk under 2 GB, or failing heartbeats gets auto-drained, with an owner notice. 5) The worker version check: a worker whose agent-orch sha lags the controller's origin/main by more than N commits reports 'outdated', and the controller can send node.update (git pull and restart the service) when it's idle. Tests with a fake worker: the phase timeline is stored, telemetry is compacted, the log tail round-trip works, auto-drain triggers on repeated failures, and the update command runs only when idle.

## Done when

`npm test` passes with worker phase/telemetry/log-tail/auto-drain/update tests

## Result — done (check passed) (2026-09-27 19:32)

AGENT-ORCH-STATUS: done — worker phases, telemetry, errors, log tail, auto-drain, updates; tests pass
