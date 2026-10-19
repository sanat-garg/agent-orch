# Task #2234: Task drawer: a Changes section with per-file counts and a coloured diff (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:11  
- files: public/app.js, public/app.css, test/ui-task-changes.test.mjs

## Prompt

Show what a task changed inside its drawer in public/app.js (render code near `section(title)`, ~line 8373, and the drawer body builder above it). For work tasks that are running, done, failed or needs_integration, add a collapsed 'Changes' section. Opening it fetches GET /api/orch/tasks/<id>/changes (being added in parallel; response {source, commits, files:[{path, add, del, binary}], patch, truncated}). Render a file list with green +add / red −del counts and a total line ('3 files, +40 −12'). Clicking a file expands that file's hunks parsed from `patch` (split on 'diff --git'), with added/removed/context lines coloured via CSS variables that work in both themes, and long lines scroll horizontally, never wrap the page. Binary files say 'Binary file'. Cover the edge cases: source 'none' → 'No changes yet'; truncated → 'Diff cut at 200 KB; open the files in the Files tab for the rest'; a fetch error → the error text in the section. It must work on phones (pointer: coarse 44px rows; see CONTEXT.md mobile rules) and fetch only when opened. The idea comes from BloopAI/vibe-kanban's diff review. Put the CSS in public/app.css. Don't add a new public file: the static allowlist in server.mjs is shared and busy. Write test/ui-task-changes.test.mjs with playwright-core, copying test/ui-chat-tokens.test.mjs's setup and stubbing the route, for the main path (a two-file diff renders with counts and coloured lines) and the 'none' empty state.

## Done when

`npm test -- test/ui-task-changes.test.mjs test/ui-static.test.mjs` passes.
