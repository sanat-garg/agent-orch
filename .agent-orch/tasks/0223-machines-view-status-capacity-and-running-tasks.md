# Task #223: Machines view: status, capacity and running tasks per machine

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 11:58  
- starts after: #219  
- files: public/app.js, public/app.css, public/index.html, test/ui-machines*.test.mjs

## Prompt

Add a 'Machines' section (in Server details, or its own sidebar entry next to Connections, whichever fits the current layout best; keep #orchBar minimal per CONTEXT.md). Show one card per node: the name, OS/arch icon (Linux/macOS), online/offline/asleep/draining state and last seen, CPU cores and load, RAM used/available with a bar, the agents signed in, running tasks (title, agent/model, elapsed; tap to open the drawer) and slots in use / max. Per-node controls: rename, max parallel tasks (Auto/1-4), Drain, Disable and Remove (revoke, with confirmation). Include a summary line: 'Cluster: 3 machines · 7 cores · 14.2 GB free · 4 of 6 slots running'. The lanes view in the Queue modal labels each lane with its machine. Live updates via the WebSocket. It must work at 390px. Screenshots via bin/shot.mjs with seeded fake nodes.

## Done when

`node --check public/app.js && npm test` passes, and a seeded UI test shows one machine card per node with a Drain control

## Result — done (check passed) (2026-09-27 15:57)

AGENT-ORCH-STATUS: done — Machines view: per-node cards, controls, cluster summary; tests pass
