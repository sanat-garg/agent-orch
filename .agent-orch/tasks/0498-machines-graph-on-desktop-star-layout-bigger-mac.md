# Task #498: Machines graph on desktop: star layout, bigger machine cards with every task and its progress

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 18:40  
- files: public/app.js, public/app.css, test/ui-machines-star*.test.mjs

## Prompt

Redesign the Machines window's graph for desktop/Mac (≥ 768px; phones keep the hierarchical list from #474): 1) A STAR topology: the head (oracle-vm) in the centre, and every machine arranged evenly around it on a circle, with links to the centre (keep the sync animations). Each node's usage is shown ONLY as a ring border around the node circle (CPU as the ring fill, memory as a thin inner ring; a tooltip gives exact numbers), so remove the CPU/RAM bars and numbers from the machine cards. 2) Each machine's card sits beside its node on the outer side, slightly bigger than now (~260-300px wide): the machine's FULL name (no truncation; wrap to 2 lines if needed), a status dot, the build tag, then EVERY task assigned to it as a mini card (#id, title, agent·model, elapsed) with the task's subtle progress strip (the shared timeline strip from the phase-strip task, less prominent) and a click to open its drawer. Keep the Assign task button (CONTEXT.md rule). Cards never overlap each other or the links (radial placement with collision nudging), and the modal from #480 fits 4 machines around the star at 1440px. 3) The head node's own card shows integrating/head tasks the same way. 4) Tests at 1440×900 with 4 seeded nodes and 3-6 tasks each: nodes are placed radially around the centre (the angle spacing is even ±5°); no card overlaps; each card lists all its tasks with progress strips; cards show no CPU/RAM text; the ring borders exist. Run only the touched test files.

## Done when

`node --test test/ui-machines-star*.test.mjs` passes (even radial layout, no overlap, all tasks with progress strips, no CPU/RAM text on cards, usage rings present)

## Result — done (check passed) (2026-09-28 18:47)

AGENT-ORCH-STATUS: done — Desktop Machines graph is a star with task-listing cards and usage rings
