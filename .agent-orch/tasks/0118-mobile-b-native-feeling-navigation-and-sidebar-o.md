# Task #118: Mobile B: native-feeling navigation and sidebar on iPhone

- kind: work  
- source: planner  
- priority: 20 (background)  
- created: 2026-09-25 14:02  
- starts after: #117

## Prompt

Implement group B from .agent-orch/MOBILE.md: navigation on iPhone. This includes: a compact top bar (menu button, chat title truncation); on phones the sidebar is an off-canvas drawer with a dimmed backdrop, an edge-swipe to open, and a swipe/backdrop tap/Esc to close, closing automatically after selecting a chat (desktop layout unchanged); 44pt minimum touch targets throughout; list rows with native-style pressed states; switching between chat, tasks and terminal views that feels instant (no layout jumps); and a scroll position that's preserved per view. Follow the HIG notes in MOBILE.md and ~/.claude/skills/apple-design. Verify with before/after iPhone-emulated screenshots plus one desktop screenshot in .agent-orch/shots/. Mark the group B items Fixed or Deferred.

## Done when

`node --check public/app.js && npm test` passes, and .agent-orch/MOBILE.md group B items are marked Fixed or Deferred with a reason
