# Task #41: UI: show logged-out agents as needing sign-in in picker and routes list

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:50  
- starts after: #40

## Prompt

In /home/ubuntu/agent-orch, GET /api/agents already returns `loggedIn` per agent (see agentStatus in agents.mjs and the handler in server.mjs), and orchestrator routing falls back to Claude for logged-out agents. The chat agent picker in public/app.js (`renderAgentPicker`, around line 1095) only uses `a.available`, so an installed but logged-out agent such as Codex looks selectable and its chat turns fail on auth. Change it so a group is disabled unless `a.available && a.loggedIn !== false`. The label says `(not installed)` when not available and `(not logged in: <login command>)` when installed but logged out (use the adapter's existing `login` hint field, or add one to the /api/agents payload if it's missing). In the project routes list (search app.js for where `routes` are rendered with the delete button), add a small muted note like 'not logged in, falls back to Claude' next to a route whose agent is logged out, using the same AGENT_LIST data. Keep vanilla JS and the existing style. If server.mjs needed a payload change, extend test/server.test.mjs or test/agents.test.mjs to assert /api/agents entries include `loggedIn` and `login`. Run `npm test`.

## Done when

`grep -q loggedIn public/app.js` and `npm test` passes
