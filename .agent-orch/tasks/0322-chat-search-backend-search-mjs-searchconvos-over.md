# Task #322: Chat search backend: search.mjs searchConvos over titles and chat logs, streamed and capped, with tests

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:34  
- files: search.mjs, test/search.test.mjs

## Prompt

New feature foundation (ROADMAP 'Chat search'): a module that finds conversations by text so the owner can search past chats from the sidebar. The route and the sidebar field come in a later task because server.mjs and public/app.js are held by other tasks; this task builds and tests the module only. Read server.mjs to learn the data: `convos.json` under the data dir holds `[{id, title, cwd, ...}]` and each chat's messages live in `<DATA>/logs/<id>.jsonl` (`logPath`, line ~196; read how a line is shaped: role, text/content, timestamp). Create search.mjs exporting `searchConvos({ logsDir, convos, q, limit = 20, perConvo = 3, maxBytes = 4 MB })` → `Promise<[{ id, title, at, hits: [{ role, at, snippet }] }]>`: case-insensitive, all whitespace-separated terms must match (title or message text); read each log with a line stream (node:readline over fs.createReadStream) so big logs are not loaded whole, read at most `maxBytes` per log, extract text from string content and from `content: [{type:'text', text}]` parts only (skip tool calls, images, base64); snippets are ~120 chars around the first match with the match preserved; results ordered by the newest hit; stop after `limit` conversations; a missing or corrupt log is skipped, never thrown; `q` shorter than 2 characters returns []. Header comment in the repo's style. test/search.test.mjs: a temp logsDir with three logs (one big padded past maxBytes with the match at the end, one corrupt line, one with a title-only match) proving matching, ordering, the per-convo cap, the byte cap and the corrupt-line skip. Add a one-line bullet to .agent-orch/CONTEXT.md is NOT allowed (another task holds it): put the module note in search.mjs's header only.

## Done when

`node --test test/search.test.mjs` passes and `grep -n 'export async function searchConvos\|export function searchConvos' search.mjs` prints a line

## Result — done (check passed) (2026-09-28 11:49)

AGENT-ORCH-STATUS: done — search.mjs searchConvos is implemented and its 3 tests pass
