# Task #142: Orchestrator settings: fallback hierarchy for reflection tasks

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 23:22  
- starts after: #140

## Prompt

In the orchestrator settings popover (public/index.html #obPop ~line 128, next to 'Keep improving' #obPerpetual, priority #obPriority and routes #obRoutes), add a 'Reflection fallbacks' section that uses the reusable renderFallbackEditor component from the fallback-editor task. It shows the ordered hierarchy used for tasks created by reflection, with a one-line explanation ('Reflection tasks run on the first available model in this order'). Backend: store it per project (projects.reflect_fallbacks TEXT JSON, with migration; null = automatic ranking). Add PUT /api/orch/projects/:id/reflect-fallbacks, validated against the discovered models. When reflection queues tasks, snapshot this list into tasks.fallbacks (as chat tasks already do), and delegate.mjs uses it for them. Show the forecast summary for the list (from the forecast task's delegate.mjs forecast) under the editor. Tests: saving and validating the list, and reflection-created tasks getting the snapshot.

## Done when

`npm test` passes with reflect-fallbacks tests, and #obPop contains the reflection fallback editor

## Result — done (check passed) (2026-09-26 00:03)

AGENT-ORCH-STATUS: done — Reflection fallbacks editor added to #obPop, saved and snapshotted per project, npm test passes
