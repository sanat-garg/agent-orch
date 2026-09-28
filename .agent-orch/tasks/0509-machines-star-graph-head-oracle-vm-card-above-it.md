# Task #509: Machines star graph: head (oracle-vm) card above its node, workers around the rest

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 19:08  
- files: public/app.js, public/app.css, test/ui-machines-star*.test.mjs

## Prompt

In the desktop Machines star graph (#498; public/app.js, app.css), the head's (oracle-vm) card is placed below the centre node, where it clutters two worker machines' cards. Place the head's card ABOVE the centre node (anchored to the node's top, horizontally centred, with a small gap), and reserve that top sector: distribute the worker nodes around the remaining arc (e.g. from about 30° to 330° measured from the top, evenly spaced; with 1-2 workers, place them at lower-left and lower-right), keeping their cards on the outer side of their nodes. Keep collision nudging so no card overlaps another card, the head card, or the links, and keep the Assign button, ping and sync animations. Tests at 1440×900 with 3 and 4 seeded workers: the head card's bounding box is above the centre node's (bottom ≤ node top); no card overlaps; the worker angles avoid the top sector. Run only the touched test files.

## Done when

`node --test test/ui-machines-star*.test.mjs` passes with the head card above the centre node, workers outside the top sector, and no overlaps

## Result — done (check passed) (2026-09-28 19:10)

AGENT-ORCH-STATUS: done — Head card sits above its node; workers ring the rest
