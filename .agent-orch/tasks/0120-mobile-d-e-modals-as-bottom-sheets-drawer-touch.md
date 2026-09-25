# Task #120: Mobile D+E: modals as bottom sheets, drawer, touch and perf polish

- kind: work  
- source: planner  
- priority: 20 (background)  
- created: 2026-09-25 14:02  
- starts after: #119

## Prompt

Implement groups D and E from .agent-orch/MOBILE.md. D: on narrow screens every .modal (Connections, Usage, Server details, lightbox, picker, delegate) and the task drawer present as iOS-style bottom sheets (a grabber, a drag-down to dismiss, max height with internal scroll, safe-area bottom padding, background scroll lock); desktop keeps centred modals. E: remove hover-only affordances; use -webkit-tap-highlight-color transparent with custom pressed states; set touch-action where appropriate; honour prefers-reduced-motion; check dark mode contrast; keep scrolling smooth on long chats (content-visibility or windowing if the audit found jank); and avoid layout thrash in live streaming updates. Verify with iPhone-emulated screenshots in .agent-orch/shots/. Mark every remaining MOBILE.md item Fixed or Deferred.

## Done when

`npm test` passes and every item in .agent-orch/MOBILE.md is marked Fixed or Deferred
