# Task #2240: Export a chat as Markdown from the sidebar ⋯ menu, with tests

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:11  
- files: chat-export.mjs, server.mjs, public/app.js, test/chat-export.test.mjs

## Prompt

Let the owner take a conversation out of agent-orch. New module chat-export.mjs (header comment like its neighbours): `chatMarkdown(events, {title, cwd})` turns a chat log's events (read through chat-log.mjs, see its header; the log format is what server.mjs writes) into Markdown: a title + folder + date line, then each prompt as '## You' + text (attachments as their file names), each assistant reply as '## Claude' (or the agent's name) + its text, and each tool call as one collapsed line '> Tool: <name> — <short input summary>' without tool output. Hidden events ({t:'commit'} etc.) are skipped, commits become 'Commit <short sha>'. server.mjs: GET /api/convos/:id/export.md reads the whole log, returns text/markdown with Content-Disposition attachment filename '<chat-name>.md' (sanitised). A chat the user can't see is 404 (use the same owner check as other /api/convos/:id routes). public/app.js: add 'Export as Markdown' to the sidebar chat ⋯ menu (next to 'Token usage'), which downloads through a hidden <a download> after a HEAD/fetch preflight so an error toasts instead of saving (as files.js `fxDownload` does). Tests: test/chat-export.test.mjs unit-tests chatMarkdown on a small event list (prompt, reply, tool call, hidden commit) and checks an empty log gives just the header.

## Done when

`npm test -- test/chat-export.test.mjs` passes and `node --check server.mjs` succeeds.
