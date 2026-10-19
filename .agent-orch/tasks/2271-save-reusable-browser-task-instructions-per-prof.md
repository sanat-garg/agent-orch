# Task #2271: Save reusable Browser task instructions per profile, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:35  
- files: public/browser.js, public/browser.css, test/ui-browser-recipes.test.mjs

## Prompt

Add a compact Saved instructions control beside the built-in Browser task prompt in public/browser.js, with styles in public/browser.css. Owners can save the current nonblank instruction under a required name, list saved entries, insert one into an editable draft and remove it. Append to a nonempty draft without losing existing text; never submit automatically. Persist a bounded library in browser-local storage scoped by signed-in user, node and profile identity, following the existing saved-sites conventions. Explain that entries are saved on this device. Preserve the current live-only activity panel, profile switching, Send path and approvals. This is independent of #2249's project-chat prompt library: do not edit or depend on its files. Inspiration: [winfunc/opcode](https://github.com/winfunc/opcode)'s reusable instruction libraries, adapted to repeated browser office work. Add test/ui-browser-recipes.test.mjs covering save/reload/insert/remove, user/profile isolation, required input and a 390px layout. Build controls dynamically inside browser.js so no HTML or server changes are needed.

## Done when

`npm test -- test/ui-browser-recipes.test.mjs` passes.
