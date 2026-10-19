# Task #2237: ⌘K command palette: jump to any chat or project and open any view, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:11  
- files: public/app.js, public/index.html, public/app.css, test/ui-palette.test.mjs

## Prompt

Add a desktop command palette, like opcode's smart search and VS Code's ⌘K/⌘P. ⌘K (Ctrl+K off Mac) anywhere, including in #input, opens a centred sheet (public/index.html, new #paletteModal) with one search field. Results are: chats and projects from `state.convos` (name, folder via `folderName`, sub-chats under their project, newest first when the query is empty), then actions (New chat, Files, Terminal, Queue, Machines, Schedules, Credentials, Live previews, Settings, Usage), each calling the same function its existing button calls (find them in public/app.js; e.g. the #newChat handler, `openMachines()`, `setView`). Matching is case-insensitive subsequence with the best matches first (prefix > word start > subsequence) and the matched letters bolded. ↑/↓ move, Enter opens, Esc or backdrop closes, focus returns to where it was. Empty state: 'No matches'. Keep focus inside while it's open. Add the shortcut to the existing document keydown handler (~line 503). Don't break ⌘` or the Files tab's own ⌘⇧D/⌘[ shortcuts, and do nothing on phones (<768px). Code in public/app.js, styles in public/app.css (no new public file). Write test/ui-palette.test.mjs (playwright-core, copy test/ui-chat-tokens.test.mjs's setup): typing part of a chat name and Enter opens that chat; 'zzzq' shows 'No matches'; Esc closes.

## Done when

`npm test -- test/ui-palette.test.mjs test/ui-static.test.mjs` passes.

## Result — done (check passed) (2026-10-19 14:36)

AGENT-ORCH-STATUS: done — ⌘K palette jumps to chats and actions; both test files pass
