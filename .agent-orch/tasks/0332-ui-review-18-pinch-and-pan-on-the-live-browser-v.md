# Task #332: UI-REVIEW #18: pinch and pan on the live browser view with double-tap zoom, stage centred on phones

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:43  
- files: public/browser.js, public/browser.css, test/ui-browser-view.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

UI-REVIEW.md row 18 (high): the live browser view (public/browser.js, canvas #bvCanvas, mounted in the Browser tab and #bvModal) renders a 1280×800 page into a ~366pt-wide canvas at 0.29×, so page text is ~4pt and sign-in fields are ~10pt tall; the canvas has touch-action: none so pinch does nothing; the stage is top-aligned, leaving the lower half of a phone screen empty. Implement in public/browser.js + public/browser.css only (no server change; the 'Phone size' re-emulation idea in the row is a later task): keep a per-view {scale, ox, oy} (default 1 = fit-width), apply it as a CSS transform on the canvas inside a clipping stage; two-finger pinch on the canvas (pointer events, the two active pointers' distance and midpoint) changes scale between 1 and 4 around the midpoint, two-finger drag pans, one-finger gestures keep going to the page as today; double-tap (two taps within 300 ms and 30px) toggles between fit-width and 2.5× centred on the tap; a wheel with ctrlKey/metaKey zooms on desktop. Map pointer coordinates through the transform in the existing point-mapping helper bvPoint (~line 269) so clicks land on the right page point at any zoom; clamp the pan so the page never leaves the stage; reset to fit-width when the view closes or the profile changes; while pinching/panning send nothing to the page. Centre the stage vertically on phones (.bv-stage { align-items: center } in the ≤800px block) and show a small '1×' chip when zoomed that resets. Extend test/ui-browser-view.test.mjs (playwright, mocked bv_* messages): at 390px, dispatch two pointerdown/pointermove events on the canvas and assert the transform scale > 1 and that a subsequent click at a known screen point maps to the expected page coordinate in the bv_* message sent; a double-tap toggles back to 1. Mark row 18 as fixed in place in .agent-orch/UI-REVIEW.md (note the Phone-size half is deferred).

## Done when

`npm test -- test/ui-browser-view.test.mjs test/ui-static.test.mjs` passes and `grep -n 'pinch' public/browser.js` prints a line.
