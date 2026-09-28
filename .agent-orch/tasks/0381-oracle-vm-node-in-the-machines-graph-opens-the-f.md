# Task #381: oracle-vm node in the Machines graph opens the full server details

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 12:57  
- files: public/app.js, public/app.css, public/index.html, test/ui-machines*.test.mjs, test/ui-static.test.mjs

## Prompt

In the Machines view's cluster diagram (public/app.js, from #223/#231), clicking a worker node opens its detail, but clicking the head 'oracle-vm' (the controller node) doesn't show this server's usage, which lives separately in the Server details window (#serverModal: device info, CPU/RAM/disk/network charts, the Processes panel, cleanup). Unify them: clicking oracle-vm opens the SAME node-detail window as workers, and its content is the full server details (move the #serverModal content into a reusable renderServerDetails(container) and mount it in the controller's node detail; the charts and live refresh keep working there). Workers' node details keep their telemetry charts and phases, laid out to match the head's (same section order and chart styles: CPU, memory, disk, network, running tasks, processes if available). Anything that used to open #serverModal (the sidebar card click, links) now opens the oracle-vm node detail; remove the duplicate modal markup once nothing uses it. Update the static UI test ids. Test: clicking the controller node renders the server charts inside the node detail; the old entry points open it. Run only the touched test files.

## Done when

`node --test test/ui-static.test.mjs test/ui-machines*.test.mjs` passes, and a UI test shows that clicking the oracle-vm node renders the server CPU/RAM charts in the node detail
