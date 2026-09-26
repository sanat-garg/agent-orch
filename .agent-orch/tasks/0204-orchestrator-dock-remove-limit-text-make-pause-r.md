# Task #204: Orchestrator dock: remove limit text, make Pause/Resume prominent

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 14:32  
- files: public/index.html, public/app.css, public/app.js

## Prompt

In the orchestrator dock above the chat prompt (the bar with #obStatus, #obCounts, #obQueue, #obSettingsBtn and #obPause in public/index.html ~lines 117-140), remove the raw limit status text such as 'Claude: five_hour reached · re…' from #obStatus; that information lives in the usage card and the task statuses. Keep the status short: 'Running 2 · 5 queued', 'Paused' or 'Idle'. Make Pause/Resume a prominent button: a filled primary style when the orchestrator is paused ('▶ Resume', accent background), and a clear secondary style with a pause icon when running ('⏸ Pause'), at least 36px tall (44px on touch), with a label always visible (not icon-only) and a confirmation-free toggle with an immediate visual state change. Make sure the dock doesn't wrap awkwardly at 390px. Screenshots on desktop and mobile, paused and running.

## Done when

`node --check public/app.js && npm test` passes, `! grep -n "reached · re" public/app.js`, and #obPause renders with distinct paused/running button styles
