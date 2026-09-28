# Task #410: health.mjs: a kept-but-stale model list is reported as an error with both dates, not as healthy (re-run of #376)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:00  
- files: health.mjs, bin/agent-health.mjs, test/agent-health.test.mjs

## Prompt

Task #376 failed in its git setup (a transient ref lock), never in the work, so do it now. models.mjs (since #366) keeps the last good model list when rediscovery fails and records `failedAt` (ms epoch) plus `error` on the catalog entry, with `at` still the date of the good list. health.mjs `healthRow(id, {models, ...})` ignores `failedAt`: such an agent shows N models and ok:true, and the Connections modal and bin/agent-health.mjs call it healthy although discovery has been failing for hours or days. Change `healthRow`: when `models.failedAt` is set and the list is non-empty, add to `row.errors` (not `problems`: the list still works) a line like `models: rediscovery failed <ISO date of failedAt> (<error>); showing the list from <ISO date of at>`, and expose `models.failedAt` and `models.stale: true` in the row so the UI can show it (the server only serialises the row; do not touch server.mjs or app.js). When the list is empty and failedAt is set, the existing `no models` problem stays and includes the error. bin/agent-health.mjs: print the stale line in the human output (it already prints errors) and exit 0 for stale-but-present (it is a warning, not a problem). Tests in test/agent-health.test.mjs (existing file): a stale entry yields ok:true, stale:true and the two dates in one errors line; a fresh entry has no such line; an empty list with failedAt is a problem. Run only that test file.

## Done when

`npm test -- test/agent-health.test.mjs` passes and `grep -c 'failedAt' health.mjs` prints a number of at least 1

## Result — done (check passed) (2026-09-28 14:02)

AGENT-ORCH-STATUS: done — stale model list now shows as warning error with dates
