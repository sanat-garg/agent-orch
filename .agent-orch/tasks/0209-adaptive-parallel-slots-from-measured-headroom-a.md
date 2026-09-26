# Task #209: Adaptive parallel slots from measured headroom and per-agent footprint

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 19:41  
- starts after: #208, #207  
- files: orchestrator.mjs, resources.mjs, public/app.js, test/adaptive*.test.mjs

## Prompt

Replace the fixed concurrency with a resource-aware one (BRIEF goal 9), building on #207's memory guard and resources.mjs. 1) Learn each agent's typical peak footprint: record the peak RSS/PSS of every task tree per agent/model (from resources.mjs snapshots) into <DATA>/metrics/footprints.json (keep a p90 over the last 20 runs; seed defaults of Claude 900 MB, Codex 400 MB, agy 700 MB, OpenCode 500 MB, Kiro 500 MB and Copilot 500 MB until measured). 2) Before claiming another task while ≥1 is running: run the reaper first, then allow the claim only if MemAvailable − (the p90 footprint of the candidate's agent) ≥ a safety floor (default 700 MB, or 15% of RAM, whichever is larger), the 1-minute load is under the core count, swap in use is under 25%, and the owner's setting permits it (Parallel tasks: Auto (resource-aware) / 1 / 2 / 3; default Auto). Tasks still need non-overlapping declared files to run together. 3) If memory drops under the floor mid-run, the newest parallel task is paused (resumable) as in #207. 4) Orchestrator state exposes the current slots with the reason ('2 slots · 2.1 GB free' or '1 slot · memory tight'), and the lanes and dock headers show it. 5) The planner prompt: plan sequential chains with true prerequisites and optional 'files'; don't force parallelism, since the scheduler adds it when it's affordable. Tests with mocked meminfo and footprints: a second claim is allowed with headroom, refused without it, the reaper runs before refusal, and the mid-run pause.

## Done when

`npm test` passes with adaptive-slot tests (allowed with headroom, refused without, reaper-before-refusal, mid-run pause)
