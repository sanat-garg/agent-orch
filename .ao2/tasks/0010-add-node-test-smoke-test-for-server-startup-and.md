# Task #10: Add node:test smoke test for server startup and login

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-24 23:31

## Prompt

Set up a real `npm test` for this repo (claude-web / agent-orch). Use only Node's built-in test runner (`node --test`), with no new dependencies. Set package.json "test" to `node --test test/`. Create test/server.test.mjs. It should start `node server.mjs` as a child process on a free port (e.g. PORT=3999) with a TEMPORARY data directory if server.mjs supports one via env; if it doesn't, add a minimal env override such as CW_DATA_DIR in server.mjs (default unchanged) so tests never touch the real data/. Assert that: (1) GET / without a cookie redirects to or serves the login page, (2) static assets like /login.css return 200, (3) a protected API route returns 401/redirect without a session. Kill the child in teardown. Never restart or kill the live server on port 3000. Also fix package.json name/description to describe the app (name: agent-orch).

## Done when

`npm test` exits 0 and runs at least 3 passing tests

## Result — done (check passed) (2026-09-24 23:32)

AO2-STATUS: done — npm test runs 4 passing server smoke tests
