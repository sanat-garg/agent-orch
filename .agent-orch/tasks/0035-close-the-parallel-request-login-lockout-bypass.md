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

## Result — done (2026-09-25 03:48)

I fixed the login lockout bypass (AUDIT #8): a burst of parallel requests can no longer get extra password guesses. The Done-when check passes: `npm test` shows the new lockout test, and the full suite passes (47 pass, 0 fail).

- **What was actually wrong:** after the 5th failure, the unfixed server already answered 429 to the rest of the burst, but it still checked each of those passwords first. So a correct password hidden in the burst would have logged in.
- **Fix (`server.mjs`):** the login handler checks the lock again after reading the request body, right before the password check. `recordFailure` now deletes old entries, so the attempts map no longer grows forever.
- **Test (`test/server.test.mjs`):** it sends the headers for 11 requests first, then 10 wrong-password bodies, then the correct password last. It asserts that at most 5 got a "wrong" answer, the rest got 429 "locked", and the correct password was refused with 429. The requests use a fake client IP (203.0.113.8) so the lockout doesn't affect other tests. I confirmed the test fails on the old `server.mjs` and passes with the fix.
- **AUDIT #8** is marked **Fixed** with a one-line note.

The live `data/` and the running server were not touched. The fix only takes effect once the server is restarted.

AGENT-ORCH-STATUS: done — parallel login bursts now hit lockout; regression test passes
