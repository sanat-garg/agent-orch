# Task #362: Completion sound plays while the tab is active too

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 12:38  
- files: public/app.js, test/ui-sound*.test.mjs

## Prompt

In public/app.js (~line 2811) the task-done sound returns early when the tab is visible and focused: `if (!$('stSound').checked || (document.visibilityState !== 'hidden' && document.hasFocus())) return;`. The owner wants it to play whenever a task finishes, whether the tab is active or in the background. Change the condition to depend only on the Settings switch (#stSound). Keep the existing rules: only live done transitions (not replayed history on load or reconnect), the 3 s debounce for several tasks finishing together, and the audio unlock on the first interaction. Keep the title flash for the background case only. Update the Settings switch label and hint text if it says 'while away' or 'in the background' (e.g. 'Sound when tasks finish'). Update or add the UI test asserting the sound plays for a live done transition with document.hasFocus() true and visibilityState 'visible', and not when the switch is off. Run only the touched test files.

## Done when

`node --test test/ui-sound*.test.mjs` (or the existing sound test file) passes including the active-tab case, and `! grep -n "document.hasFocus())) return" public/app.js`

## Result — done (check passed) (2026-09-28 12:43)

AGENT-ORCH-STATUS: done — completion sound now plays in active tabs too; tests pass
