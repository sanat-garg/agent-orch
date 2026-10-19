# Task #2277: @-mention project files in the composer, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:41  
- files: public/app.js, public/app.css, test/ui-file-mention.test.mjs

## Prompt

Goal: in the chat composer (public/app.js), typing @ followed by text suggests matching files in the open chat's project, the way claudecodeui's composer does (github.com/siteboon/claudecodeui; borrow the interaction, not code). Picking a suggestion replaces the @query with the file's path relative to the project (e.g. `@src/app.js `) so the agent sees it.

Reuse what exists: the slash-command autocomplete (#2238) already shows a menu under the composer (#slashPop, placeMenu, hideSlash, pickSlash, keyboard handling around app.js ~2200-2250). Build the @ menu the same way and reuse its popover and keyboard handling (Up/Down/Enter/Tab/Escape) rather than adding a second popup system. Fetch suggestions from the existing GET /api/files/find?cid=<cid>&q=<query> (used by public/files.js ~line 310; read its response shape there and in files.mjs findFiles). Debounce about 150ms, ignore stale responses (sequence number), show at most 8 results, and trigger only when @ starts a word (not in emails like a@b.com). No new public files and no server changes.

Edge cases: no chat open yet (new-project draft) → no menu; no matches → a single muted 'No matching files' row; a failed fetch → hide the menu silently. Phones: 44px rows under @media (pointer: coarse). Keep app.js edits localised to the composer area; app.js is edited by other running tasks. CSS goes in public/app.css as a few scoped rules.

Test: new test/ui-file-mention.test.mjs using playwright-core like test/ui-slash-commands*.test.mjs or another composer UI test (copy its setup, stub /api/files/find): typing '@app' shows the stubbed files and Enter inserts '@public/app.js '; an empty result shows 'No matching files'.

## Done when

`npm test -- test/ui-file-mention.test.mjs` passes (typing @app suggests the stubbed file and Enter inserts its path; no matches shows 'No matching files').
