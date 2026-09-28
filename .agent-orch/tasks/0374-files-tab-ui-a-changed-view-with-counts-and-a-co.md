# Task #374: Files tab ui: a Changed view with +/− counts and a coloured diff in Quick Look

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:54  
- starts after: #373  
- files: public/files.js, public/files.css, test/ui-files.test.mjs

## Prompt

Feature in public/files.js and public/files.css on top of the backend routes GET /api/files/changed and GET /api/files/diff (added by an earlier task; read files.mjs's header for their shapes). Add a 'Changed' segment to the Files toolbar (next to the icon/list view switch, or a chip in the path bar on phones) that replaces the folder listing with the project's changed files: one row per entry with a status badge (M modified, A added, D deleted, R renamed, ? untracked, in muted colours; deleted rows struck through), the path with the folder part dimmed, and `+add −del` counts in --ok/--danger; an empty state 'No uncommitted changes', a 'Not a git repository' state, and a Refresh button; a truncated note when the list is cut. Selecting a row and pressing Space (or tapping on touch) opens Quick Look showing the unified diff from /api/files/diff, rendered line by line with added lines tinted --ok, removed --danger, hunk headers muted (escape all text; reuse the Quick Look chrome and the Preview/Source pattern; Quick Look's existing 'open the file' behaviour stays for the file itself via a second button 'File'). Reuse existing helpers ($, el, api, toast); persist the view in store under cw.files.view as 'changed'. Keep touch targets 44px under pointer: coarse and fit 375px wide. Add test/ui-files.test.mjs with playwright-core copying test/ui-ext.test.mjs's setup (spawn server.mjs on a free port with CW_DATA_DIR=$(mktemp -d) and a temp git project as the chat's cwd): the Changed view lists a modified and an untracked file with counts, and Quick Look shows a diff line with the added-line class. Keep `npm test -- test/ui-static.test.mjs` green. Run only those two test files while working.

## Done when

`npm test -- test/ui-files.test.mjs test/ui-static.test.mjs` passes
