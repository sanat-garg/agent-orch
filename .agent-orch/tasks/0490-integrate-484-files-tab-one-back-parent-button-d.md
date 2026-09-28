# Task #490: Integrate #484: Files tab: one Back/Parent button, drag-and-drop upload and an Upload button

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-09-28 18:16  
- files: public/files.js, public/files.css, test/ui-files-upload*.test.mjs

## Prompt

Task #484 ("Files tab: one Back/Parent button, drag-and-drop upload and an Upload button") finished in its own git worktree, but its branch `agent-orch/task-484` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #484's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #484's instructions were:

Frontend (public/files.js, files.css). 1) Merge the separate Parent (↑) and Back buttons into one '‹' button that goes to the parent folder (the breadcrumb and Alt+← history still exist; keep Alt+↑ as parent), and remove the duplicate. 2) Upload: an 'Upload' button in the toolbar with a menu 'Files…' / 'Folder…' (input type=file multiple, and webkitdirectory for folders), and drag-and-drop of files or folders from the desktop onto the file list (use DataTransferItem.webkitGetAsEntry to walk dropped folders), with a clear drop overlay ('Drop to upload to <folder>'). Uploads go to the current folder, or to a folder row when dropped onto it. Contract (implemented by the parallel backend task): POST /api/files/upload?dir=&path=&overwrite= with the raw file body → {saved} or 409 {error:'exists'}. On a 409, ask once per batch: 'Replace / Keep both (rename) / Skip'. Show an upload progress panel (per file and overall, via XHR upload progress, 3 uploads in parallel) with a cancel option, then refresh the listing. It's disabled in read-only locations with a tooltip. Tests with a mocked endpoint: Back goes to the parent; the Upload button posts files with the right query; a drop of a folder structure posts nested paths; a 409 prompts. Run only the touched test files.

## Done when

`node --test test/ui-files-upload*.test.mjs` passes (merged back button, button upload, folder drop with nested paths, 409 prompt)

## Result — done (check passed) (2026-09-28 18:17)

AGENT-ORCH-STATUS: done — CONTEXT.md conflict resolved; upload tests pass
