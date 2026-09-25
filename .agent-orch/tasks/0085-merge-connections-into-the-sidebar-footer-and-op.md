# Task #85: Merge Connections into the sidebar footer and open it as a modal

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 10:08

## Prompt

Rework the sign-in Connections UI (public/index.html, public/app.js, public/app.css). Currently a 'Connections' card sits in the sidebar (index.html ~line 29, #connsTitle; the rendering code in app.js ~line 2540+) and expands inline, while the sidebar footer (index.html ~line 58, .side-foot with #connDot/#connText, set to 'Connected' around app.js line 1343) shows only the WebSocket status. Change it so that: 1) The inline Connections card is removed from the sidebar. 2) The footer becomes one clickable button (with aria-haspopup=dialog) that merges both statuses. It shows the server link dot plus a compact agent summary, e.g. 'Connected · 3/4 signed in', with a warning dot/tint when any agent the routes use is signed out and the existing 'Connecting…'/'Offline' states when the WebSocket is down. 3) Clicking it opens a proper modal window (reuse the existing .modal/.modal-backdrop/.modal-panel pattern of #serverModal/#awayModal, including Esc/backdrop close and focus handling) titled 'Connections'. The top row shows the app connection (live/offline, host); below it there's one row per agent (Claude, Codex, Antigravity, GitHub) with status, account and a Connect/Disconnect button. The sign-in flow (link, one-time code with copy, paste-code input, cancel) runs INSIDE the modal, not inline in the sidebar. 4) Any existing links to the Connections panel (e.g. the model picker's 'sign in' hints) open this modal. Keep the WebSocket/reconnect recovery behaviour from AUDIT #23. Test on a separate port with CW_DATA_DIR=$(mktemp -d) and CW_NO_ORCHESTRATOR=1, and never touch the live server.

## Done when

`npm test` passes (including the static UI smoke test that every $('id') exists in index.html), index.html has a #connsModal .modal and no sidebar Connections card, and the .side-foot element is a button

## Result — done (check passed) (2026-09-25 10:14)

AGENT-ORCH-STATUS: done — Connections now open as a modal from the sidebar footer button
