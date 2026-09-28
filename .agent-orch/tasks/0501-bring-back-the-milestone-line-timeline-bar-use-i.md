# Task #501: Bring back the milestone-line Timeline bar; use it on task cards too

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 18:49  
- files: public/app.js, public/app.css, test/ui-phase-strip*.test.mjs

## Prompt

The owner prefers the EARLIER drawer 'Timeline' bar design (the one with vertical lines/ticks marking each milestone or phase boundary), which #497 (commit 03d8765 'Task card progress: timeline-style strip…') replaced with a shared plain strip. Restore it: look at the drawer Timeline rendering and CSS before 03d8765 (`git show 03d8765^:public/app.js` and `git show 03d8765^:public/app.css`, and compare with ad81bb7/#487 if needed) and bring back that milestone-line design as the ONE shared renderer: a track with a thin vertical line at each phase boundary (the milestones), optional small labels/tooltips at milestones, filled progress up to now, and the current phase marked. Keep what the owner liked from #497: segments proportional to the time spent per phase and the muted premium palette (the CSS vars). Use it in two sizes: the full version in the task drawer's Timeline (as it was), and a compact, low-prominence version on task cards just above the bottom border (the milestone lines as 1px hairlines, a 2-3px track, no labels, tooltip only). The Machines star cards (#498) use the compact version too. Tests: the drawer Timeline renders milestone line elements at the phase boundaries (count = phases − 1) at positions proportional to durations; the card strip uses the same renderer in compact mode. Run only the touched test files.

## Done when

`node --test test/ui-phase-strip*.test.mjs` passes with milestone lines at proportional phase boundaries in both the drawer Timeline and the compact card strip
