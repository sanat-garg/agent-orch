# Task #107: Mobile D+E: modals as bottom sheets, drawer, touch and perf polish

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22  
- starts after: #106

## Prompt

Implement groups D and E from .agent-orch/MOBILE.md. D: on narrow screens every .modal (Connections, Usage, Server details, lightbox, picker) and the task drawer present as iOS-style bottom sheets (a grabber, a drag-down to dismiss, max height with internal scroll, safe-area bottom padding, background scroll lock); desktop keeps centred modals. E: remove hover-only affordances (every action reachable by tap); use -webkit-tap-highlight-color transparent with custom pressed states; set touch-action where appropriate; honour prefers-reduced-motion; check dark mode contrast; keep scrolling smooth on long chats (content-visibility or windowing if the audit found jank); and avoid layout thrash in live streaming updates. Verify with iPhone-emulated screenshots in .agent-orch/shots/. Mark every remaining MOBILE.md item Fixed or Deferred.

## Done when

`npm test` passes and every item in .agent-orch/MOBILE.md is marked Fixed or Deferred
