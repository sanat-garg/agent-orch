# Task #71: Audit round 3: sign-in connections, drain/restart-when-idle, limit notices

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 09:03

## Prompt

Read .agent-orch/BRIEF.md, CONTEXT.md and AUDIT.md first. Audit the code shipped in tasks #55-#69, which has not been reviewed yet: connections.mjs (tmux sign-in sessions: session lifecycle, timeouts, concurrent start/cancel, the tmux socket, the pasted-code path, agy live success/fail detection, the probe), the /api/connections/* routes and WS broadcast in server.mjs (auth checks, input validation, Claude logout confirm), orchestrator drain() plus POST /api/restart-when-idle and restartPending/commitsSinceBoot in /api/status, the app.js Connections panel and #updateBanner, the usage-limit `{until}` notices (limitReset, withUntil) and refreshRepo. Look for real bugs: races, leaked tmux sessions or processes, unhandled rejections, auth bypasses, injection, states the UI can get stuck in. Confirm each finding by reading the code, and reproduce it where cheap (use another PORT and CW_DATA_DIR=$(mktemp -d); never touch port 3000, never call the Claude logout with confirm:true, never call restart-when-idle on the live server). Append a section headed exactly `## Round 3` to .agent-orch/AUDIT.md, numbering items from #22, each with severity, file:line, the failure scenario and a suggested fix, in the style of the existing items. Do not fix anything in this task. If you find nothing real, say so in the section.

## Done when

`grep -q '## Round 3' .agent-orch/AUDIT.md`
