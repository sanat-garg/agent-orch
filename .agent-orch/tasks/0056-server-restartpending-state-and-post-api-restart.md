# Task #56: Server: restartPending state and POST /api/restart-when-idle

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 04:13  
- starts after: #55

## Prompt

Read .agent-orch/CONTEXT.md first. orchestrator.mjs now has `drain()` (task before this). In server.mjs: (1) At startup, record the boot commit with an async `git rev-parse HEAD` in the app dir (ignore failures). Expose `restartPending` (boolean) and `commitsSinceBoot` (from `git rev-list --count <boot>..HEAD`) in the existing state/status payload that the UI polls. Compute this async and cache it for about 30 s; never block the event loop. (2) Add an authenticated `POST /api/restart-when-idle` that sets a flag, calls orch.drain(), and when it resolves logs a line and calls process.exit(0). systemd has Restart=always, so the app comes back. A second call while draining just returns 202 again. It responds 202 immediately with {draining:true}. Add tests to test/server.test.mjs, or a new test file, running on a test port with CW_DATA_DIR=$(mktemp -d): the endpoint rejects unauthenticated requests, and with no running tasks an authenticated call makes the test server process exit with code 0. NEVER call this endpoint on the live server (port 3000) and never restart agent-orch.service.

## Done when

`npm test`

## Result — done (check passed) (2026-09-25 04:20)

AGENT-ORCH-STATUS: done — restart-when-idle endpoint and status fields added, all tests pass
