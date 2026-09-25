# Task #36: Answer oversized request bodies with 413 instead of hanging (AUDIT #14)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:42  
- starts after: #35

## Prompt

AUDIT #14 in .agent-orch/AUDIT.md: readBody in server.mjs (~line 920) calls req.destroy() once the body passes 1 MB but never resolves or rejects, so the handler hangs. Make readBody settle on overflow, error and close, and have callers answer 413 on overflow (and 400 on a bad body) without crashing. Because the socket must still be able to carry the 413, prefer to stop reading, send 413 with 'Connection: close', and then destroy, rather than destroying first. Add a regression test in test/server.test.mjs: POST a body over 1 MB to the login endpoint (or another endpoint that reads a body), and assert that the client gets a 413 or a closed connection within 3 s instead of hanging, and that the server still answers a following GET. Mark AUDIT #14 **Fixed** with a one-line note. Use CW_DATA_DIR=$(mktemp -d) for test servers and never restart the live server.

## Done when

`npm test 2>&1 | grep -qiE '413|oversized' && npm test`
