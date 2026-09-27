# Task #231: Machines view: smooth sync animations between workers and the head

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-27 12:46  
- starts after: #229, #223  
- files: public/app.js, public/app.css, public/index.html, test/ui-cluster-anim*.test.mjs

## Prompt

Add polished, smooth animation to the Machines view (#223) using the telemetry and phases from the reporting task. 1) A cluster diagram: the head (controller) in the centre and worker nodes around it (a responsive radial layout on desktop, a vertical list on phones), with each node showing its name, OS icon, CPU/RAM ring gauges and running-task chips. 2) Live sync: every heartbeat gives a soft pulse on the node and its link. While a job streams events, small particles flow along the link from worker to head (throttled to the event rate, a max of ~6/s per link), and dispatch animates a task chip travelling head → worker. Completion animates the chip returning and merging into the head, with a brief check. Phase changes cross-fade on the chip ('installing' → 'running' → 'checking' → 'pushing'). Offline nodes fade to grey with a dashed link, asleep Macs show a moon, and draining nodes show an amber ring. 3) Performance: render with a single <canvas> or SVG with requestAnimationFrame, pause when hidden (document.hidden), cap at 60 fps, and avoid layout thrash. Respect prefers-reduced-motion (static state changes only). Colours come from the theme variables, in light and dark. 4) Tapping a node opens its detail (metrics charts from /api/cluster/nodes/:id/metrics, phases, and a 'View logs' button fetching the log tail). Take screenshots and a short screen capture (a Playwright video) with fake nodes emitting events, saved to .agent-orch/shots/.

## Done when

`node --check public/app.js && npm test` passes, and a seeded UI test with fake nodes renders the cluster diagram and animates a dispatch → merge cycle (the chip reaches the head)
