# Task #399: Integrate #347: Fix the live browser: working stream, google.com by default, viewport follows the screen

- kind: work  
- source: planner  
- priority: 95 (normal)  
- created: 2026-09-28 13:18  
- files: browser-live.mjs, browser-view.mjs, server.mjs, public/browser.js, public/browser.css, test/browser-live-e2e*.test.mjs

## Prompt

Task #347 ("Fix the live browser: working stream, google.com by default, viewport follows the screen") finished in its own git worktree, but its branch `agent-orch/task-347` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md, public/browser.js). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #347's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #347's instructions were:

The owner says the Browser tab 'isn't working'. Chromium does launch on the controller (journal: '[browser] browser: started Chromium for profile default' at 12:25), but browser-live.mjs starts every profile on 'about:blank' (~line 70 launch args, ~line 244 Target.createTarget) with a fixed VIEWPORT 1280×800 (~line 15). Fix end to end: 1) Reproduce first: start a test server (separate port, CW_DATA_DIR=$(mktemp -d), CW_NO_ORCHESTRATOR=1, a login cookie via bin/shot.mjs conventions), open the Browser tab with Playwright (desktop 1280×800 and iPhone 390×844), and record what fails: no frames, a blank canvas, a socket error, an auth/drive-permission issue (note that #315, which makes bv_open honour a url only when the socket may drive, is running concurrently, so make sure the owner's own socket may drive), a missing viewer for the default profile, or input not arriving. Fix every cause found, in browser-live.mjs, browser-view.mjs, server.mjs routes and public/browser.js/browser.css. 2) Default page: when a profile's browser starts, or it has no page, or the only page is about:blank/chrome://newtab, navigate to https://www.google.com. The URL bar shows it, and new tabs opened by the owner default to it too. 3) Responsive viewport: the viewer sends its canvas CSS size and devicePixelRatio (on mount, on resize and orientation change, debounced 150 ms) and the server applies Emulation.setDeviceMetricsOverride {width, height, deviceScaleFactor, mobile: true for widths < 768} plus a matching touch emulation (Emulation.setTouchEmulationEnabled) and user-agent for mobile, so pages lay out for the actual screen. The screencast maxWidth/maxHeight follow the size × dpr (capped at 2× for bandwidth). Map input coordinates through the new scale. When the viewer closes, keep the last size. Agent tasks that use the profile keep a desktop 1280×800 unless the owner is watching. 4) The canvas fills the Browser tab's available area without letterboxing on phones, and the toolbar/prompt box don't overflow at 390px. 5) Regression test (test/browser-live-e2e*.test.mjs; skip only if Chromium is truly missing): the Browser tab loads, a non-blank frame arrives within 15 s, the URL bar shows google.com (if the VPS can't reach Google, point AGENT_ORCH_BROWSER_HOME_URL at a local test page for the test while google.com stays the default), a resize to 390×844 triggers the metrics override, and a click maps to the right page coordinates. Save desktop and phone screenshots to .agent-orch/shots/. Run only the touched test files.

## Done when

`node --test test/browser-live-e2e*.test.mjs` passes without skipping (frame arrives, default URL is google.com unless overridden in test, 390px resize applies the device metrics), and a phone screenshot of the Browser tab showing a rendered page exists in .agent-orch/shots/

## Result — done (check passed) (2026-09-28 14:30)

AGENT-ORCH-STATUS: done — merge resolved; browser e2e tests and phone screenshot verified

## Result — verify failed (1) (2026-09-28 14:30)

Command: merge main again

main changed meanwhile; conflicts in: .agent-orch/CONTEXT.md

## Result — done (check passed) (2026-09-28 14:32)

AGENT-ORCH-STATUS: done — CONTEXT conflict resolved; e2e passes; phone screenshot saved
