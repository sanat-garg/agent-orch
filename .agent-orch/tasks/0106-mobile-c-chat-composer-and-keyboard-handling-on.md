# Task #106: Mobile C: chat composer and keyboard handling on iOS

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22  
- starts after: #105

## Prompt

Implement group C from .agent-orch/MOBILE.md: the chat composer on iPhone. This includes: the composer staying pinned above the iOS keyboard (use the visualViewport API to handle resize/scroll offsets; no content hidden behind the keyboard); a 16px minimum input font so iOS doesn't zoom; an auto-growing textarea with a max height; a send button that's large and reachable by thumb; Return inserting a newline on mobile while send is the button (desktop keeps Enter to send); the model/agent picker opening as a bottom sheet; the message list auto-scrolling only when the user is near the bottom, with a 'jump to latest' pill otherwise; and long code blocks scrolling horizontally within their block, never the page. Verify with iPhone-emulated screenshots (with a simulated keyboard where possible) in .agent-orch/shots/.

## Done when

`node --check public/app.js && npm test` passes, and .agent-orch/MOBILE.md group C items are marked Fixed or Deferred with a reason
