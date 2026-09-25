# Task #119: Mobile C: chat composer and keyboard handling on iOS

- kind: work  
- source: planner  
- priority: 20 (background)  
- created: 2026-09-25 14:02  
- starts after: #118

## Prompt

Implement group C from .agent-orch/MOBILE.md: the chat composer on iPhone. This includes: the composer staying pinned above the iOS keyboard (use the visualViewport API; no content hidden behind the keyboard); a 16px minimum input font so iOS doesn't zoom; an auto-growing textarea with a max height; a large send button reachable by thumb; Return inserting a newline on mobile while send is the button (desktop keeps Enter to send); the model/agent picker opening as a bottom sheet; the message list auto-scrolling only when the user is near the bottom, with a 'jump to latest' pill otherwise; and long code blocks scrolling horizontally within their block, never the page. Verify with iPhone-emulated screenshots in .agent-orch/shots/. Mark the group C items Fixed or Deferred.

## Done when

`node --check public/app.js && npm test` passes, and .agent-orch/MOBILE.md group C items are marked Fixed or Deferred with a reason
