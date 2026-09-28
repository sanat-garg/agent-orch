# Task #336: tests: worker-status.mjs serveStatus and request over a real unix socket

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:46  
- files: test/worker-status.test.mjs, worker-status.mjs

## Prompt

worker-status.mjs (a worker's status daemon socket and terminal view) has no test of its socket lifecycle; only renderStatus is covered (test/worker-cap.test.mjs). Add test/worker-status.test.mjs (node:test, no deps, copy the style of test/worker-cap.test.mjs) that uses `serveStatus({home, answer, log})` and `request(home, req)` on a temp home (`fs.mkdtempSync` under os.tmpdir(); use a SHORT home for most tests) and covers: (1) a `{op:'status'}` request gets `answer`'s reply, and three requests on one connection are answered in order even when `answer` for the first resolves last (chain ordering); an `answer` that throws yields `{ok:false, error}`; (2) a stale socket file left by a dead daemon (create the file with fs.writeFileSync, or listen then close the server without removing the file) is replaced and the new daemon serves; (3) a second `serveStatus` on a home whose daemon answers rejects with an error matching /already runs/; (4) a client that sends more than 64 KiB without a newline is destroyed (request rejects / socket closes) and the server keeps serving the next client; (5) a home whose socket path is longer than 100 characters (nest deep directories under the temp dir) still binds and answers; (6) `close()` removes the socket file and drops a connected client (a `net.connect` left open gets 'close'); (7) `request` on a home with no socket rejects with code ENOENT, and on a socket file nobody listens on with ECONNREFUSED. Every test must close its servers and sockets in a finally so the run does not hang. Keep it fast (< 10 s). Run it with `node bin/test.mjs test/worker-status.test.mjs`. Do not change worker-status.mjs unless a test exposes a real bug; if it does, fix it minimally and say so in the JOURNAL entry.

## Done when

`node bin/test.mjs test/worker-status.test.mjs` passes and `grep -c '^test(' test/worker-status.test.mjs` prints at least 6
