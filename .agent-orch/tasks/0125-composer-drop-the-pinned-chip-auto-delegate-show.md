# Task #125: Composer: drop the Pinned chip; Auto Delegate shows the start model plus likely fallbacks

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 19:28

## Prompt

In public/app.js the composer chip (~lines 1366-1400, the function that renders 'Auto' or the pinned model, with the title 'Pinned: tasks from this chat stay on this model') must change. 1) When a specific model is selected, show NO chip or label at all; the model selector itself says what's used. 2) When 'Auto Delegate' is selected, show a compact, tappable summary next to the selector: the start model plus the fallbacks most likely to be used, e.g. 'Opus 5 → GPT-6 Sol → Gemini 3.1 Pro'. Each entry has a status dot (available / near limit / limited until <time>), and unavailable ones are greyed with the reason. Tap or click opens a small popover (a bottom sheet on mobile) listing the ranked candidates with their key metrics (Coding Index, Agentic Index, Terminal-Bench) and the reason from delegate.mjs, plus the data source (Artificial Analysis or manual). 3) Backend: add GET /api/delegate/preview?agent=&model=&category= (login-protected) that uses createDelegator/rankCandidates in delegate.mjs to return the start model plus the top 3 comparable candidates with availability (per-agent blocks and usage windows). Default the category to 'coding'. Push updates when limits change (reuse the existing state broadcast), or re-fetch on the WebSocket 'state' message, so the preview stays live. 4) It must not overflow the composer: it collapses to 'Start model +2' under ~420px. Tests: a server test for the preview endpoint using fixture metrics, where a blocked agent's model is marked unavailable and ranked after available ones. Test the UI on a separate port with CW_DATA_DIR=$(mktemp -d) and CW_NO_ORCHESTRATOR=1, with desktop and 390px screenshots via bin/shot.mjs.

## Done when

`npm test` passes with a /api/delegate/preview test, and `! grep -n "Pinned:" public/app.js` finds no pinned label
