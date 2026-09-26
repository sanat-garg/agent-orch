# LiveBench popup check — #138

Verified 2026-09-26 in Chromium, at 1280 × 812 and **375 × 812 CSS pixels**. Reused the completed #133 compact popup and #140 editor; retained the optional native score disclosure and saved-order controls. No engine policy changes.

## Real fetched data and engine parity

`node .agent-orch/livebench-ui-fixture.mjs` runs the actual popup markup, styles and render functions on isolated port 3998. It fetches through `createLiveBenchStore` into a temporary directory, then feeds `previewDelegation` with `rankingEntries`. No live server restart or credential modification.

Official release **2026-06-25**, fetched **2026-09-26T02:23:07.408Z**:
- Table: https://livebench.ai/table_2026_06_25.csv
- Categories: https://livebench.ai/categories_2026_06_25.json
- Release discovery: https://api.github.com/repos/LiveBench/livebench.github.io/contents/public

Exact model identities: starting `gemini-3.8-flash-high`, Coding **72.5**; fallback **1** `gemini-3.6-flash-high`, Coding **77.9**; fallback **2** `gemini-3.7-flash-high`, Coding **78.9**; fallback **3** synthetic `unmatched-model`, unscored. The lower of the two fallback scores comes first because it is closer to the start. Real category scores are not invented fixtures. Availability is controlled in this harness; no CLI quota is consumed.

`node .agent-orch/livebench-ui-browser-check.mjs` passed all **14 width/state combinations**. Each compares DOM row keys with `rankCandidates` or `curatedCandidates`, checks optional disclosure, LiveBench provenance, null-score states, and absence of Artificial Analysis/key/setup prompts. Browser errors: none.

States: real fetched data; unmatched starting identity; stale cache; unavailable data; loading; owner-defined order; owner-defined order with stale data. Owner order is `unmatched-model → gemini-3.6-flash-high → gemini-3.7-flash-high`, even though that puts an unscored model first. Stale/unavailable states have no ranking scores. Their copy does not claim benchmark comparability; stale owner order correctly says saved order still applies. Unmatched identities are never assigned a borrowed score.

| Width | Document scrollWidth | Popup clientWidth / scrollWidth (all states, details open) |
| --- | --- | --- |
| 1280 | 1280 | 438 / 438 |
| 375 | 375 | 375 / 375 |

No horizontal overflow. Compact and expanded screenshots were inspected; content wraps, the header stays reachable, and details scroll vertically.

## Browser evidence

Captured with `node bin/shot.mjs` and explicit `--width=1280` / `--width=375` (the helper's mobile preset is 390).

| State | Desktop | 375 pixels |
| --- | --- | --- |
| Before | [desktop](shots/livebench-ui-before-desktop.png) | [mobile](shots/livebench-ui-before-375.png) |
| Compact, real order and source/release/freshness | [desktop](shots/livebench-ui-compact-1280.png) | [mobile](shots/livebench-ui-compact-375.png) |
| Real score details | [desktop](shots/livebench-ui-real-1280.png) | [mobile](shots/livebench-ui-real-375.png) |
| Unmatched start | [desktop](shots/livebench-ui-unmatched-1280.png) | [mobile](shots/livebench-ui-unmatched-375.png) |
| Stale warning | [desktop](shots/livebench-ui-stale-compact-1280.png) | [mobile](shots/livebench-ui-stale-compact-375.png) |
| Unavailable warning | [desktop](shots/livebench-ui-unavailable-compact-1280.png) | [mobile](shots/livebench-ui-unavailable-compact-375.png) |
| Loading details | [desktop](shots/livebench-ui-loading-1280.png) | [mobile](shots/livebench-ui-loading-375.png) |
| Owner order details | [desktop](shots/livebench-ui-owner-1280.png) | [mobile](shots/livebench-ui-owner-375.png) |
| Stale owner order details | [desktop](shots/livebench-ui-owner-stale-1280.png) | [mobile](shots/livebench-ui-owner-stale-375.png) |

The obsolete AA connection control had no remaining UI score consumer and was removed. The legacy APIs/store and stored credentials are untouched. No connection setup is needed for public LiveBench data.

## Regression checks

- `CW_LIVEBENCH_RELEASES_API=http://127.0.0.1:9 node --test test/livebench.test.mjs test/delegate.test.mjs test/delegate-preview.test.mjs test/ui-fallbacks.test.mjs`: **20 passed, 0 failed, 0 skipped**, including HTTP preview, scheduler ranking, owner-order persistence, drag, remove/undo/add/reset.
- `node --check public/app.js` and `git diff --check`: passed.
