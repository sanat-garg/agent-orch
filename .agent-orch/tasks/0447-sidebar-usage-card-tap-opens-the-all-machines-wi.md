# Task #447: Sidebar usage card: tap opens the all-machines window; no page dots

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 14:42  
- files: public/app.js, public/app.css, test/ui-mini-rotate*.test.mjs

## Prompt

Adjust the rotating sidebar usage card (#miniStats, from #380 'Sidebar usage card cycles through the VPS and every worker', in public/app.js and app.css): 1) Clicking or tapping the card (or Enter/Space when focused) opens the ALL-MACHINES usage window (the Machines view: use the same opener the rest of the app uses, e.g. openMachines(), which becomes the full-screen view once #382 lands), NOT the detail of the machine currently shown. It opens with no machine pre-selected. 2) Remove the page dots under the card and their click handlers and CSS. Keep the automatic rotation (every ~5 s, with a crossfade, paused on hover or focus, and prefers-reduced-motion respected) and the '+N offline' note. With the dots gone, give the card an accessible label like 'Machine usage: <name>, CPU 32%, RAM 41%. Open all machines'. The card height stays fixed so the sidebar doesn't jump. Update the existing test (test/ui-mini-rotate*.test.mjs): a click opens the all-machines view without a selected node; no dots are rendered; rotation still cycles. Run only the touched test files.

## Done when

`node --test test/ui-mini-rotate*.test.mjs` passes (click opens the all-machines view with no node selected, no dots rendered, rotation still cycles)
