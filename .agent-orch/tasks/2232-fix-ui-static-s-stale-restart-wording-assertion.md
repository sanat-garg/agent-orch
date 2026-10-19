# Task #2232: Fix ui-static's stale restart-wording assertion

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-10-19 14:11  
- files: test/ui-static.test.mjs

## Prompt

test/ui-static.test.mjs, test 'the sidebar gear opens Settings: …' (around line 149), fails: it asserts appJs matches /O\.state\?\.parallel\?\.applyUpdates === 'idle' \? 'Restarting once idle \(automatic\)…'/, but public/app.js now builds that text in the pure helper `updateBannerView(upd, draining, applyUpdates)` as `applyUpdates === 'idle' ? 'Restarting once idle (automatic)…' : 'Restarting after running tasks finish…'`. Update only that assertion so it checks the current wording (both branches of the ternary) inside updateBannerView. Don't change public/app.js. Only edit the test file.

## Done when

`npm test -- test/ui-static.test.mjs` passes.

## Result — done (check passed) (2026-10-19 14:12)

AGENT-ORCH-STATUS: done — ui-static assertion now matches updateBannerView restart wording
