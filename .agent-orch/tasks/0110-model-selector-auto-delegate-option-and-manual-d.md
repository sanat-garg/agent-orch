# Task #110: Model selector 'Auto Delegate' option and manual Delegate action on queued tasks

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22  
- starts after: #109

## Prompt

UI plus wiring for delegation (public/app.js, app.css, server.mjs, orchestrator.mjs). 1) The chat model selector (agent + model picker) gets an 'Auto Delegate' option at the top, meaning agent-orch picks and may reassign comparable models while this chat message's tasks are pending. Selecting a specific model pins it. Send the choice with each message. The planner passes autoDelegate/pinned through to the tasks it queues from that turn (set tasks.origin='chat', auto_delegate). Show a small 'Auto' or pinned-model chip on the composer. 2) The task drawer, for queued or rate-limit-waiting tasks, gets a 'Delegate…' button that opens a sheet listing delegate.mjs candidates. Each row shows the agent, model and status (available / limited until …), the key metrics (Coding Index, Agentic Index, Terminal-Bench, SciCode, TTFT latency, tokens/s, context, price), a delta vs the current model and the reason. Picking one reassigns the task (POST /api/orch/tasks/:id/delegate {agent, model}; manual delegation by the owner is always allowed, including for pinned tasks, since the owner is choosing). Show the data source (Artificial Analysis vs manual) and fetched_at. 3) The task badge shows 'delegated from X'. It must work well as a mobile bottom sheet. Tests: the delegate endpoint reassigns a queued task and rejects running/done tasks.

## Done when

`npm test` passes with delegate-endpoint tests, and app.js renders an 'Auto Delegate' option in the model picker
