# Task #344: Placement uses every machine: CPU-only gating, spread across nodes, explain skips

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 12:26  
- files: orchestrator.mjs, cluster.mjs, worker.mjs, public/app.js, test/placement*.test.mjs

## Prompt

The owner has 4 online machines (the controller VPS with 1 core; 'Sanat's Macbook Air' with 8 cores; 'Soham's MacBook Air' with 8; 'Sanat's Macbook Pro' with 12), but work piles onto one machine: in 24 h the controller ran 103, the Air 29, Soham's 5, and the Pro 0. Apply BRIEF goal 9's PLACEMENT RULE: 1) Remove RAM, battery, AC-power, thermal and reserveGB from placement and offer acceptance, both head-side (orchestrator.mjs headroom/spareMem/footprint checks and cluster.mjs wirePolicy) and worker-side (worker.mjs power policy: the Pro declines because of 'new jobs on AC power only' with a bogus battery reading of 1%, 'ac'). Keep keepAwake behaviour (caffeinate) since it helps, but not as a gate. Keep the OOM emergency brake only if it already exists as a pause, never as a placement gate. 2) CPU is the only gate, and it's not conservative: skip a node only when its CPU is genuinely saturated, i.e. sustained for 60 s: the Linux PSI cpu some avg60 > 90%, or on macOS the 1-min load average > 2.5 × cores. Otherwise it's eligible. 3) Spread: pick among eligible nodes by the lowest (running tasks + 1) / cores, with ties broken round-robin, so every machine gets work. Per-node slot targets default to cores (VPS 1 core → treat as 4 since agents mostly wait on the LLM; Macs = their core count), and owner-set caps (max_slots, `worker.mjs limit`) remain optional ceilings. Supersede the memory-based adaptive logic (#301 is being cancelled): any adaptive behaviour uses only the CPU signal. 4) Explain: the orchestrator records a per-node 'last placement decision' ('eligible: 2/8 running' / 'skipped: CPU saturated (load 22/8)' / 'skipped: agent codex signed out' / 'skipped: disabled'), shown in the Machines view under each node and exposed in GET /api/cluster/nodes. 5) Tests: RAM, battery and AC never block placement; CPU saturation does; 10 ready tasks over 4 nodes spread by cores; the Pro-like node (battery 1%, 'ac') receives work. Run only the touched test files.

## Done when

`node --test test/placement*.test.mjs` passes (no RAM/battery/AC gating, CPU saturation gates, spread by cores, the Pro-like node gets tasks), and GET /api/cluster/nodes shows a lastDecision per node
