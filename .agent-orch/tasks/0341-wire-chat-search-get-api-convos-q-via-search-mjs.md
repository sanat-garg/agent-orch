# Task #341: Wire chat search: GET /api/convos?q= via search.mjs and a search field above the chat list

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:52  
- starts after: #322  
- files: server.mjs, public/app.js, public/app.css, public/index.html, test/search-api.test.mjs

## Prompt

User feature (BRIEF goal 3): the search backend exists (search.mjs `searchConvos({ logsDir, convos, q, limit, perConvo, maxBytes })`, merged by task #322, read its header and test/search.test.mjs) but nothing calls it. Wire it end to end. Server (server.mjs, near the existing `GET /api/convos` list route ~line 745): when the query has a non-empty `q`, answer `searchConvos({ logsDir: <DATA>/logs, convos, q: String(q).slice(0, 200), limit: 20 })` behind the same auth as the list; keep the plain list unchanged when q is absent. UI (public/index.html, public/app.js, public/app.css): a search field at the top of the sidebar above `#convoList` (a `<input type=search>` with a magnifier, 16px font on touch and ≥ 44px tall per CONTEXT.md's mobile rules, placeholder 'Search chats'); typing (debounced ~250 ms) fetches `/api/convos?q=` and renders the results in `#convoList` in place of the chat list: each result shows the chat title, the best matching snippet with the match highlighted (escape HTML, use a <mark>), and its date via the existing time helpers; tapping opens that chat (reuse the existing open-convo function); Escape or clearing the field restores the normal list; a no-result state says 'No chats match'. Do not duplicate helpers (test/ui-static.test.mjs rejects duplicate functions); reuse `$`, `esc`/escape helpers that exist in app.js. Tests: a new test/search-api.test.mjs that spawns server.mjs on a free port with a temp CW_DATA_DIR (copy test/server.test.mjs's setup), seeds two chats with logs, asserts `GET /api/convos?q=` returns only the matching chat with a snippet and that `GET /api/convos` still returns the full list; then a playwright-core check (copy test/ui-timeline.test.mjs's pattern) that typing in the field lists the match, clicking it opens the chat, and clearing restores the list. Other tasks are editing server.mjs and app.js: re-read both before editing and keep your diff minimal. Run only your new test file while you work.

## Done when

`node --test test/search-api.test.mjs` and `grep -q 'searchConvos' server.mjs`

## Result — done (check passed) (2026-09-28 12:29)

AGENT-ORCH-STATUS: done — Sidebar chat search now calls GET /api/convos?q=; tests pass
