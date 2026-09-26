# Task #213: Minimal orchestrator bar: Queue, Settings, Pause/Resume only

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 20:41  
- files: public/index.html, public/app.css, public/app.js, test/ui-static.test.mjs

## Prompt

The orchestrator bar above the chat composer (public/index.html #orchBar ~lines 111-160, with its styles in public/app.css and logic in public/app.js) is cluttered: the .ob-icon, the .ob-title 'Orchestrator', #obStatus, #obCounts, the #obQueue chip, the #obLaneStrip compact lanes, the #obSettingsBtn popover and #obPause. Simplify it to the minimum (see the rule in .agent-orch/CONTEXT.md): 1) The bar contains ONLY a small status dot plus a very short status word ('Running', 'Idle', 'Paused', 'Waiting') on the left, and exactly three buttons on the right: 'Queue' (with a count badge only when there are queued tasks, e.g. 'Queue 5'), 'Settings', and 'Pause'/'Resume'. Remove .ob-icon, .ob-title, #obCounts and #obLaneStrip from the bar (keep the lanes inside the Queue modal only), and remove the extra JS that fills them. No limit, slot or memory text in the bar. 2) Pause/Resume: plain text with no emoji or symbols, in the theme orange: filled var(--accent) when paused ('Resume'), outlined accent when running ('Pause'). This supersedes queued task #212; implement the same styling here. The three buttons share one height (32-36px desktop, 44px touch) and style, and the whole bar is one line at 390px (the labels may shorten to icons with aria-labels under 360px). 3) Settings popover: it keeps its options but reads cleanly. Group them into sections with small headers (General: Keep improving, Project priority, Sound; Running: Parallel tasks; Models: Routes, Reflection fallbacks). Remove the #obLanes block from it (lanes live in the Queue modal), give it one-line descriptions, consistent row spacing and a max height with scroll, and present it as a bottom sheet on phones. 4) Update the static UI smoke test for the removed and changed ids, and remove dead CSS. Screenshots of the bar running, paused and idle, plus the settings popover, on desktop and at 390px, in light and dark, via bin/shot.mjs.

## Done when

`node --check public/app.js && npm test` passes, #orchBar contains exactly three <button> elements (Queue, Settings, Pause/Resume) plus the status, and index.html no longer has #obCounts, #obLaneStrip or .ob-title inside #orchBar
