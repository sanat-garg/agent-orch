# Task #158: Themed, non-blocking toasts at the side

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 04:21

## Prompt

Rework the toast(msg, {action, run}) helper in public/app.js and its CSS. Toasts appear stacked in the bottom-right corner on desktop (16px from the edges, max-width 360px) and at the top on phones, below the safe-area inset, never covering the composer or the queue. They must never block interaction: the container is pointer-events:none, and only the toast itself is pointer-events:auto. They use the app's theme variables (surface/panel background, --border, --text, and a 3px left accent bar coloured by kind: info = --accent, success = green token, warn = --warn, error = the danger token), in both light and dark mode, with a subtle shadow. Variants: toast(msg, {kind, action, run, duration}). They auto-dismiss (4 s; 6 s with an action), pause on hover, can be swiped away on touch, have a close ×, and show at most 3 at once (older ones collapse). Use aria-live=polite (assertive for errors), and slide in and fade out (none under prefers-reduced-motion). Migrate every existing toast call to pass an appropriate kind. Screenshots via bin/shot.mjs in both themes.

## Done when

`node --check public/app.js && npm test` passes, and the toast container CSS has pointer-events:none and a bottom-right position on desktop

## Result — done (check passed) (2026-09-26 09:49)

AGENT-ORCH-STATUS: done — themed stacked toasts with kinds; tests pass; screenshots captured
