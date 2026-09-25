# Task #97: Make rate limits fully independent per agent (chat and workers)

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22

## Prompt

Bug: the owner sent a chat prompt with an Antigravity model selected and was told 'usage limit reached', but it was CLAUDE's limit. Cause: orchestrator.mjs uses a single global blockedUntil() (kv 'blocked_until', ~line 1008) for Claude, while other agents use kv 'blocked_until:<agent>'. planTurn (~line 1321) checks the global Claude block regardless of the agent the chat will run on, and the worker loop (~lines 1380, 1550) stops claiming ALL tasks when Claude is blocked, even tasks routed to codex/antigravity. Fix: 1) Add blockedUntilFor(agent) and a limitReset per agent. Keep the Claude kv keys working, or migrate them. 2) planTurn resolves the agent the turn will use (the chat's selected agent/model, or the planner's route) and only defers if THAT agent is blocked. The notice names the agent: 'Saved. Claude is at its usage limit until …'. If the chosen agent is blocked and the chat has Auto Delegate on (added later; for now, only an explicit per-message flag), don't fall back silently. 3) Worker scheduling: when Claude is blocked, still claim tasks whose resolved agent is available. Only skip tasks whose resolved agent is blocked. routeFor's fallback-to-Claude for blocked agents must not route onto a blocked Claude. 4) state()/pushState exposes blocks per agent ({claude:{until,reason}, codex:…}), and the UI's 'Usage limit reached · resumes …' banner (public/app.js ~line 2016) shows per-agent text. 5) The server-side non-Claude chat path (server.mjs, runAgentCli for chats) must check only its own agent. Add tests: a Claude block doesn't defer an antigravity chat turn; a Claude block doesn't stop claiming a codex-routed task; an antigravity block doesn't affect Claude.

## Done when

`npm test` passes with the three new independence tests

## Result — done (check passed) (2026-09-25 14:01)

AGENT-ORCH-STATUS: done — per-agent rate limits independent; npm test passes (138)
