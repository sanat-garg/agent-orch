# Task #100: Sidebar footer: drop the 'N/N signed in' count

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22  
- starts after: #94

## Prompt

In the sidebar footer connection button (public/app.js, where the footer text is built as e.g. 'Connected · 4/4 signed in'), remove the count. The footer shows 'Connected' (or 'Connecting…'/'Offline') with the status dot. Only when an agent that's actually used (the chat agent or one in the routing rules) is signed out, append a short warning such as '· Codex signed out' with the warning tint. Keep the click-to-open Connections modal.

## Done when

`! grep -nE "signed in\`|/\$\{.*\} signed in" public/app.js` finds no N/N count, and `node --check public/app.js && npm test` passes

## Result — verify failed (1) (2026-09-25 14:25)

Command: ! grep -nE "signed in\

bash: -c: line 1: unexpected EOF while looking for matching `"'
