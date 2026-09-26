# Task #193: Parallel lanes view: see agents working side by side

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 12:52  
- starts after: #192  
- files: public/app.js, public/app.css, public/index.html, test/ui-lanes*.test.mjs

## Prompt

Make parallel work visible. Add a 'Lanes' strip at the top of the Queue modal (and a compact version in the orchestrator bar next to the queue count). There's one lane per agent account that's running or has recently run (Claude, Codex, Antigravity, OpenCode, Kiro, Copilot, and account labels if several), each showing its current task (title, #id, model, elapsed timer, a live activity line from the last tool event), or 'Idle' / 'Limited until 5:00 AM' / 'Signed out'. Include a header summary 'Running 3 in parallel · 5 queued ready', with the lanes updated live over the WebSocket. Tapping a lane opens its task drawer. When tasks belong to one parallel group, show a small group marker, and an 'Integrates #a #b #c' line on integrator tasks. It must work at 390px (lanes scroll horizontally, as cards). Use the running-lanes state from the parallel-first scheduling task, and fall back to deriving lanes from running tasks if that isn't available yet. Screenshots via bin/shot.mjs with seeded parallel tasks.

## Done when

`node --check public/app.js && npm test` passes, and the Queue modal renders a lanes strip with one lane per running agent (verified by a seeded UI test)

## Result — done (check passed) (2026-09-26 15:44)

That was the old monitor timing out. I'm still waiting for the new run to finish.
