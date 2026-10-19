# Task #2238: Slash-command autocomplete in the composer from the SDK's slash_commands, with tests

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:11  
- files: server.mjs, public/app.js, public/app.css, test/slash-commands.test.mjs

## Prompt

Claude Code's custom commands (.claude/commands/*.md, ~/.claude/commands) and built-ins work when a prompt starts with '/name', but the composer gives no hint they exist. The Agent SDK's system init message (handled in server.mjs ~line 1349, `m.subtype === 'init'`, which broadcasts {t:'init', model, cwd, mode}) carries `m.slash_commands` (an array of names). 1) server.mjs: keep the latest list per chat in memory (and per folder as a fallback for a chat that hasn't run yet), add `commands` to the init broadcast, and send it in the history frame when a chat opens. Use only what the SDK reported, never a hardcoded list (BRIEF goal 7); codex chats send none. 2) public/app.js: when #input's text starts with '/' and has no space yet, show a .cmenu-style listbox above the composer (reuse `openMenuFrom` styling) of matching commands (prefix match first, max 8). ↑/↓ move, Tab/Enter insert '/name ' (Enter must not send while the menu is open), Esc closes. Nothing shows when there are no commands or no match. Works on phones (44px rows). Styles in public/app.css. Tests: test/slash-commands.test.mjs, a pure test of the matching/sorting helper loaded from app.js source the way version-ui tests do, or playwright-core with a stubbed ws frame: '/re' lists '/review' before '/pr-review', Enter inserts, and no list when commands is empty.

## Done when

`npm test -- test/slash-commands.test.mjs test/ui-static.test.mjs` passes and `node --check server.mjs` succeeds.
