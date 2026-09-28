# Task #423: CLUSTER.md docs: Scheduling and Local cap describe the real head-capacity and placement rules

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:14  
- starts after: #344  
- files: .agent-orch/CLUSTER.md

## Prompt

Goal: .agent-orch/CLUSTER.md's "Scheduling" section (and the head's-ceiling paragraph of "Local cap and status view") still describe the old design: slots from `memAvailable - footprint(agent)` headroom, Auto = min(cores, memory arithmetic), placement by most headroom. Since tasks #384 (head capacity from its real hardware, two reserved controller-only slots, work delegated to workers first) and #344 (placement uses every online machine, CPU-only gating, spread across nodes) the rules are different. Read the code, not the old text: parallel.mjs `headTarget`, `taskSlots`, `spreadAssign`; orchestrator.mjs `parallelSettings`, `headLoad`, `controllerOnly`, `nodeCap`, `place`, and the kv `parallel_settings` keys; cap.mjs `capSlots`/`capRejection` (the worker's own local cap still uses a per-agent footprint, which is fine to keep in the Local cap section); BRIEF.md goal 9 and its placement rule. Rewrite the Scheduling section and the head's-ceiling bullet so they state: how the head's work slots are chosen (owner setting 1-16 else headTarget from cores, re-detected), the reserved controller-only slots and what counts as controller-only, that memory is only an emergency guard (MEM.claimFloor / pauseBelow) and never a pre-emptive throttle, how a node's cap is computed (owner max tasks, the worker's own cap: CPU and max-tasks kept, RAM only as the worker's own guard), the placement order (every online machine, workers first, spread, only a CPU-saturated machine skipped, pins via run_on, plan/reflect/integrators local), and the two-phase offer if it still exists. Keep the section's length about the same and its style (terse bullets naming the functions). Leave every other section alone. This is a docs task: no code changes, no test suite.

## Done when

`grep -c "headTarget" .agent-orch/CLUSTER.md` prints at least 1 and `! grep -q "memAvailable - footprint(agent)" .agent-orch/CLUSTER.md`
