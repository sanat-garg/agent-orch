# Task #250: UI-REVIEW #2: keyboard-aware composer via visualViewport; hide the orch bar while typing

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 01:13  
- files: public/app.js, public/app.css, test/ui-mobile-keyboard.test.mjs, test/ui-static.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

Apply finding #2 in .agent-orch/UI-REVIEW.md (mobile, Apple HIG: keep content visible above the keyboard). iOS Safari ignores `interactive-widget=resizes-content`, and public/app.js has no visualViewport handling (only a tooltip helper reads it). Implement: (1) in public/app.js, when `window.visualViewport` exists, listen to its `resize` and `scroll` events and set a CSS custom property `--kb` on `document.documentElement` to the keyboard height (`innerHeight - visualViewport.height - visualViewport.offsetTop`, clamped at 0); update it also on `#input` focus/blur. (2) In public/app.css, in the `@media (max-width: 800px)` block, size the app container so it shrinks by `var(--kb, 0px)` (e.g. `height: calc(100dvh - var(--kb, 0px))` on `.app`, or the equivalent for the current layout) and add `html.kb-open .orch-bar { display: none }`; toggle class `kb-open` on `<html>` while `--kb` > 0 or `#input` is focused. While the keyboard is open, fold the composer's `.controls` chips into one horizontally scrolling row (`flex-wrap: nowrap; overflow-x: auto`). Keep desktop behaviour unchanged. Add a Playwright test in test/ui-mobile-keyboard.test.mjs (copy the setup of test/ui-away.test.mjs: 390×844 viewport, logged-in page) that dispatches a fake keyboard by setting `--kb` to 300px / adding `kb-open` and asserts the orch bar is hidden and the composer bottom sits within the shrunken viewport; also add a static assertion in test/ui-static.test.mjs that app.js references `visualViewport` and `--kb`. Mark row 2 fixed in UI-REVIEW.md. Run `node --test test/ui-mobile-keyboard.test.mjs test/ui-static.test.mjs test/ui-away.test.mjs`.

## Done when

`grep -q "visualViewport" public/app.js` and `grep -q -- '--kb' public/app.css` and `node --test test/ui-mobile-keyboard.test.mjs test/ui-static.test.mjs test/ui-away.test.mjs` passes

## Result — done (check passed) (2026-09-28 03:43)

AGENT-ORCH-STATUS: done — Phone composer now stays above the keyboard; tests pass
