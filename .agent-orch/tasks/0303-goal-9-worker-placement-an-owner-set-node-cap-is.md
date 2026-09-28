# Task #303: Goal 9 worker placement: an owner-set node cap is the limit; no headroom or spare-memory clipping for capped nodes

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-28 10:55  
- files: orchestrator.mjs, test/cluster-capacity.test.mjs, .agent-orch/CLUSTER.md

## Prompt

BRIEF goal 9 (rewritten 2026-09-28): the owner states the MacBook handles 10 parallel tasks; owner-set per-machine caps are the limit and memory is only an emergency guard. In orchestrator.mjs' placement section (search 'const nodeCap =', 'freeWorkers', 'headroom', 'floorOf', 'spareMem'), a node with an owner cap (`n.maxSlots` set in Machines, 1-16) is still clipped: `nodeCap` takes min with `capSlots(localCap(n), …)` fed by memory footprints, and `freeWorkers` requires `headroom(n, agent) >= floorOf(n)` (MEM.claimFloor or the Mac power policy's 3 GB reserve), so a Mac with 10 as its cap gets a handful of Claude-sized runs. Change the rule: when `n.maxSlots` is set, the node's slots are `min(n.maxSlots, the worker's own hard ceiling from node worker.mjs limit --max-tasks if it reported one)` with no footprint/spare-memory arithmetic, and `freeWorkers` admits it unless its last reported MemAvailable (`n.resources.memAvailable`) is below MEM.pauseBelow (the emergency floor) — keep the `rejected` check. Auto (maxSlots null) keeps today's memory-sized behaviour. Update the comment block above `nodeCap` and CLUSTER.md's placement paragraph to say this. Tests: extend test/cluster-capacity.test.mjs (copy its stub-hub setup) with a node whose maxSlots is 10, cores 8, memAvailable 4 GB, policy mac, that reports `capacityView().workers === 10` and places a 6th task on it; and a capped node with memAvailable 200 MB that gets nothing. Run `npm test -- test/cluster-capacity.test.mjs test/scheduling.test.mjs`.

## Done when

`npm test -- test/cluster-capacity.test.mjs test/scheduling.test.mjs` passes and `grep -n 'maxSlots' .agent-orch/CLUSTER.md` prints a line

## Result — done (check passed) (2026-09-28 11:19)

AGENT-ORCH-STATUS: done — Done-when passes; test runner uses a lock directory without flock
