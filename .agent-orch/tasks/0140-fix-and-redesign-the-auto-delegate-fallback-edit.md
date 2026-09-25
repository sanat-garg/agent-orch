# Task #140: Fix and redesign the Auto Delegate fallback editor in the app's theme

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 23:22

## Prompt

Bug: in the composer's Auto Delegate fallback popup, the owner can't reorder or delete models. The handlers exist in public/app.js (apSaveFallbacks ~line 1418, apAddFallback, apRemoveFallback ~1450, apMoveFallback ~1455, apResetFallbacks) but lost their UI wiring when task #133 simplified the popup. 1) Rebuild the popup as a reusable component, renderFallbackEditor(container, {list, onChange, suggested}), so orchestrator settings can reuse it later. 2) Design: match the app's existing Claude-style theme. Use the same CSS variables (--bg, --surface/--panel, --border, --text, --muted, --faint, --accent), radius, spacing, type scale and button styles (.btn, .chip) as the Connections/Usage modals and drawer. No new colours or fonts. Rows are clean list items: a numbered position, the model's display name with a small agent label, an availability dot with a short status ('available', 'resets 4:45 AM'), one key score, a drag handle on the left and a remove button (×, 32px hit area, 44px on touch) on the right. '+ Add model' opens an inline searchable list grouped by agent, and a 'Reset to automatic' text button sits at the bottom. 3) Interactions must actually work: drag-to-reorder via pointer events (long-press on touch; no HTML5 DnD), up/down via Alt+↑/↓ on a focused row, remove with an undo toast, add, and reset. Every change saves via PUT /api/convos/:id/fallbacks (optimistic, with revert on error) and updates the composer summary immediately. 4) Add a Playwright test script (test/ui-fallbacks.test.mjs; it runs a test server on a separate port with CW_DATA_DIR=$(mktemp -d) and CW_NO_ORCHESTRATOR=1, uses the cached Chromium and skips if unavailable) that opens the popup, removes a model, moves one up, and asserts that the saved list via the API changed accordingly. Screenshots on desktop and 390px via bin/shot.mjs.

## Done when

`npm test` passes including test/ui-fallbacks.test.mjs, which verifies remove and reorder persisted through PUT /api/convos/:id/fallbacks
