# Task #507: Restore the original #229 Timeline bar exactly, drawer and cards

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 19:05  
- files: public/app.js, public/app.css, test/ui-phase-strip*.test.mjs

## Prompt

The owner still doesn't like the Timeline bar after #497/#501 and wants the ORIGINAL design back exactly. It was introduced in commit 87d6f040 (#229): `git show 87d6f040 -- public/app.css public/app.js`. Its CSS: `.tl-bar { --tl-done: #8a867c; display: flex; gap: 2px; height: 6px; margin: 2px 0 8px; }` (dark: --tl-done #7c786f); `.tl-bar i { min-width: 3px; background: var(--tl-done); }` with rounded first/last child; `.tl-bar i.cur { background: var(--run); animation: pulse 1.6s ease-in-out infinite; }`; `.tl-bar i.bad { background: var(--danger); }`; and `.tl-steps` (a wrapped list of steps with their times in 13px muted tabular-nums text) under the bar. Its JS: timelineSection(run, live), one thin bar whose segments take each step's share of the time, separated by 2px surface gaps (those gaps are the milestone marks), plus the step list. Do: 1) Restore that exact rendering and CSS for the task drawer's Timeline (replace #497's and #501's versions, and remove their now-unused palette vars and code). 2) Task cards (and the Machines star cards) use the SAME .tl-bar component in a compact modifier: height 3px, gap 1px, no step list, placed just above the card's bottom border, with a tooltip listing the steps and their times and the current step name. The current step keeps the --run blue, done steps --tl-done, and failed --danger. Keep prefers-reduced-motion (no pulse). 3) Tests: the drawer renders .tl-bar with one <i> per step, widths proportional to durations, a 2px gap and .tl-steps; the card uses .tl-bar.compact with a 3px height and no .tl-steps; .cur and .bad classes are applied correctly. Run only the touched test files.

## Done when

`node --test test/ui-phase-strip*.test.mjs` passes with the restored .tl-bar (6px, 2px gaps, --tl-done/--run/--danger) in the drawer and .tl-bar.compact on cards

## Result — done (check passed) (2026-09-28 19:09)

AGENT-ORCH-STATUS: done — Original #229 .tl-bar restored in drawer; cards use .tl-bar.compact
