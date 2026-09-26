# Task #192: Parallel-first planning and scheduling

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 12:52  
- files: orchestrator.mjs, delegate.mjs, test/parallel*.test.mjs, test/scheduler*.test.mjs

## Prompt

Put much more emphasis on parallel agents (BRIEF goal 9). 1) The planner and reflection prompts (orchestrator.mjs): by default, decompose every multi-part request into tasks with DISJOINT declared "files" that can run concurrently, spread across different agents/models from the fallback lists, and end each group with an integrator task using after:[all parts] when the parts must be combined and verified. Serial chains are only for true prerequisites. Include a compact example of a parallel group in TASKS_FORMAT. 2) Scheduler concurrency: instead of a fixed CFG.concurrency (2-3), compute slots dynamically as the number of distinct agent accounts with usage headroom (each can run one task at a time by default; make it configurable per agent), capped by a machine limit (CPU cores and free memory; default max 6), with the pacing governor still able to lower it. Ready tasks with non-overlapping files fill the free slots on the agent/account best placed for them, using primary models first and fallbacks for tasks that would otherwise wait. 3) Orchestrator settings (#obPop): a 'Parallel agents' control (Auto / max N) and the per-agent 1-3 concurrent tasks setting. 4) State/API: expose running lanes (per agent account: the current task, model and elapsed time) for the UI. Tests: slot computation from accounts and headroom, filling slots with file-disjoint tasks across agents, and planner-block parsing of a parallel group with an integrator.

## Done when

`npm test` passes with dynamic-slot and multi-agent slot-filling tests, and the planner prompt text includes the parallel-group example
