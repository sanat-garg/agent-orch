# Task #94: Usage modal: click the usage card to see limits over time per agent

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 10:31  
- starts after: #93

## Prompt

In the sidebar, the usage card (index.html ~line 37, .ms-usage with #usageTitle/#usNote) should open a 'Usage' modal on click (keyboard accessible: button semantics, Enter/Space), exactly like the server details window (#serverModal: same .modal/.modal-panel pattern, look and feel, and chart code/style; reuse its chart helpers rather than adding a chart library). Rename the card title from 'Claude usage' to 'Usage'; the refresh button keeps working and must not open the modal. Modal content, from GET /api/usage/history: a range switch 24h / 7d / 30d; then one section per agent (Claude, Codex, Antigravity; hide an agent with no data and show 'Not connected' with a link to the Connections modal when it's signed out). Each section shows: current status chips per window (e.g. '5-hour 42% · resets 3:10 PM', 'Weekly 18% · resets Tue', rendered in the browser's timezone); a line chart of window % over time with a dashed 100% line and reset markers; a bar chart of tokens per hour or day (input vs output); and a list of limit-hit events with when they cleared. Include hover tooltips with exact values and times, empty states, and live refresh while open (poll every 60 s or reuse the WebSocket). Make sure it works on mobile widths. Extend the static UI smoke test for the new ids. Test on a separate port with CW_DATA_DIR=$(mktemp -d) and CW_NO_ORCHESTRATOR=1, seeding usage.jsonl with sample data, and capture a screenshot with bin/shot.mjs into .agent-orch/shots/.

## Done when

`node --check public/app.js && npm test` passes, index.html has a #usageModal .modal, and clicking .ms-usage opens it (the handler wires .ms-usage to #usageModal in app.js)
