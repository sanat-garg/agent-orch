# Task #141: Execution forecast: when and on which model a task will run

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 23:22

## Prompt

Add forecast(list, now) to delegate.mjs: given an ordered fallback hierarchy [{agent, model}] (the first is the start/preferred model) and the per-agent availability (blockedUntilFor(agent) from orchestrator.mjs, the usage windows with resetsAt, and the connection state), return the timeline of which model a task would run on. Semantics: at time t, the task runs on the highest-ranked available model, and when a higher-ranked model becomes available later, it switches to it for subsequent work (a running session isn't interrupted; the switch applies to the next task or resume). Output: {startsAt, segments: [{agent, model, from, to|null}], summary}. summary is a short phrase in the browser's time format, e.g. 'Now on Opus'; 'Astra now → Opus at 5:00'; 'Astra at 4:45 → Opus at 5:00'; 'Waiting: Opus at 5:00' (all limited, single model); 'No model available' (all disconnected). Keep it under ~40 chars and use model display names. Return times as epoch seconds; the client formats them in its own timezone. Expose it: GET /api/delegate/preview includes `forecast` for the chat's list (or the automatic list), and the task list/drawer API includes `forecast` for queued tasks that are eligible for delegation (using the task's snapshotted fallbacks). Pinned tasks forecast only their own model. Tests with fixture availability: the owner's example (all limited; Opus at 05:00 and Astra at 04:45 give 'Astra at 4:45 → Opus at 5:00'), all available, only a lower model available now, all disconnected, and a pinned task.

## Done when

`npm test` passes with forecast tests including the Opus 05:00 / Astra 04:45 case producing two segments starting with Astra
