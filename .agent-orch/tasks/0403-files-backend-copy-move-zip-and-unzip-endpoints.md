# Task #403: Files backend: copy, move, zip and unzip endpoints with safe paths

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 13:51  
- files: files.mjs, server.mjs, test/files-ops*.test.mjs

## Prompt

Backend for the Files tab's context menu (files.mjs + server.mjs routes, login-protected; all paths confined to the current project root after realpath, rejecting '..', absolute escapes and symlinks pointing outside; data/ and .git/ are read-only for these ops). Contract (the UI task codes against it): POST /api/files/copy {paths:[...], dest} copies files/dirs into dir dest (with a 'name copy', 'name copy 2' suffix on collision) → {created:[paths]}; POST /api/files/move {paths, dest} → {moved:[{from,to}]} (with the same collision rule, and rejecting moving a dir into itself); POST /api/files/zip {paths, dest?, name?} → {zip: path}, a .zip of the selection (default name: the item's name, or 'Archive.zip' for several, placed in the common parent); POST /api/files/unzip {path, dest?} → {extracted: dir} into a folder named after the zip (zip-slip protected: every entry path is validated, no absolute or '..' entries, symlink entries skipped; cap at 500 MB uncompressed and 20k entries). Use the system zip/unzip if present (install them with `sudo apt-get install -y zip unzip` on this server; workers aren't involved) or a small pure-node implementation; choose whichever keeps it dependency-free and reliable, and document the choice. Also GET /api/files/list?dir= returns directory entries (name, type, size, mtime, isSymlink) for navigation, if not already present. Every op returns a clear error on a conflict or permission problem. Tests: copy and move with collisions; a dir into itself rejected; zip then unzip round-trips content; zip-slip entries rejected; path escapes rejected; data/ is protected. Run only the touched test files.

## Done when

`node --test test/files-ops*.test.mjs` passes (copy/move collisions, zip/unzip round-trip, zip-slip and path-escape rejection, data/ protected)
