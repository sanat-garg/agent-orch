# Task #180: Fix AUDIT #33: malformed WebSocket frames must not crash the server

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-26 10:52  
- files: server.mjs, test/ws-robust.test.mjs

## Prompt

Read .agent-orch/AUDIT.md finding #33. In server.mjs the `ws.on('message')` handler does `msg = JSON.parse(raw)` then reads `msg.t`; a text frame `null` (or `1`, `"x"`, `[]`) throws an uncaught TypeError and the process exits. Fix: after parsing, ignore anything that is not a plain non-array object (`if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;`), and wrap the whole handler body in try/catch that logs the error (console.error) and, if the socket is open, sends `{t:'error', text:'bad request'}`, so no future sync throw (answerPermission, setConvoMode, etc.) can take down the process. Add test/ws-robust.test.mjs, modelled on how test/server.test.mjs starts a test server and signs in: open /ws with the session cookie, send the frames `null`, `1`, `"str"`, `[]`, `{}` and `{"t":"open","id":{}}`, then check the server process is still alive and still answers an authenticated HTTP request. Keep the test fast (no fixed sleeps longer than needed). When done, append `- **Fixed** (task #<this id>): ...` under finding #33 in .agent-orch/AUDIT.md, matching the style of earlier Fixed lines.

## Done when

`node --test test/ws-robust.test.mjs test/server.test.mjs` passes

## Result — done (check passed) (2026-09-26 10:54)

AGENT-ORCH-STATUS: done — malformed WebSocket frames no longer crash the server; tests pass
