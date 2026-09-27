# Task #220: Node failure handling: disconnects, laptop sleep, WIP recovery and reassignment

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 11:58  
- starts after: #219  
- files: orchestrator.mjs, cluster.mjs, worker.mjs, test/cluster-failover*.test.mjs

## Prompt

Make remote execution robust (per the Failure modes section of .agent-orch/CLUSTER.md). 1) When a node goes offline with running tasks, mark them 'waiting for <node>' and start a grace timer (Mac/laptop 5 min, VPS 2 min, configurable per node). If the node reconnects in time, reconcile: the worker reports its in-flight jobs and resumes streaming (it must keep running through controller-side disconnects, buffer events locally and replay them on reconnect with sequence numbers, so nothing is lost or duplicated). 2) After the grace period, reassign to another node or local from the latest pushed WIP branch: the new run starts on agent-orch/task-<id> at the WIP sha with a handoff prompt (the original prompt, done_when, the previous agent's last messages and tool summary, and the git diff stat) and continues there. When the old node returns, it's told to cancel and discard that job. 3) Controller restart: workers keep running jobs, and on reconnect the controller re-adopts them from its DB. 4) Draining a node: it finishes current jobs and takes no new ones. Disabling one: its tasks move now, as in step 2. 5) The macOS worker detects sleep/wake (a time jump) and reports it, and the controller shows 'Mac asleep'. Tests: simulated disconnect with reconnect inside the grace period (the stream resumes without duplicates), reassignment after the grace period from the WIP sha, the controller restart re-adopting, and drain.

## Done when

`npm test` passes with reconnect-within-grace, reassign-after-grace-from-WIP, controller-restart re-adopt and drain tests

## Result — done (check passed) (2026-09-27 13:37)

Waiting for the full `npm test` run to finish.
