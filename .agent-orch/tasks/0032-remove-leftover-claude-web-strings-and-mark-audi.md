# Task #32: Remove leftover Claude Web strings and mark AUDIT #2 and #15 fixed

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:42

## Prompt

The product is named agent-orch (see .agent-orch/BRIEF.md goal 4). A few old names remain: orchestrator.mjs line 1 comment ('running inside Claude Web'), PLANNER_SYSTEM (~line 120, 'running inside the owner's Claude Web'), the git identity GIT_ID (~line 1050: user.name=Claude Web Orchestrator, user.email=orchestrator@claude-web.local; change to 'agent-orch Orchestrator' / orchestrator@agent-orch.local), and server.mjs line 1 comment, which says /term/ although Caddy serves the terminal at /shell/. Fix these. Keep the legacy regexes that still accept ao2/AO2 markers, and the README section about migrating old claude-web installs. Both are intentional. In .agent-orch/AUDIT.md, add a '- **Fixed** (task #16): ...' line under item #2 (the orchestrator lock file; confirm in orchestrator.mjs that it exists) and a '- **Fixed** (rename, tasks #20/#23): ...' line under item #15 (server.mjs slowMetrics now checks agent-orch-shell; confirm). Do not restart the live server.

## Done when

`! grep -niE 'claude[ -]web' orchestrator.mjs server.mjs && test $(grep -c '\*\*Fixed\*\*' .agent-orch/AUDIT.md) -ge 7 && npm test`

## Result — done (2026-09-25 03:43)

AGENT-ORCH-STATUS: done — Claude Web strings removed; AUDIT #2 and #15 marked fixed
