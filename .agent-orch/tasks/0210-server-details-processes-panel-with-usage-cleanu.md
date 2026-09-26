# Task #210: Server details: Processes panel with usage, cleanup log and stop buttons

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 19:41  
- starts after: #208  
- files: public/app.js, public/app.css, public/index.html, test/ui-processes*.test.mjs

## Prompt

In the Server details modal (#serverModal, which already has CPU/RAM charts), add a 'Processes' section fed by GET /api/resources (from resources.mjs): a summary line ('RAM 3.1 / 4 GB · 620 MB reclaimable · 2 tasks running'), then groups (Tasks, Chats, Live server, Terminals, Leftovers, Other) with each tree's name (e.g. '#212 Claude · opus', 'Test server :3999', 'Chromium (orphan)'), RSS, CPU% and age, sorted by memory, with a small inline bar. Leftover rows get a 'Stop' button (POST /api/resources/kill, with confirmation). Task rows link to their drawer, with 'Pause' going through the task pause API. Protected rows have no button. Add a 'Clean up now' button that runs the reaper and shows what was freed, plus a collapsible 'Recent cleanups' log. The per-agent learned footprints show as small chips ('Claude ~0.9 GB · Codex ~0.4 GB'), and the current slot decision ('2 slots · 2.1 GB free'). Live refresh every 10 s while open. It must work at 390px (the rows condense). Screenshots via bin/shot.mjs on a test server (separate port, CW_DATA_DIR=$(mktemp -d), CW_NO_ORCHESTRATOR=1).

## Done when

`node --check public/app.js && npm test` passes, and #serverModal renders a Processes section from /api/resources with Stop buttons only on leftover rows (asserted in a UI test)
