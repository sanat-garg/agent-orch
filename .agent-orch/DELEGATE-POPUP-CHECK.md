# Auto Delegate popup — task #133

Verified 2026-09-25 in Chromium at **1280 × 812** and **375 × 812 CSS pixels**. Fixture server: `node .agent-orch/delegate-popup-fixture.mjs` on isolated port 3998; serves the actual popup markup, render functions and stylesheet. Representative provider-shaped data is synthetic, not a claim about current live model scores. The separate HTTP regression verifies real supplied values through the stub-provider → server → popup path. No live server restart or account changes.

## Browser evidence

All screenshots captured with `node bin/shot.mjs`, using explicit `--width=1280` or `--width=375` and `--height=812` (the helper's `--mobile` preset is 390, so it was not used).

| View | Desktop | 375 CSS pixels |
| --- | --- | --- |
| Before | [before](shots/delegate-popup-before-desktop.png) | [before](shots/delegate-popup-before-375.png) |
| Compact ranked list | [desktop](shots/delegate-popup-compact-1280.png) | [mobile](shots/delegate-popup-compact-375.png) |
| Expanded score details, scrolled into view | [desktop](shots/delegate-popup-details-1280.png) | [mobile](shots/delegate-popup-details-375.png) |
| Unconfigured, Open Connections action | [desktop](shots/delegate-popup-unconfigured-1280.png) | [mobile](shots/delegate-popup-unconfigured-375.png) |
| Provider error, Open Connections action | [desktop](shots/delegate-popup-error-1280.png) | [mobile](shots/delegate-popup-error-375.png) |

Default view has a starting model and three numbered fallbacks, each with one availability/comparability explanation. Long spaced names and a long unbroken identifier wrap. The single native disclosure opens by click or keyboard Enter; supplied Coding Index 50.0 and Intelligence Index 60.0 appear only inside it. Missing Agentic Index and benchmarks show dashes, never zero. Models with no scores receive an explicit unavailable message. Technical ranking reasons are inside the same disclosure; attribution remains visible outside it.

`node .agent-orch/delegate-popup-browser-check.mjs` **passed** for populated, unconfigured, provider-error, loading and request-error states at both widths. Assertions check list length, initially hidden metrics, keyboard disclosure, supplied scores, missing-score dashes, horizontal bounds and recovery callbacks. Open Connections and Retry targets are at least 44 CSS pixels tall and reachable within the viewport. The close control remains in the sheet header while details scroll.

| Width | Document scrollWidth | Popup body clientWidth / scrollWidth, all five states |
| --- | --- | --- |
| 1280 | 1280 | 438 / 438 |
| 375 | 375 | 375 / 375 |

No horizontal overflow in either the document or popup, including expanded details. Loading explains automatic refresh; unconfigured/provider failures offer Open Connections; request failures offer Retry. Recovery handlers were invoked in the fixture (Connections and reload are stubbed to avoid touching accounts).

## Behavior regression

`node --check public/app.js` passed. `node --test test/aa.test.mjs test/delegate.test.mjs test/delegate-preview.test.mjs` passed: **21/21**. The popup regression opens the disclosure before asserting scores. Existing tests cover automatic ranking, availability ordering, saved fallback order, empty and null lists, and saving validation. Selection, saving APIs and routing logic are unchanged; the popup does not offer the cancelled fallback editor.

After the final score-field/attribution adjustment, the browser matrix and focused HTTP/popup suite passed again (**4/4**). A broader `npm test` attempt ended with signal termination (exit 143) after test 115, with no reported assertion failures; it is **not** claimed as a full-suite pass.
