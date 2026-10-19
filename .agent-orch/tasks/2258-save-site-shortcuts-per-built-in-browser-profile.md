# Task #2258: Save site shortcuts per built-in Browser profile, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:21  
- files: public/browser.js, public/browser.css, test/ui-browser-shortcuts.test.mjs

## Prompt

Add saved site shortcuts to the built-in Browser view using public/browser.js and public/browser.css; add focused tests in test/ui-browser-shortcuts.test.mjs. Let a user name and save the current HTTP(S) page, open a saved site through the existing bv_nav action, and remove a shortcut. Scope browser-local storage by signed-in user, machine, and profile; remove that profile's shortcuts after a successful profile clear. Show an empty state and a clear message for a missing name or invalid URL. Keep the controls usable on phones and confined to built-in Browser mode. Study siteboon/claudecodeui for navigation ideas only; respect its licence. Test saving and reopening, profile isolation, and invalid input. No public address or service changes.

## Done when

`node --test test/ui-browser-shortcuts.test.mjs` passes

## Result — done (check passed) (2026-10-19 14:25)

AGENT-ORCH-STATUS: done — Browser profiles have saved site shortcuts; four new tests pass
