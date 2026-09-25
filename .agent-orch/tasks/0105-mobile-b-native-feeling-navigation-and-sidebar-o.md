# Task #105: Mobile B: native-feeling navigation and sidebar on iPhone

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22  
- starts after: #104

## Prompt

Implement group B from .agent-orch/MOBILE.md: navigation on iPhone. This includes: a compact top bar (large-title feel, back/menu button, chat title truncation); the sidebar as a full-height drawer with an edge-swipe to open and swipe to close (building on the collapsible sidebar work); 44pt minimum touch targets throughout; list rows with native-style pressed states; switching between chat, tasks and terminal views that feels instant (no layout jumps); and a scroll position that's preserved per view. Follow the HIG notes in .agent-orch/MOBILE.md and ~/.claude/skills/apple-design. Verify with before/after iPhone-emulated screenshots in .agent-orch/shots/, and don't regress desktop (take a desktop screenshot too).

## Done when

`node --check public/app.js && npm test` passes, and .agent-orch/MOBILE.md group B items are marked Fixed or Deferred with a reason
