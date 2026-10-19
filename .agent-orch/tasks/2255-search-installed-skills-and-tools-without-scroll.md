# Task #2255: Search installed Skills and tools without scrolling the whole library, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:17  
- files: public/ext.js, public/ext.css, test/ui-ext-search.test.mjs

## Prompt

Add search to the existing Skills & tools sheet in public/ext.js and ext.css. Adapt the discoverable-tools idea recorded for siteboon/claudecodeui. Filter each tab's already-loaded entries case-insensitively by name and displayed description; for Skills also offer All, Local and Synced source filters using the existing source metadata. Show matching/total counts and distinguish an empty library from no matches, with a Clear control. Keep the search field and its focus stable while typing. Preserve tab navigation, editor drafts, MCP toggles, import actions and read-only synced skills. Do not filter the underlying EX.data or fetch on each keystroke. Add focused tests with a substantial mixed-source fixture covering name/description search, source filtering, no matches and opening the correct filtered entry.

## Done when

`npm test -- test/ui-ext-search.test.mjs` passes.
