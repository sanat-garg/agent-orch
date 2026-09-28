# Task #384: Head capacity from its real hardware; integration first on the head, work delegated to Macs

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 13:02  
- files: orchestrator.mjs, cluster.mjs, parallel.mjs, public/app.js, test/head-capacity*.test.mjs

## Prompt

The owner upgraded the head VPS (oracle-vm) to 2 cores and 11 GB RAM (it was 1 core and 5.9 GB), and wants the head to DELEGATE work to the workers and INTEGRATE it here, speeding up production. Current state: the controller node's max_slots is 1 (nodes table) and parallel_settings is {controllerWork:true}. Integrators (the 'Integrate #N' tasks) must run on the controller (orchestrator.mjs ~line 343/1502; 20 of 26 ran here), so with one slot they queue behind other work (e.g. #314, #364, #312 and #363 were waiting at 13:02). Do: 1) The head's slot target comes from its REAL hardware, detected live (os.cpus().length, MemTotal), not the stale stored value: default target = max(4, cores × 3), since agents mostly wait on the LLM (6 now), with owner ceilings optional (per #344/#378's rules; no RAM or battery gating, only CPU saturation). Re-detect at boot and every 10 min so future resizes apply automatically, and update the stored controller node's cores/max_slots so the UI shows the truth. 2) Integration first: reserve up to 2 head slots for controller-only work (integrators, review checkpoints, planner/reflection) so they start immediately when needed and never wait behind ordinary work tasks. Integrators get the highest scheduling priority among ready work. Merge-back of worker branches (fetch + rebase + ff) runs promptly on the head, serialized per project, without taking a task slot. 3) Delegation preference: ordinary work tasks go to online workers first (by the #344 spread rule), and the head takes ordinary work only when every worker is at its target or none is online (the controllerWork setting stays as an owner override: on = the head may run work under that rule; off = never). 4) Visibility: the Machines/queue view shows the head's slots split as 'Integrating 2 · Work 1/4'. 5) Tests: the target is derived from mocked cores (2 → 6); an integrator starts on the head while the head's work slots are full; a work task goes to a worker with capacity rather than the head; the head takes work only when the workers are full; resize detection updates the target. Run only the touched test files.

## Done when

`node --test test/head-capacity*.test.mjs` passes (cores-derived target, reserved integrator slots, workers-first delegation, head fallback, resize re-detect)

## Result — done (check passed) (2026-09-28 14:05)

AGENT-ORCH-STATUS: done — head slots from hardware, integrators reserved, workers-first delegation tested
