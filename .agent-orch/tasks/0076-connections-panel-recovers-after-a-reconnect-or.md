# Task #76: Connections panel recovers after a reconnect or restart; kill orphaned login tmux at boot (AUDIT #23)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 09:09  
- starts after: #75

## Prompt

Fix AUDIT.md item #23 (read the full finding in .agent-orch/AUDIT.md). Three changes: (1) In /home/ubuntu/agent-orch/public/app.js, call refreshConnections() in the WebSocket onopen handler, alongside the existing status refetch, so a reconnect loads the real login state. (2) In connections.mjs, cancel() should return the current login, or null when there isn't one. In app.js, connAction should apply that result even when it's null, so a stale 'Signing in…' state clears. (3) When createConnections starts up, run `tmux -L agent-orch-login kill-server` and ignore errors, so login sessions orphaned by a previous server process are cleaned up. Tests: in test/connections.test.mjs, check that createConnections issues kill-server on the login socket at startup (fake tmux) and that cancel with no login returns {ok:true, login:null}. Run `node --check public/app.js`. Mark #23 Fixed in AUDIT.md.

## Done when

`npm test` passes with the new startup kill-server and cancel-returns-null tests, `node --check public/app.js` succeeds, and AUDIT.md marks #23 Fixed.

## Result — done (check passed) (2026-09-25 09:19)

AGENT-ORCH-STATUS: done — Connections panel reloads on reconnect; orphaned login tmux killed at boot
