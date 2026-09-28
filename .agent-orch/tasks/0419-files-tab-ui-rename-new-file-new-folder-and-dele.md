# Task #419: Files tab ui: Rename, New file, New folder and Delete in the context menu

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:14  
- starts after: #418  
- files: public/files.js, public/files.css, test/ui-files-manage.test.mjs

## Prompt

Goal: the Files tab's context menu (public/files.js, the cmenu built around `FX.menu`; opened by right-click, long-press, a row's ⋯ button and Shift+F10) offers the operations the backend now has: POST /api/files/rename {cid, path, name}, /api/files/new {cid, dir, name, type}, /api/files/delete {cid, paths} (see files.mjs's header for the exact shapes and errors). Add, in this order after the existing Copy/Cut/Paste/Zip/Unzip items: Rename… (one selected row: an inline text field on the row, prefilled with the name, Enter confirms, Esc cancels), New file… and New folder… (on the folder background or a folder row: an inline field in a new row at the top of the listing), and Delete (one or more rows; a plain in-page confirm using the existing sheet/modal styles, not window.confirm: "Delete 3 items? This can't be undone." with a red Delete button, 44px targets on touch). After each operation refresh the listing, keep the selection sensible (the renamed or created entry selected), and show errors with the shared `toast`. Keyboard: F2 renames, Delete/Backspace opens the confirm, when the file list has focus. Styles go in public/files.css (reuse the cmenu and modal tokens; dark mode included). Add test/ui-files-manage.test.mjs modelled on test/ui-files.test.mjs (spawn server.mjs on a free port with a temp CW_DATA_DIR and a temp project; playwright-core, skipping when Chromium cannot launch as the neighbouring UI tests do): the menu shows the four items, renaming a file changes the listing, New folder creates one, Delete with confirm removes a file and cancel keeps it. Keep public/app.js untouched. Note test/ui-files.test.mjs and public/files.js are also touched by integrator #385 (a Changed view); if your worktree is behind main, fast-forward it before starting.

## Done when

`npm test -- test/ui-files-manage.test.mjs` passes and `grep -c "api/files/rename" public/files.js` prints at least 1

## Result — done (check passed) (2026-09-28 15:06)

AGENT-ORCH-STATUS: done — Files menu has Rename, New file/folder and Delete; tests pass
