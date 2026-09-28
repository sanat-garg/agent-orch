# Task #380: Sidebar usage card cycles through the VPS and every worker

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 12:57  
- files: public/app.js, public/app.css, public/index.html, test/ui-mini-rotate*.test.mjs

## Prompt

The sidebar mini usage card (#miniStats in public/index.html, rendered in public/app.js, which today shows only this server's CPU/RAM) should rotate through all machines: first 'oracle-vm (head)', then each online worker (from GET /api/cluster/nodes plus its telemetry), each shown for ~5 s with the machine name, an OS icon, CPU % and RAM used/total as the existing mini bars/sparklines, and the number of running tasks. Crossfade between them (no motion under prefers-reduced-motion), with small page dots under the card showing which machine is shown (tapping a dot jumps to it). Pause rotation while hovered or focused, and when only one machine exists, show it without dots. Offline machines appear in the rotation with a greyed 'offline · last seen …' state, or are skipped (choose skipped, with an '+1 offline' note). Clicking the card opens the detail window of the machine currently shown (for oracle-vm, the server details; for a worker, its node detail). Keep the card's size fixed so the sidebar doesn't jump. Take theme-consistent screenshots via bin/shot.mjs with seeded fake nodes. Test: the rotation order and dot navigation with fake nodes; the click opens the right machine. Run only the touched test files.

## Done when

`node --test test/ui-mini-rotate*.test.mjs` passes (rotation across head plus workers, dot jump, click opens the shown machine)
