# Task #762: Files tab: Download button; several selected download as one zip

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 23:12  
- files: public/files.js, public/files.css, test/ui-files-download*.test.mjs

## Prompt

Frontend (public/files.js, files.css). Add 'Download' to the Files tab toolbar (a download icon plus label, disabled with a tooltip when nothing is selected), to the right-click/long-press context menu, and as a keyboard shortcut (Cmd/Ctrl+Shift+D). Contract (the parallel backend task implements it; code exactly to it): GET /api/files/download?path=<p> for one file; repeated path params (or a single folder) return a streamed zip. Behaviour: one file selected → download it directly; several items, or one folder → one zip ('Downloading 5 items as a zip'). Trigger it via a hidden <a download> / window.location on the built URL (encodeURIComponent for each path) so the browser handles the save natively, with no fetch into memory. Protected files are shown disabled for download with a lock tooltip, and are excluded from multi-selections with a toast 'Skipped 1 protected file'. It works with the marquee and multi-selection (#502), in read-only locations too (downloading is read-only), and on phones (the share sheet or download via the same link). Tests with a mocked location: one selected file builds the single-path URL; three selected build a URL with three path params; a folder builds the zip URL; protected files are excluded with the toast; the button is disabled with no selection. Run only the touched test files.

## Done when

`node --test test/ui-files-download*.test.mjs` passes (single-file URL, multi-path zip URL, folder zip, protected excluded, disabled without selection)
