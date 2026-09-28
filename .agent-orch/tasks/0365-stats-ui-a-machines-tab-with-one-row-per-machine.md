# Task #365: Stats ui: a Machines tab with one row per machine: tasks done and failed, check pass rate, busy time, tokens and last active

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:45  
- files: stats.mjs, public/stats.js, public/stats.css, test/stats.test.mjs, test/ui-stats.test.mjs

## Prompt

Goal: the owner spreads work across the VPS and the MacBook (BRIEF goals 9 and 11) but nothing shows what each machine did. Add a fifth Stats tab, Machines, built on data GET /api/stats already carries.

Backend (stats.mjs): `collect` already returns `tasks[].node` (a node id, or null for this server) and `runs[].node` ('controller' for this server). Add `nodes: [{id, name, os, status, lastSeen}]` read from the orchestrator DB's `nodes` table (columns id, name, os, status, last_seen; last_seen is epoch s, convert to ms like every other time here). A DB without that table gives `nodes: []`, never a throw. Add it to the header comment's shape. Test in test/stats.test.mjs: extend the existing createStats test's seeded DB with a `nodes` row and assert it comes back with the name and lastSeen in ms; the empty-data-dir test asserts `nodes: []`.

Frontend (public/stats.js, public/stats.css): add 'machines' to TABS and render a panel that, within the current range (reuse the same range slicing the other tabs use), lists one row per machine seen in tasks, runs or nodes: 'This server' for node null/'controller', else the node's name from `nodes` (fall back to the id). Columns: tasks done, tasks failed, check pass rate (from `checks` where a run's node is known; show — when none), busy time (sum of run durations, formatted with the sheet's existing duration helper), tokens in/out, last active (newest run finish or start). Above the table show a share bar of busy time per machine (a stacked bar reusing the sheet's existing bar/heat styles and colour tokens, with a text legend so it is not colour-only). IMPORTANT: public/index.html is held by another task, so do NOT edit it: insert the Machines tab button into #sxTabs from stats.js at init (same attributes as the existing buttons: type=button role=tab data-tab=machines aria-controls=sxBody) before the tab click/keyboard handlers run, so arrow-key navigation and the phone layout (UI-REVIEW #27: tabs and the range chip on one pinned row at 375px) still work with five tabs; shorten labels or let the tab row scroll horizontally if five do not fit at 375px. Reuse .sx-table; keep phone type sizes ≥ 11px. test/ui-static.test.mjs rejects duplicate function names across public/*.js, so prefix new helpers (e.g. sxMachines…).

UI test (test/ui-stats.test.mjs): the seed already inserts tasks and runs; add a `nodes` row (create the table in the test if the boot does not, matching cluster.mjs's schema) and give one run a node_id of that node and one the controller. Open the Machines tab and assert both rows render (the node's name and 'This server') with the seeded done count, no page errors, and at 375×667 nothing sticks out sideways (the same check the other tabs use).

Verify with `npm test -- test/stats.test.mjs test/ui-stats.test.mjs`.

## Done when

`npm test -- test/stats.test.mjs test/ui-stats.test.mjs` passes and `grep -q "'machines'" public/stats.js`

## Result — done (check passed) (2026-09-28 12:54)

AGENT-ORCH-STATUS: done — Stats has a tested Machines tab with per-machine rows and share bar
