# Task #479: Task cards: a coloured phase progress strip along the bottom edge

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 18:10  
- files: public/app.js, public/app.css, test/ui-phase-strip*.test.mjs

## Prompt

Show a task's progression on its card without opening the drawer. Along the bottom edge of every task card (taskCard in public/app.js: the queue, chat cards and the Machines lists), inside the card just above its lower border, render a thin (3-4px) segmented strip built from the same phase timeline the drawer's 'Timeline' uses (the job phases from #229: queued → cloning/fetching → installing → running agent → checking → committing → pushing → merging → done). Completed phases are filled, the current one pulses gently (no pulse under prefers-reduced-motion), and future ones are faint. Give each phase its own colour from a theme-consistent palette (define CSS vars, legible in light and dark): e.g. queued grey, preparing (clone/install) blue, running agent orange (the accent), checking purple, pushing/merging teal, done green, failed red, waiting-on-limit amber. Add a small legend in the Queue modal header, and a tooltip on the strip ('Checking · 2m 10s'). It updates live from the WebSocket. Tests: a running-agent task shows the orange current segment; a failed task shows red; the legend exists. Run only the touched test files.

## Done when

`node --test test/ui-phase-strip*.test.mjs` passes (current phase colour, failed red, legend present)
