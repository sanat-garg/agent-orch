# Task #52: Show route fallback reason on the task's agent badge

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 04:05  
- starts after: #51

## Prompt

In /home/ubuntu/agent-orch, resolveRoute (orchestrator.mjs ~453) returns {fellBack, reason} when a routed agent (codex/antigravity) isn't installed or logged in, and the task runs on Claude. Today that is only a logEvent (~line 1135), so the task card's agent badge (public/app.js ~1117, built from ran_agent/ran_model) just says 'claude' with no explanation. Add a nullable tasks column `route_note` via the existing added-columns migration list (~line 778). Set it to e.g. 'codex not logged in, ran on Claude' next to where ran_agent is set (~line 1410), or NULL when there was no fallback. Include it in the task view object (~line 1646). In app.js, when route_note is set, give the badge a warning style (reuse an existing warn/needs-sign-in class from app.css if there is one) and put the note in its title tooltip. Add a test in test/routing.test.mjs or a new file asserting that the task view carries route_note after a fallback run. You can drive the orchestrator in a child process with a fake query, as test/planner-guard.test.mjs does, and use agents.clearLoginCache and a PATH without codex. Don't restart the live server; test on another port if needed.

## Done when

`npm test` passes, and `grep -n route_note orchestrator.mjs public/app.js` shows the column set in orchestrator.mjs and rendered in app.js

## Result — done (check passed) (2026-09-25 04:12)

AGENT-ORCH-STATUS: done — fallback reason stored in route_note and shown on badge
