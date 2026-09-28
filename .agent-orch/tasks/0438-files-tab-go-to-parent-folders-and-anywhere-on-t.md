# Task #438: Files tab: go to parent folders and anywhere on the VPS, still opening on the project

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 14:25  
- files: public/files.js, public/files.css, test/ui-files-scope*.test.mjs

## Prompt

Frontend (public/files.js, files.css) for whole-VPS navigation. Backend contract (the parallel task implements it; code exactly to it): GET /api/files/list?dir=<abs|rel> → {dir, parent, entries:[{name, path, type, size, mtime, isSymlink, readable, writable, protected}], places:[{label, path}]}, and the other file endpoints accept absolute paths. 1) The Files tab opens on the current project's folder by default (as today), and remembers the last folder per project only within the session (a fresh open goes back to the project). 2) The breadcrumb shows the full absolute path from '/' (each segment clickable, collapsing the middle on narrow screens), and a '↑ Parent' button (plus Alt+↑/Backspace) works all the way to '/'. A small 'Places' menu offers Project, Home, / and /tmp, and a 'Go to folder…' field (Cmd/Ctrl+L) accepts a typed absolute or ~ path, with autocomplete from the listing. 3) Protected entries show a lock icon, and opening one says 'Protected file: contents hidden'. Read-only locations show a subtle 'Read-only' tag in the toolbar, with write actions in the context menu disabled there (and a tooltip why). Permission-denied folders show an inline message. 4) Keep the existing context menu, selection, Quick Look and search working with absolute paths. 5) Tests with mocked endpoints: it opens at the project path; Parent climbs to '/' and stops; Places and typed paths navigate; a protected file shows the hidden message; write actions are disabled in read-only dirs. Run only the touched test files.

## Done when

`node --test test/ui-files-scope*.test.mjs` passes (opens at project, parent to '/', Places and typed path, protected message, read-only disables writes)
