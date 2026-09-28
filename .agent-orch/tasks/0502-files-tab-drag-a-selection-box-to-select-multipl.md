# Task #502: Files tab: drag a selection box to select multiple files

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 18:52  
- files: public/files.js, public/files.css, test/ui-files-marquee*.test.mjs

## Prompt

Add marquee (rubber-band) selection to the Files tab list (public/files.js, files.css), on top of the existing click/Cmd/Shift selection from #404. 1) Pressing the mouse on EMPTY space in the list (not on a row's name, and not on an already-selected row) and dragging draws a translucent selection rectangle in the theme accent (a 1px border plus 10% fill). Every row it intersects becomes selected live. Plain drag replaces the selection, Cmd/Ctrl+drag toggles intersected rows onto the current selection, and Shift+drag adds to it. 2) Auto-scroll: while dragging within ~40px of the list's top or bottom edge, scroll the list, with a speed proportional to the distance, and keep extending the rectangle across the scrolled rows. 3) Conflicts: starting a drag on an already-selected row keeps the existing drag-to-move/upload behaviour; a click without movement (< 4px) on empty space clears the selection; no text selection happens during the marquee (user-select: none while dragging); Esc cancels the marquee and restores the previous selection. 4) Use pointer events (mouse and pen; touch keeps long-press multi-select, so there's no marquee on touch). The context menu, keyboard shortcuts and the copy/cut/zip actions act on the marquee selection. 5) Tests: a drag across rows 2-5 selects exactly those rows; Cmd+drag adds to an existing selection; dragging near the bottom edge auto-scrolls and selects the newly revealed rows; a click on empty space clears the selection; a drag starting on a selected row doesn't start a marquee. Run only the touched test files.

## Done when

`node --test test/ui-files-marquee*.test.mjs` passes (drag selects intersected rows, Cmd adds, edge auto-scroll, click clears, drag on selected row doesn't marquee)
