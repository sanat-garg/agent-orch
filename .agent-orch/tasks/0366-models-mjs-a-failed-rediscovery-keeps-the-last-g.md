# Task #366: models.mjs: a failed rediscovery keeps the last good model list, never saves an empty one over it, and retries hourly

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:45  
- files: models.mjs, test/models.test.mjs

## Prompt

Bug (verified in the code, BRIEF goals 7 and 8): models.mjs `refresh` calls `setModelCatalog(id, e)` with whatever `discover(id)` returned, then `save()`. When the daily rediscovery fails transiently (the CLI times out on a loaded VPS, a network blip, a sign-in hiccup) it returns `{models: [], error, at}`, so a good cached list is replaced by an empty one in memory AND in <DATA>/models.json. That agent's model selector is then empty until the next day (or a sign-in change), health.mjs reports 0 models, and delegate.mjs's `listed()` treats the agent as having no models, so fallbacks skip it.

Fix in models.mjs (keep the module's terse style and update its header comment):
1. In `refresh`, when the result has an `error` and the current catalog (`modelCatalog(id)`) holds a non-empty list, keep the previous `models` and `at`, and store the failure as `error` plus `failedAt: Date.now()`; log `${id}: rediscovery failed, keeping N models (${error})`. A first-ever discovery that fails still stores the empty list with its error (unchanged). A success clears `error` and `failedAt`.
2. `save()` must therefore never write an empty list over a non-empty one for the same agent (follows from 1; assert it in the test by reading models.json).
3. `refreshStale` treats an entry whose last attempt failed as stale after `retryMs` (new option, default 3600e3) instead of `intervalMs`, so the hourly tick retries; the `minGapMs` coalescing still applies. Keep `last` as the time of the last attempt so the gap logic is unchanged.
4. `load()` restores `failedAt`/`error` alongside `models` so a restart keeps the same behaviour.

Tests in test/models.test.mjs (copy the existing model-store tests' injectable `discover` and temp file setup): (a) a successful discovery of 2 models, then a failing one → `get(id).models` still has 2, `error` is set, models.json on disk still lists 2; (b) after that failure, `refreshStale` with `intervalMs` of a day and `retryMs` of 1 ms runs discovery again, and a success clears `error`; (c) a first discovery that fails still gives an empty list with the reason (existing behaviour). Check that health.mjs and any UI reading of the catalog (grep `modelCatalog` / `models.json` consumers) tolerate the extra `failedAt` field; do not change agents.mjs unless `setModelCatalog` drops unknown fields.

Verify with `npm test -- test/models.test.mjs`.

## Done when

`npm test -- test/models.test.mjs` passes and `grep -q failedAt models.mjs`
