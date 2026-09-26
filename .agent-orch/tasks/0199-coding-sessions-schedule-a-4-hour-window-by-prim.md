# Task #199: Coding sessions: schedule a 4-hour window by priming every CLI's 5-hour limit

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 14:32  
- files: sessions.mjs, orchestrator.mjs, server.mjs, test/sessions*.test.mjs

## Prompt

Let the owner schedule a manual coding session. The idea: if each CLI's 5-hour usage window is started exactly 3 h before the session, the session begins in the window's last 2 h, and a fresh 5 h window starts 2 h in, so the owner gets about 4 h of uninterrupted heavy use across two windows. Backend (sessions.mjs + orchestrator.mjs): 1) A coding session is {id, startAt, durationMin (default 240), agents: [agent[@account]...] (default: all signed-in agents with 5 h windows), status}. Store it in the DB, with endpoints GET/POST/PATCH/DELETE /api/sessions. 2) Priming: at startAt − 3 h, for each selected agent/account, check whether a 5 h window is already running. If none, or if its reset wouldn't land within the session's first 2-2.5 h, send the smallest possible request ('Reply with OK', cheapest model, no tools) to start the window. Record the resulting resetsAt and verify it lands at about startAt + 2 h. If an existing window would make the alignment impossible, report the best achievable alignment. 3) Protection: from priming until the session ends, the orchestrator must not spend the selected agents' current window beyond a small reserve (configurable, default: keep ≥ 70% of the 5 h window free before the session). Queued autonomous work runs on other agents or waits, and during the session itself, autonomous tasks don't use the owner's selected agents at all (they pause or delegate per fallbacks). 4) Events and notices: 'Session at 6:00 PM: windows primed at 3:00 PM; Claude resets 8:00 PM, Codex 8:02 PM'. Handle a server restart during priming. Tests with a fake clock and stub adapters: the priming time, skipping priming when an aligned window already exists, the reserve enforcement, and no autonomous task on selected agents during the session.

## Done when

`npm test` passes with fake-clock tests for priming at start−3h, skip-when-aligned, the pre-session reserve, and in-session exclusion
