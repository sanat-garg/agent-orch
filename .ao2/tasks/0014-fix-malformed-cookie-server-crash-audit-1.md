# Task #14: Fix malformed-cookie server crash (AUDIT #1)

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-24 23:37

## Prompt

Fix AUDIT.md item #1 in /home/ubuntu/claude-web. `parseCookies` in server.mjs (~line 83) calls decodeURIComponent without a try/catch. A request with `Cookie: cw_session=%E0%A4%A` throws URIError inside the async HTTP handler and the upgrade handler, and the process exits. (1) Wrap the decode in try/catch and skip bad parts. (2) Wrap the body of the async HTTP request handler (~line 930) in try/catch: log the error and answer 500 if headers haven't been sent yet. Guard the WebSocket upgrade handler (~line 1119) the same way, destroying the socket on error. (3) Add a regression test to test/server.test.mjs: send the malformed cookie to /api/status, expect a non-crash response (401 or similar), then check that a normal request still succeeds. Follow the existing test pattern (spawn server.mjs on a free port with CW_DATA_DIR set to a temp dir). Never restart the live server. (4) In .ao2/AUDIT.md, mark item #1 as **Fixed** with a one-line note.

## Done when

`npm test` passes and includes a test that sends `Cookie: cw_session=%E0%A4%A` and then gets a successful follow-up request

## Result — done (check passed) (2026-09-24 23:37)

AO2-STATUS: done — malformed cookies no longer crash the server; regression test passes
