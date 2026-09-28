# Task #482: Claude limits card: an ideal-pace line on each usage bar

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 18:10  
- files: public/app.js, public/app.css, test/ui-pace-line*.test.mjs

## Prompt

In the Claude usage/limits card (the sidebar usage card and the Usage window's window bars for five_hour and seven_day, plus the other agents' windows with a known reset), draw an 'ideal pace' marker on each bar at the percentage of the window's time already elapsed: ideal% = (now − windowStart) / windowLength × 100, where windowStart = resetsAt − length (5 h or 7 d). E.g. 1 h into a 5 h window → 20%. Colour: if actual usage ≤ ideal, the marker is a thin GREY line (you're under pace); if actual usage > ideal, it's a DARK ORANGE line (you're ahead of pace, i.e. burning faster than time). A tooltip reads 'Pace: 20% by now · you're at 15% (5% under)' or '… at 25% (5% over)'. It updates every minute. In the Usage window's charts over time, also draw the ideal diagonal as a faint dashed line per window. Tests: at 1 h into a 5 h window with 15% usage, the marker sits at 20% and is grey; with 25%, it's dark orange; a window with an unknown reset shows no marker. Run only the touched test files.

## Done when

`node --test test/ui-pace-line*.test.mjs` passes (marker at elapsed %, grey under / dark orange over, none without a reset)
