# Task #228: Cluster max-parallel mode: fill every node's headroom, keep the head light

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 12:46  
- starts after: #220, #209  
- files: orchestrator.mjs, cluster.mjs, test/cluster-maxparallel*.test.mjs

## Prompt

Once the cluster works (#219-#220) and adaptive slots exist (#209), let parallelism scale to whatever the whole cluster can take (BRIEF goals 9 and 11). 1) Slots per node come from that node's measured headroom only (its CPU cores and load, MemAvailable minus the p90 footprint per agent, the safety floor, disk space). There's no global cap in the new default 'Max' mode (settings: Max / a custom N). Every node's reported resources are re-evaluated before each claim. 2) Head protection: when workers are online, the controller VPS runs NO work tasks by default (only planner/chat/merges), with a setting to allow it. The controller's own load is watched, and if merging or streaming makes its CPU exceed 80% for 60 s, the event batching gets coarser and claims throttle. 3) Merge throughput: a serialized merge queue per project with fast-forward when possible, a batched fetch, and conflicts routed to integrator tasks without blocking the queue. Measure the merge latency. 4) Planner prompt: when the cluster has more than 1 free slot, split multi-part work into file-disjoint parallel tasks (declare 'files'), spread over the agents/models in the owner's fallback list, with an integrator task using after:[parts]. On a single machine, keep sequential chains. Put the live cluster capacity ('3 machines, 7 free slots') in the planner context. 5) Account limits: several machines on the same account share limits, so if an account's 5 h window is above ~85%, don't start more parallel tasks on it than needed and spread to other agents or accounts. Tests with fake nodes: slots scale with nodes; the head runs no work tasks when workers are online; the merge queue handles 6 concurrent finishing tasks in order with one conflict routed to an integrator; the planner context shows capacity.

## Done when

`npm test` passes with max-parallel tests (per-node slots, head-protection, 6-way merge queue with one conflict, planner capacity context)
