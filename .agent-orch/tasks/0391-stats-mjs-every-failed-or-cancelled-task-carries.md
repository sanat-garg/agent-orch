# Task #391: stats.mjs: every failed or cancelled task carries a classified `why`, and the snapshot a `failures` summary

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 13:14  
- files: stats.mjs, test/stats.test.mjs

## Prompt

In stats.mjs (read its header: it only collects; the browser formats) add `result` to the tasks SELECT in `fromDb` (guard: the column exists in every DB, but keep the `all()` try/catch) and give each task row a `why` (null for other statuses) from tasks.result for status 'failed' or 'cancelled', via an exported pure `failureWhy(status, result)` → {kind, text}: kinds 'check' ("done-when check failed" / "failed (verification)"), 'setup' ("setup failed:"), 'blocked' ("blocked: #N", with `task: N`), 'gave-up' ("still not done after N sessions"), 'push' ("Command failed: git push" or "push failed"), 'browser' (Playwright / browser tool server), 'cascade' ("cancelled with #N" or "cancelled with integrator #N", with `task: N`), 'cancelled' (status cancelled with an empty or unmatched result), else 'other'; `text` is the result's first line clipped to 120 chars with any AGENT-ORCH-STATUS marker stripped (see browser-task.mjs for the marker shape). Also add `failures: [{kind, n, tasks: [id, …newest first, at most 5]}]` sorted by n to the snapshot so the UI needs no second pass. Keep the module read-only and every time in epoch ms. Tests in test/stats.test.mjs: a unit test over failureWhy for each kind (use the real strings above) and extend the createStats join test's seeded DB with one failed task (result 'blocked: #187 (unfinished)') and one cascade-cancelled task, asserting their `why` and the `failures` rows. Run only `npm test -- test/stats.test.mjs`.

## Done when

`npm test -- test/stats.test.mjs` && `grep -q 'export function failureWhy' stats.mjs`
