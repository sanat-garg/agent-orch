# Task #376: health.mjs: a kept-but-stale model list is reported as an error with its date, not as healthy

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:54  
- files: health.mjs, bin/agent-health.mjs, test/agent-health.test.mjs

## Prompt

Reliability follow-up to task #366 (models.mjs now keeps the last good model list when a rediscovery fails and stores `error` and `failedAt` beside it; read models.mjs's header for the exact fields). health.mjs healthRow only mentions models.error when the count is 0, so an agent whose daily refresh has been failing for days looks healthy while the Connections modal and delegation quietly use an old list (BRIEF goal 7: honest data). Change healthRow so that when `models.length > 0` and `models.error` is set, `row.errors` gets `models: using the list from <ISO date of models.at> (refresh failed: <error>)` and `row.models` carries `stale: true` and `failedAt`; it stays out of `problems` (ok stays true) because the agent can still run. When `at` is missing say 'an earlier list'. Keep bin/agent-health.mjs printing errors as it does (check it shows `errors`, not only `problems`; adjust only if it hides them). Update the header comment. Tests in test/agent-health.test.mjs: a catalog entry {models: [..1], error: 'timed out', at: <ms>, failedAt: <ms>} gives ok true, models.stale true and one errors entry containing 'refresh failed'; an entry with models and no error gives no such error; 0 models with error still a problem. Run only `npm test -- test/agent-health.test.mjs`.

## Done when

`npm test -- test/agent-health.test.mjs` passes and `grep -q 'refresh failed' health.mjs`
