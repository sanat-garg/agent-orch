# Task #497: Task card progress: timeline-style strip, proportional to time, premium muted colours

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 18:40  
- files: public/app.js, public/app.css, test/ui-phase-strip*.test.mjs

## Prompt

Redo the phase strip on task cards (from #479/#487; public/app.js taskCard, app.css) to look like the drawer's 'Timeline' bar and to be less prominent: 1) Segment widths are PROPORTIONAL to the time spent in each phase (from the run's phase timestamps; the current phase grows live, and future phases aren't drawn, or are one faint remainder). 2) Colours: a refined, muted, premium palette (desaturated, harmonious with the theme; no vibrant or neon hues). Suggested: queued slate, preparing steel blue, agent working a muted clay/terracotta (a softened accent), checking dusty violet, pushing/merging sage teal, done soft green, failed muted brick, waiting-on-limit muted ochre. Define them as CSS variables, tuned separately for light and dark to keep contrast subtle. 3) Less prominent: a 2px height, rounded ends, sitting just above the card's bottom border, with lower opacity when the card isn't hovered or selected; no pulsing (a gentle shimmer only on the current segment, and none under prefers-reduced-motion). 4) The tooltip lists phases with their durations ('Agent 4m 12s · Checking 38s'). Share the rendering with the drawer Timeline so both look identical (one function). Update the legend. Tests: segment widths match the phase duration ratios within 2%; the palette vars exist for both themes; the strip height is ≤ 2px. Run only the touched test files.

## Done when

`node --test test/ui-phase-strip*.test.mjs` passes (proportional widths, muted palette vars for both themes, ≤2px, shared with drawer Timeline)
