# Task #101: Collapsible sidebar with remembered state

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22  
- starts after: #100

## Prompt

Make the sidebar collapsible (public/index.html, public/app.js, public/app.css). On desktop, a toggle button in the sidebar header plus one at the top-left of the main header when collapsed, and the shortcut Cmd/Ctrl+B. Collapse slides the sidebar out with a 200 ms transform transition (prefers-reduced-motion: none), the chat area expands, and the state persists in localStorage. On narrow screens (<768px), the sidebar is off-canvas by default and opens as an overlay drawer with a dimmed backdrop, closes on backdrop tap, Esc or a left swipe, and closes automatically after selecting a chat. Provide proper aria-expanded/aria-controls. Extend the static UI smoke test for any new ids.

## Done when

`node --check public/app.js && npm test` passes, and app.js stores the sidebar collapsed state in localStorage and binds Cmd/Ctrl+B
