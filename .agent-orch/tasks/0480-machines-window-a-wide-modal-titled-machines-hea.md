# Task #480: Machines window: a wide modal titled 'Machines', head KPIs only on click

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 18:10  
- files: public/app.js, public/app.css, public/index.html, test/ui-machines-modal*.test.mjs

## Prompt

Rework the Machines window (the full-screen view from #382/#472, the graph cards from #434, and the mobile design from #433/#474; keep the phone layout). On desktop: 1) It's a wide MODAL, not full screen: centred, width min(1400px, 96vw), height up to 90vh, with a backdrop and Esc/close, sized so FOUR machine cards fit side by side in one row. 2) The title is 'Machines' (not 'oracle-vm' or the server name). 3) The head's (oracle-vm's) CPU/RAM/disk KPIs and charts are NOT shown by default; they appear in the side/detail panel only when the oracle-vm node is clicked in the graph, like any other machine. The default content is the cluster summary, the graph with the compact per-node cards (all running tasks listed) and the queue. 4) Keep the Assign task buttons (CONTEXT.md rule), the ping, update all, and the sync animations. Tests at 1440×900: the modal isn't full-screen (it has a margin), the title is 'Machines', 4 cards fit in one row with seeded 4 nodes, and no head KPIs are visible until the head node is clicked. Run only the touched test files.

## Done when

`node --test test/ui-machines-modal*.test.mjs` passes (wide modal not full-screen, 'Machines' title, 4 cards in a row, head KPIs only after click)

## Result — done (check passed) (2026-09-28 18:15)

AGENT-ORCH-STATUS: done — Machines is a wide modal with four cards in one row
