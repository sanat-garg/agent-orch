# Task #418: files.mjs: rename, new file/folder and delete endpoints with the copy/move path rules

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:14  
- files: files.mjs, test/files-ops.test.mjs

## Prompt

Goal: the Files tab backend (files.mjs) gains the three basic file-manager operations that copy/move/zip/unzip (task #403) left out. Add, under the same handleFiles router and the same safety rules the copy/move endpoints use (paths relative to the project, realpath'd, must stay inside the project's real path, never `.git` or anything under it, never the project root itself, 400/403/404/409/413 JSON errors):
- POST /api/files/rename {cid, path, name} → {from, to}: `name` is one path segment (no `/`, not `.`/`..`, ≤ 255 bytes); 409 if the target exists.
- POST /api/files/new {cid, dir, name, type: 'file'|'dir'} → {created: rel}: creates an empty file or a folder in `dir`; 409 if it exists; 404 if `dir` is not a folder.
- POST /api/files/delete {cid, paths} → {deleted: [rel], skipped: [{path, reason}]}: removes files and folders recursively (fs.rm with recursive: true, force: false); a path that is missing is skipped with a reason, `.git`, the root and anything outside are refused for the whole request (403) before anything is deleted; cap paths at the same count copy/move allow.
Document the three in the header comment next to the other endpoints. Export the underlying functions (renamePath, newEntry, deletePaths) as copyPaths/movePaths are, and test them plus the routes in test/files-ops.test.mjs, following its existing project() setup: rename a file and a folder, refuse `..`, `.git` and an existing target, create a file and a folder, delete a nested folder, refuse deleting the root and `.git`, and skip a missing path with a reason. Do not touch public/files.js (a separate task adds the menu items). Run `npm test -- test/files-ops.test.mjs` on your changes.

## Done when

`npm test -- test/files-ops.test.mjs` passes and `grep -c "/api/files/delete" files.mjs` prints at least 1
