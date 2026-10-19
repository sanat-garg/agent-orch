# Task #2254: Save favourite folders in the Files Places menu, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:17  
- files: public/files.js, public/files.css, test/ui-files-favourites.test.mjs

## Prompt

Extend public/files.js and files.css with favourite folders inside the existing Places menu: save the current folder, open a favourite and remove it. This adapts siteboon/claudecodeui's emphasis on convenient project file navigation. Store favourites per signed-in user and project in this browser, deduplicate canonical listing paths, and share them between chats of the same project. Reuse ordinary Files navigation and existing permission checks; saving a favourite must not navigate or modify files. Show clear feedback for unavailable storage and missing folders, retaining a removable favourite when its destination disappears. Preserve the current Parent button, history shortcuts and uploads. Add tests for save/reload/open/remove, project isolation and a missing destination, including a narrow viewport.

## Done when

`npm test -- test/ui-files-favourites.test.mjs` passes.
