# Auto Delegate provider data check — task #132

Verified 2026-09-25. Cause: the saved connection is a valid **Free-tier** key, but the client requested only `/api/v2/language/models`, now a paid-tier endpoint. Read-only requests using the saved key returned **403** there and **200**, `tier: free`, 200 first-page models at `/api/v2/language/models/free`. No credentials were printed or changed. The service journal at 20:36:30 reported `Artificial Analysis rejected the API key`; no AA cache existed. The empty manual table then masked this failure as missing model metrics in the popup.

The [provider documentation](https://artificialanalysis.ai/data-api/docs) distinguishes 401 invalid credentials from 403 subscription access and documents `/language/models/free`. Free rows supply the three headline indices, performance and pricing, but omit per-benchmark scores. The fix retries the free endpoint on 403, retaining the full response for entitled keys; it never invents omitted scores.

Verified path: Connections POST `/api/aa/key` → server-only `secrets.json` → `createAAStore` fetch/pagination/cache → `matchModels` (CLI IDs, resolved names, labels, existing overrides) → orchestrator `delegatePreview` → authenticated `/api/delegate/preview` JSON → actual `renderAutoPreview`/row functions in Chromium. No model mapping or ranking change was needed. Saved per-chat fallback order, empty list and null/automatic semantics remain unchanged.

The metrics view and preview now carry `data_status` (loading, unconfigured, error, ready), a safe `data_error`, and `stale`. Ready data with an unmatched model has null metrics; missing individual scores remain null/absent and render as dashes. Provider errors preserve real cached values with a stale notice. Failures without cache remain provider errors rather than manual data. Initial loading polls for completion; popup request failures display a retry instruction.

## Automated regression

Command: `node --test test/aa.test.mjs test/delegate.test.mjs test/delegate-preview.test.mjs`

Result: **PASS — 21 tests, 21 passed, 0 failed** (2026-09-25).

The HTTP regression boots an isolated server with a saved mock key and stub CLI catalogs. The provider denies the full endpoint with 403 and serves representative paginated-envelope metrics from the free endpoint. Assertions cover provider headers, mapped start/fallback values in popup JSON, omitted benchmarks, unmatched curated models, loading, 503 with cached data, no configuration, and 401 without cache. Chromium executes the actual popup consumer against the HTTP response and asserts visible scores, dashes, unmatched-model messaging and distinct loading/configuration/error messages. Existing ranking, availability, and saved per-chat fallback regressions pass alongside it. Tests never call the real provider.

Additional check: `node --check public/app.js` passed.

## Visual evidence

Captured with `node bin/shot.mjs` against a spare-port (3998) fixture serving the actual popup render functions and CSS, with the same mocked provider-error state before and after:
- `.agent-orch/shots/delegate-data-before.png`: failure hidden behind “No metrics”.
- `.agent-orch/shots/delegate-data-after.png`: explicit provider error and Connections action.

The full popup simplification is reserved for task #133. The live server was not restarted; server changes apply on its next orchestrator-managed restart.
