# Task #69: Sidebar Connections panel: connect/disconnect Claude, Codex, Antigravity, GitHub

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 08:21  
- starts after: #4

## Prompt

Add a 'Connections' section to the sidebar (public/index.html, public/app.js, public/app.css) using GET /api/connections plus WebSocket updates. Each row shows: agent icon/label, a status dot (connected as <account> / not signed in / not installed) and a Connect or Disconnect button. Connect calls POST /api/connections/:id/start and opens a small inline panel with the sign-in link (it opens in a new tab), the one-time code with a copy button, and, where the flow needs it, an input to paste the authorization code back (POST .../code), plus a cancel button. On success it collapses into 'Connected'. Match the existing sidebar style and the drawer components. Make the model picker's 'sign in: …' hints (from the earlier multi-agent UI work) link to this panel. Test on a separate port with CW_DATA_DIR=$(mktemp -d); never touch the live server.

## Done when

public/index.html contains the Connections section, `node --check public/app.js` passes, and `npm test` passes

## Result — done (check passed) (2026-09-25 08:44)

AGENT-ORCH-STATUS: done — sidebar Connections panel added; browser flow verified and tests pass
