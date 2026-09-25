# Task #38: Close expired or revoked sessions' WebSockets (AUDIT #9)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:50

## Prompt

Fix AUDIT #9 in /home/ubuntu/agent-orch/server.mjs. The per-socket keepalive interval (search for `ws.close(4001, 'signed out')`, around line 1242) only checks `sessions[token]`. It ignores the session's `exp` and never calls `syncSessions()`, so expired sessions, or ones revoked by set-password rewriting sessions.json, keep receiving broadcasts and can keep sending commands. Change the interval so it calls `syncSessions()` first, then closes with 4001 when the session is missing or `s.exp < Date.now()`. Keep the existing terse style. Add a regression test to test/server.test.mjs that logs in, opens a WS, removes or expires the session in the temp CW_DATA_DIR's sessions.json, and asserts the socket closes with code 4001. If the 30 s interval is too slow for a test, make the interval period overridable with an env var (for example CW_WS_KEEPALIVE_MS) that the test sets low. Test servers MUST use CW_DATA_DIR=$(mktemp -d) and a free port. Never touch the live server on port 3000. Mark AUDIT #9 `**Fixed**` in .agent-orch/AUDIT.md with a one-line note.

## Done when

`grep -q 4001 test/server.test.mjs` and `npm test` passes
