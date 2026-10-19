# Task #2235: 'Since you were away' group at the top of the Queue, from digest.mjs, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:11  
- files: server.mjs, public/app.js, public/app.css, test/digest-api.test.mjs, test/ui-digest.test.mjs

## Prompt

digest.mjs (see its header and test/digest.test.mjs) returns what finished, failed or needs the owner since a time, per project, but it isn't wired. 1) server.mjs: GET /api/orch/digest?since=<epoch ms> → digest({dbFile: the orchestrator DB path the server already uses, since, now: Date.now()}). For a non-admin, filter to their own projects as other /api/orch routes do, and check `userBlocked`'s allowlist. Put the route near `/api/orch/approvals` (~line 2524). A missing or bad `since` = the last 24 h. 2) public/app.js: when the Queue sheet opens (and in the Machines window's queue, which borrows #qBody), if the owner was away more than 30 minutes (localStorage `cw.digestSeen`, updated when they dismiss it or close the Queue), show a compact 'Since you were away' card at the top of #qBody: counts (done / failed / needs you), then up to 5 rows per kind with project name, task title and result line, each opening its task drawer (`openTask`/`routeHash` style `#task-<id>`), plus a Dismiss button. Show nothing when all counts are 0. Times are formatted in the browser only. Styles go in public/app.css with phone sizes per CONTEXT.md. Tests: test/digest-api.test.mjs spawns server.mjs on a free port with a temp CW_DATA_DIR (never import it) and checks the JSON shape and a `since` in the future giving empty lists; test/ui-digest.test.mjs (playwright-core, stubbed fetch) checks the card renders with counts and Dismiss hides it.

## Done when

`npm test -- test/digest-api.test.mjs test/ui-digest.test.mjs test/digest.test.mjs` passes.

## Result — done (check passed) (2026-10-19 14:19)

The pre-existing `ui-static` failure is unrelated: it's on HEAD at app.js:4086, which this change doesn't touch. All three Done-when test files pass.

AGENT-ORCH-STATUS: done — Queue shows 'Since you were away' digest card; tests pass
