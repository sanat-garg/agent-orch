# Task #2269: Search queued work by title, task number and file, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:35  
- files: public/app.js, public/app.css, test/ui-queue-search.test.mjs

## Prompt

Add search to the Queue's Up next section in public/app.js, with scoped styles in public/app.css. Match queued task titles, IDs with or without #, and declared file paths case-insensitively. Show matching/total counts, Clear, and a useful no-results state. Preserve necessary ancestor context for matching dependent tasks, marking context-only ancestors. Disable queue reordering while filtered and restore it when cleared. Keep the search value, focus and caret through task updates. Preserve the away digest, running sections and Machines lanes; this is not global history search. Restrict edits to Queue helpers/renderQueue and scoped CSS, avoiding active composer and drawer work. Inspiration: [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)'s task-oriented navigation; study interactions, not code. Add test/ui-queue-search.test.mjs covering matching, dependent-task context, clearing, no matches and typing through an update, with a 390px layout assertion. Use isolated fixtures and run only the focused test.

## Done when

`npm test -- test/ui-queue-search.test.mjs` passes.
