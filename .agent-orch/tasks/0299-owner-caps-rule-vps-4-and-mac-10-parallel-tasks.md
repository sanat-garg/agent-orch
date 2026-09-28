# Task #299: Owner caps rule: VPS 4 and Mac 10 parallel tasks; memory is only an emergency brake

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 10:50  
- files: orchestrator.mjs, parallel.mjs, cluster.mjs, public/app.js, test/adaptive*.test.mjs, test/parallel*.test.mjs, test/scheduler*.test.mjs

## Prompt

The owner says the scheduler is far too conservative (BRIEF goal 9, rapid development mode). Currently: the controller slot setting only allows parallelTasks 1|2 (orchestrator.mjs ~lines 1275-1345, taskSlots in parallel.mjs); nodes.max_slots is 1 for the controller and 4 for the MacBook (cluster.mjs, allowed 1-16); and claims are pre-gated by the per-agent footprint (CFG.footprint, ~900 MB for Claude) plus a safety floor, so the 5.9 GB/1-core VPS rarely runs more than 1-2 tasks. Change it: 1) The owner-set per-machine cap is THE limit. Allow the controller setting 1-16 (replace the 1|2 enum in the settings API, the Settings sheet and the migration) and the node max_slots 1-32. Set the live values now via the settings/nodes code paths (not by hand-editing the DB while the server is writing): controller = 4, and the MacBook (node n_97aedd112345) = 10. 2) Remove the pre-emptive memory gating from claims (footprint headroom, the safety floor, load < cores, swap < 25%). Keep only the emergency brake: if a node's MemAvailable drops below 250 MB (or swap in use above 80%) for 20 s, pause the newest task on that node (resumable) and don't claim on that node until MemAvailable is back above 500 MB. The footprint stats stay as information only (shown in Machines). 3) CPU is never a gate. 4) The UI (Settings sheet, Machines per-node cap) exposes 1-16 / 1-32 with the current values, and the parallel status line reads 'Running 7 of 14 slots'. 5) Tests: slots equal the owner caps regardless of the footprint; the emergency brake pauses the newest task at low memory and resumes claiming after recovery; the settings API accepts 4 and rejects 0 and 17. Run only the touched test files.

## Done when

Touched tests pass (`node --test test/adaptive*.test.mjs test/parallel*.test.mjs test/scheduler*.test.mjs`), and GET the orchestrator state on the live server shows controller slots 4 and the MacBook max 10
