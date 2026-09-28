# Task #434: Machines graph: compact card beside each node, listing every running task

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 14:23  
- starts after: #382  
- files: public/app.js, public/app.css, test/ui-machines-graph-cards*.test.mjs

## Prompt

On desktop/laptop (Mac) screens, the Machines usage window (the full-screen view from #382 with the cluster diagram and the queue) shows big, cluttered machine cards separate from the graph, and truncates running tasks as '+1 more'. Redesign it for widths ≥ 768px (phones are handled by #433; don't change the phone layout): 1) Put each machine's info in a SMALL card placed right next to its node on the graph (anchored to the node, positioned outward from the head so cards never overlap each other, the links or the head; recompute on resize and when nodes join or leave; use a simple radial offset with collision nudging). Max width ~220px. Contents, in order: the name plus a status dot (online/connection lost/offline) and the build tag; one line with tiny CPU and RAM bars and their percentages; then EVERY running task on that machine as a one-line row ('#412 Files ops · Claude' with an elapsed timer), with no '+N more' truncation; the card grows vertically, and scrolls internally only past about 8 rows. Clicking a task opens its drawer, and clicking the card header opens the machine's detail side panel (charts, settings, history). 2) Remove the old large machine cards and any duplicate info from this view. Machine settings and other controls live only in the detail panel (behind a small gear on the card), so the card stays clean. 3) The head node gets the same style of card (its integrator slots shown as a separate 'Integrating' group). 4) Keep the sync animations (dispatch/merge particles) working with the cards in place, and the theme variables in light/dark. 5) Screenshots via bin/shot.mjs at 1440x900 and 1280x800 with seeded nodes (VPS + 3 Macs, one with 6 running tasks). Tests: each node has an anchored card that doesn't overlap another card (bounding boxes); a machine with 6 running tasks lists all 6 (no '+'); a task row opens its drawer; the old card container is gone. Run only the touched test files.

## Done when

`node --test test/ui-machines-graph-cards*.test.mjs` passes (anchored non-overlapping cards, all running tasks listed without '+N', task row opens drawer), and `! grep -nE "\+\$\{[^}]*\} more" public/app.js` for the machine task list
