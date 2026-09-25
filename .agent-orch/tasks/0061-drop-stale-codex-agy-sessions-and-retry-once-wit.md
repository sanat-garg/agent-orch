# Task #61: Drop stale codex/agy sessions and retry once without resume (AUDIT #19)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 04:24  
- starts after: #60

## Prompt

Fix AUDIT #19 in .agent-orch/AUDIT.md (read it first). Resume recovery only recognises Claude's 'no conversation found' (orchestrator.mjs around lines 1257 and 1428, server.mjs agentChatTurn around line 847). Real codex prints 'thread/resume failed: no rollout found for thread id …'. In agents.mjs, have the codex and antigravity adapters set `res.errorCode = 'no_session'` when a resumed run fails because the session is missing. Match 'no rollout found' for codex, and a reasonable pattern for agy (see .agent-orch/AGENTS.md; if unsure, use /session.*not found|no such session/i). Add one small helper (e.g. `isMissingSession(res)`) that is true for either the Claude text or errorCode 'no_session', and use it in all three places. In chat, clear `convo.agentSession` and retry the turn once without resume. In the orchestrator, clear the task's session_id and retry once fresh, the same way the Claude path does. Add a stub-based test in test/agents.test.mjs (extend the fixtures in test/fixtures/) showing that a codex stub printing 'no rollout found' produces errorCode 'no_session'. Mark AUDIT #19 Fixed.

## Done when

`npm test` passes and `grep -n no_session agents.mjs orchestrator.mjs server.mjs` shows uses in all three files

## Result — done (check passed) (2026-09-25 08:53)

AGENT-ORCH-STATUS: done — Dead codex/agy sessions are now dropped and the turn retried fresh
