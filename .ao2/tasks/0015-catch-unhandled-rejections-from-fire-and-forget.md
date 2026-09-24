# Task #15: Catch unhandled rejections from fire-and-forget calls (AUDIT #4)

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-24 23:37  
- starts after: #14

## Prompt

Fix AUDIT.md item #4 in /home/ubuntu/claude-web/server.mjs. `syncGit(...)` is called without await in the chat `result` handler (~line 780) and in `onCommit` (~line 568), and the 3-minute GitHub retry is an async setInterval callback (~line 596). A throw from any of them (e.g. fs errors in github.mjs ensureLocalRepo, or saveConvos) is an unhandled rejection that kills the server. Add `.catch(e => console.error(...))` at these call sites, wrap the interval body in try/catch, and add a `process.on('unhandledRejection', ...)` handler that logs instead of exiting (keep uncaughtException behaviour unchanged). Grep for any other un-awaited async calls in server.mjs and orchestrator.mjs and handle them the same way. Never restart the live server; test with `PORT=3999 CW_DATA_DIR=$(mktemp -d) node server.mjs` and kill only that process. In .ao2/AUDIT.md, mark #4 as **Fixed**.

## Done when

`grep -n "unhandledRejection" server.mjs` finds a handler, `npm test` passes, and AUDIT.md marks #4 Fixed
