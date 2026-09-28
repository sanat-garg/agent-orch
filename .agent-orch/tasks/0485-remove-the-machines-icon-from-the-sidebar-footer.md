# Task #485: Remove the Machines icon from the sidebar footer

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 18:10  
- files: public/index.html, public/app.js, public/app.css, test/ui-static.test.mjs

## Prompt

Remove the Machines icon/button from the sidebar footer (public/index.html, public/app.js, app.css). The Machines window stays reachable from the rotating usage card (tap opens it, #447) and anywhere else it's linked. Remove its handler and CSS if unused, and update the static UI test. Test: the footer has no Machines button, and the usage card still opens the Machines window. Run only the touched test files.

## Done when

`node --test test/ui-static.test.mjs test/ui-mini-rotate*.test.mjs` passes with no Machines button in the sidebar footer
