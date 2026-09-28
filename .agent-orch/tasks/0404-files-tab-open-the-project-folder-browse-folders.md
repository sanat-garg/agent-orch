# Task #404: Files tab: open the project folder, browse folders, right-click copy/cut/paste/zip/unzip

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 13:51  
- files: public/files.js, public/files.css, test/ui-files-nav*.test.mjs

## Prompt

Frontend for the Files tab (public/files.js, files.css). 1) Default: it opens on the current project's root folder (not a search or empty state), with a breadcrumb path bar (click any segment to jump), folders first then files, double-click or Enter to open a folder or file (Quick Look for files as today), Backspace or Alt+↑ for the parent, and a Back/Forward history. It remembers the last folder per project. 2) Selection: click, Cmd/Ctrl-click, Shift-click ranges, and Cmd/Ctrl-A. 3) Context menu on right-click (and long-press on touch; also a '⋯' button per row for accessibility): Open, Copy, Cut, Paste (enabled when the clipboard has items; pastes into the folder right-clicked or the current folder), Compress to ZIP, Extract here (for .zip), Copy path, Ask in chat (existing), with keyboard shortcuts shown (⌘C ⌘X ⌘V) and working when the list has focus. Cut items appear dimmed until pasted. The clipboard is app-internal (paths plus a mode), shared across folders. 4) Backend contract (implemented by the parallel backend task; code exactly to it): GET /api/files/list?dir=; POST /api/files/copy {paths, dest}; /move {paths, dest}; /zip {paths, dest?, name?}; /unzip {path, dest?}, with errors returned as {error}. Show progress for zip/unzip, success toasts with the result name, error toasts, and refresh the listing after ops. The menu is theme-consistent, closes on Esc or an outside click, and stays within the viewport. Tests with mocked endpoints: it opens at the project root; breadcrumb navigation; the context menu actions post the right bodies (copy→paste, cut→paste as move, compress, extract); the keyboard shortcuts work. Run only the touched test files.

## Done when

`node --test test/ui-files-nav*.test.mjs` passes (opens at root, breadcrumb nav, context-menu copy/cut/paste/zip/unzip bodies, shortcuts)
