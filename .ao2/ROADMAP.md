# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-24 (reflect #13)._ Goal 1 (repo hygiene and README) is done, and `npm test` passes 4 smoke tests.
Goal 2 is half done: .ao2/AUDIT.md lists 15 verified bugs, but none of them are fixed yet. The worst one (#1) lets
one unauthenticated request with a malformed cookie crash the live server. Items #2–#4 can double-run tasks,
orphan chat runtimes, or crash the process. The Definition of Done needs every audit item fixed or explicitly
deferred, so the fixes come before any new features. Each fix should add a regression test where that's practical.

## Next (queued)
1. AUDIT #1: make cookie parsing crash-proof and add a request-handler try/catch, plus a regression test.
2. AUDIT #4: catch the unawaited promises and async intervals, and add an unhandledRejection backstop.
3. AUDIT #2: add an orchestrator lock file so a second instance on the same data dir can't steal tasks.
4. AUDIT #3: fix the chat context rollover that orphans the new runtime.
5. AUDIT #7: stop silently losing messages sent while the WebSocket is reconnecting.

## After that (not queued yet)
- AUDIT #8 login lockout race, #9 expired sessions keep their WebSocket, #14 oversized body hangs (small security batch).
- AUDIT #6 deleting a chat mid-plan, and #5 planner concurrency and duplicate plan tasks.
- AUDIT #10 async git in the orchestrator, #11 cancel the runCheck process group.
- AUDIT #12 ensureRepo dedupe, #13 per-line JSONL parsing, #15 claude-shell unit name.
- Mark each AUDIT.md item as fixed (with the commit) or deferred, to close out the DoD.

## Ideas / Later (goal 3: usability)
- Unit tests for orchestrator.mjs scheduling (with the SDK stubbed) and for the task-block parser.
- UI polish pass: mobile layout, connection-status indicator, task log readability.
- Split app.js (2.4k lines) into modules if it keeps growing (no build step, so native ESM imports).
