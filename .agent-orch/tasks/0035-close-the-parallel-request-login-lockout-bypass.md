# Task #35: Close the parallel-request login lockout bypass (AUDIT #8)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:42  
- starts after: #34

## Prompt

AUDIT #8 in .agent-orch/AUDIT.md: in server.mjs's login handler (~line 944), lockedFor(ip) is checked before `await readBody(req)`, so a concurrent burst tests N passwords. recordFailure also resets count to 0 after the 5th failure, and the attempts map is never pruned. Fix it: re-check lockedFor(ip) after readBody, immediately before the synchronous checkPassword, and prune expired entries in recordFailure. Add a regression test in test/server.test.mjs: set a password in a temp CW_DATA_DIR (follow the existing tests' setup), fire about 10 wrong-password POSTs in parallel, and assert that at most 5 got a normal 'wrong password' response and the rest were rejected as locked (429 or whatever status the lockout uses). Mark AUDIT #8 **Fixed** with a one-line note. Never touch the live data/ or restart the live server.

## Done when

`npm test 2>&1 | grep -qiE 'lockout|parallel' && npm test`
