# Task #331: Files tab: find files by name across the whole project

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:43  
- files: files.mjs, public/files.js, public/files.css, test/files.test.mjs

## Prompt

The Files view (public/files.js, server files.mjs) filters only the current folder by name (#fxFilter, FX.filter). Add project-wide find. Backend, files.mjs (it owns its routes in handleFiles; do not touch server.mjs): `findFiles(rootDir, q, { max = 200 } = {})` walks the project tree from resolveInside(rootDir, '') skipping `.git`, `node_modules`, `.agent-orch-worktrees` and hidden dirs unless the query itself starts with '.', matching a case-insensitive substring of the name, stopping after `max` hits or 20,000 visited entries (return `truncated: true`), never following symlinks outside the root (use the same realpath rule as resolveInside), returning {q, entries: [{name, path (relative), dir, size, mtime}], truncated}. Route `GET /api/files/find?cid=&q=` in handleFiles; q shorter than 2 chars → 400. Tests in test/files.test.mjs following its existing setup: matches at depth, node_modules skipped, an outside symlink ignored, the cap. Frontend, public/files.js + public/files.css: pressing Enter in #fxFilter (or a small 'Search project' button that appears while the filter has 2+ chars) calls the route and renders the results as a list (name, folder path, size) in the main area with a 'Searching…' state and 'No files named like “q”' empty state; tapping a result navigates to its folder and selects it (reuse the existing navigation + selection code); Escape or clearing the field returns to the folder view. Keep 44pt rows on touch (@media (pointer: coarse)) and reuse existing fx-* classes. test/ui-static.test.mjs must still pass (no duplicate function names across public/*.js). Verify the UI manually with a test server on another port (never port 3000) if playwright is available.

## Done when

`npm test -- test/files.test.mjs test/ui-static.test.mjs` passes and `grep -n 'api/files/find' public/files.js` prints a line.

## Result — done (check passed) (2026-09-28 11:53)

AGENT-ORCH-STATUS: done — Files tab finds files by name across the whole project
