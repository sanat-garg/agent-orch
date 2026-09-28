# Task #455: Plain-language refill status instead of 'Workers: 19 free · 12 ready → topping up'

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 14:52  
- files: public/app.js, public/app.css, orchestrator.mjs, test/ui-refill-status*.test.mjs

## Prompt

The queue header / lanes status from #436 shows raw text like 'Workers: 19 free · 12 ready → topping up', which the owner found unclear. Replace it (public/app.js, app.css; find the string's source, and adjust the server-side text in orchestrator.mjs if it's generated there) with a clear, styled status line in the app's theme: 1) Wording by state: when topping up, '12 tasks ready for 19 open slots · planning more work'; when balanced, '19 open slots · 21 tasks ready' (or 'All slots busy' when free = 0); when blocked, 'Planning paused: usage limit near' / 'Keep improving is off for this project'. Use 'open slots' across the Macs (say 'machines' if the head is included). 2) Style: a small muted line with the counts in tabular figures and semibold, a tiny animated dot or spinner only while planning more work (static under prefers-reduced-motion), no arrows or jargon ('workers', 'top up'). 3) An ⓘ / tap target opens a short explanation popover: 'Each machine can run several tasks at once. When fewer tasks are ready than there are open slots, agent-orch asks the planner to queue more, so no machine sits idle. Turn this off with Keep improving in Settings.' Keep it fitting on one line at 390px (it shortens to '12 ready · 19 open'). 4) Tests: each state renders the right text from mocked state; the popover opens; no 'topping up' or 'Workers:' strings remain in the UI. Run only the touched test files.

## Done when

`node --test test/ui-refill-status*.test.mjs` passes (state texts, explanation popover), and `! grep -rn "topping up" public/app.js`
