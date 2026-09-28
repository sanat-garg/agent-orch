# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 13:15 (reflect #379, a rapid top-up after #367)._ Main is clean at faa25b8 (#370 and #365 landed since #367).
Running: #347, #372, #373, #378; queued: #301, #312, #314, #323, #344, #348, #359, #363, #364, #368, #369, #371,
#374–#377, #380–#382; needs integration: #299, #305, #315, #345. For this reflection the tests of the unheld modules ran
to a log (gate, gate-proxy, approvals, extensions, worktrees, push, digest, changes, search, github, models, usage, media,
attachments, connections, remote-login, agent-share, stats, node-metrics, worker-cap, worker-status, delegate, helpers,
runtimes, agents, power): **197 ran, 196 passed, 1 failed**. No full-suite run (owner: keep suite runs minimal).

**One thing is broken on main.** test/worker-cap.test.mjs "the head keeps to a worker's local cap" fails since #311 landed
(12:37): `nodeCap` now takes the owner's max slots as `min(maxSlots, cap.maxTasks)` and ignores the worker's CPU cap
(`node worker.mjs limit --cpu 4` → 4 tasks at one core each), so the head offers jobs the worker then refuses
(`capRejection`). Dropping the RAM arithmetic was goal 9's intent and the test's RAM expectations are stale; dropping the
CPU part of the one setting a worker owns (goal 11: "which the head must respect") was not. Queued first (task 1 below).

**What is held.** Queued and running work holds orchestrator.mjs, parallel.mjs, server.mjs, cluster.mjs, cluster-git.mjs,
cluster-protocol.mjs, capacity.mjs, resources.mjs, net-resolve.mjs, worker.mjs, browser-live.mjs, browser-view.mjs,
browser.mjs, bin/browser-mcp.mjs, bin/install-worker-macos.sh, files.mjs, retention.mjs, taskrun.mjs, health.mjs,
bin/agent-health.mjs, approvals.mjs, public/app.js|app.css|index.html|sw.js|browser.*|files.*, README.md and AUDIT.md.
Every open UI-REVIEW row but #28 and most open AUDIT items live there, so this top-up again takes the owner's direction
(features on what exists, plus loopholes with tests) in files nobody holds:
- **Gate loopholes, verified in gate.mjs `classify`:** `browser_file_upload` is draft, so a browser task can hand any local
  file (the head's data dir, ~/.codex/auth.json) to a web page unasked; `browser_mouse_click_xy`/`_drag_xy` are draft, so a
  click on "Send" by coordinates skips the element classifier entirely; `javascript:`/`data:` navigation is draft (isLocalUrl
  throws on the fake port and says "not local"), which is arbitrary code in the page; and `browser_press_key`'s "always" key
  is the key name alone, so one Always on Enter in a search box covers every later Enter (Send in Slack). New AUDIT #68.
- **extensions.mjs:** `saveMcp` keeps `outbound` only for stdio servers, so an http/sse connector's outbound tools are
  silently dropped and it runs ungated in task runs (the gate proxies stdio only). New AUDIT #69.
- **Stats:** the owner has 9 failed and 53 cancelled tasks and nothing shows why; `tasks.result` carries the reason
  ("blocked: #187", "setup failed: …", "still not done after 4 sessions", "cancelled with #101"). A classified `why` in
  stats.mjs and a "Why tasks failed" card in the Stats sheet make the failure pattern visible.
- **Skills & tools:** "Check" an MCP server before a task depends on it needs a probe (initialize + tools/list over stdio
  or streamable http, with a timeout). The module lands now; the route and button wait for server.mjs.
- **Disk hygiene:** `placeUploads` copies attachments into `<project>/.agent-orch/uploads/` and nothing ever removes them.
- **UI-REVIEW #28** (dark selected segment 1.05:1) can be fixed in stats.css and ext.css now; the Files switch and Max
  tasks parts wait for app.css.

Goals 1–8, 10 and 11 of the brief are met. Goal 9 lands with #314, #301 and the owner's #344/#345/#378. Goal 12 has
its foundations and waits for the owner. Goal 6's push notifications are backend-complete; the phone side is #312.

Open ledgers: AUDIT round 6 has 10 open findings (#38, #39, #42, #44, #47, #48, #49 wait for the ledger, #50 is
#315/#363, #52). Round 7: #53/#58/#62/#64/#65/#66 marked (#355), #61 is #369, #54–#57, #59, #60, #63 and #67 need
orchestrator.mjs/server.mjs/worker.mjs. Round 8 opens below with #68–#70. UI-REVIEW round 2 has 11 open rows.

Things the owner should know:
- **`autoRestart` is still off** (kv `parallel_settings` = `{"controllerWork":true}`). AUDIT #43's preflight is live, so it
  is safe to turn on in gear → Settings. Until a restart the live server does not run anything merged since 2026-09-27.
- **A task the owner cancels records no reason** (32 of the 53 cancelled rows have an empty result), so the new Stats card
  will say "cancelled" without a why until orchestrator.mjs `cancel` writes one (Later).
- **Push notifications work only in the home-screen app on iPhone**, after #312 lands and the server restarts.
- **AUDIT #38 (high) stays open by design:** approvals are a log and a speed bump until AGENTIC.md's run sandbox. Keep
  connectors with outbound tools out of the MCP list until then; #69 (below) makes an http connector with outbound
  tools stay out of gated runs instead of running ungated.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

## Next (queued by #379)
1. **Fix the failing test:** `nodeCap` with owner max slots = min(maxSlots, the worker's cap.maxTasks AND its CPU cap via
   cap.mjs `capTasks`), no RAM arithmetic; test/worker-cap.test.mjs expects capped 4, ram-used 8. (orchestrator.mjs is
   held by #378/#344/#348/#301: a one-line change, so a merge is cheap.)
2. gate.mjs AUDIT #68: uploads, `javascript:`/`data:` navigation and coordinate clicks/drags are outbound; Enter's always
   key names the focused field. New test file test/gate-classify.test.mjs.
3. tests: the proxy holds a file upload and a coordinate click end to end (fake browser MCP), after 2.
4. stats.mjs: `tasks[].why` for failed/cancelled tasks (check failed, setup failed, blocked, gave up, push failed,
   browser, cancelled with #N, cancelled) and a `failures` summary.
5. Stats ui: a "Why tasks failed" card on Overview with the count per reason and the last three tasks each, after 4.
6. extensions.mjs AUDIT #69: http/sse servers keep `outbound`; a gated run withholds a connector the proxy can't gate
   and the run's log and the MCP form say why.
7. mcp-probe.mjs: `probeMcp(server, {timeoutMs})` → `{ok, tools, serverInfo, ms}` or `{ok: false, error}` for stdio and http.
8. UI-REVIEW #28 (Stats and Skills & tools tabs): `--seg-on` in the dark blocks of stats.css and ext.css, 600 weight,
   ui-contrast asserts both.
9. uploads.mjs: `placeUploads` sweeps project-side copies older than 30 days that aren't being placed.
10. AUDIT ledger round 8: #68, #69 and #70 (the nodeCap regression), after 1, 2 and 6.
Queued by earlier reflections: #369, #371, #374–#377; the owner's #344, #347, #348, #359, #368, #378, #380–#382;
integrators #312, #314, #363, #364; #323 (README).

## Later
Once the integrators (#312, #314, #363, #364), #301 and #344/#347/#348/#359/#368/#378 free orchestrator.mjs, server.mjs,
worker.mjs and app.js:
- Wire #370/#371: `finishWork` fails a task with "Done-when check was refused: …" and accepts a 127 only when
  `checkUnavailable` says so (AUDIT #65/#66 closed); then the AUDIT ledger for #61, #65, #66.
- Wire the MCP probe (task 7): `POST /api/ext/mcp/:name/check` and a "Check" button in Skills & tools that lists the
  server's tools or its error.
- Owner cancel writes a reason into `tasks.result` ("cancelled by you" / the note), so Stats and the digest can say why.
- Gate for http connectors: gate-proxy.mjs speaks streamable http upstream, so an http connector with outbound tools can
  be gated instead of withheld (AUDIT #69's lasting fix).
- CLUSTER.md "Scheduling" and "Local cap" still describe headroom placement and the head's RAM-cap arithmetic; rewrite
  them once #344 and #301 settle the rules.
- AUDIT #58's other half: screen-prompt failures go through `fail()`; a reply without a marker shows as "Unclear".
- AUDIT #57: a resumed screen prompt gets "Continue; check the page for what is already done"; a lost one fails with its
  steps so far. AUDIT #56: refuse a screen prompt for a node `place` could never pick (409).
- AUDIT #60: back off rapid top-up after a reflection that added nothing ready; never top up past an `awaiting_review`
  checkpoint; a stale 5 h reading counts as cautious.
- AUDIT #54/#55: keep the newest dropped push per tag; a global push budget; generic push bodies; badge only for active projects.
- AUDIT #59: `GET /api/browser/tasks` without steps plus `GET /api/browser/tasks/:id`.
- AUDIT #63: delete screen-prompt workspaces on done/failed/cancelled and sweep `browser-tasks/` at boot. AUDIT #67: the
  shared Claude token only in Claude runs' env; back up a worker's own Codex auth.json.
- Wire the digest (#340): `GET /api/orch/digest?since=`; a "Since you were away" group at the top of the Queue.
- Wire task changes (#330): `GET /api/orch/task/:id/changes`; a "Changes" section in the task drawer.
- Settings "Send a test notification" (`POST /api/push/test`).
- UI-REVIEW #25 "Needs you" group at the top of the Queue; #24 machine names instead of node ids in cards and approvals.
- Retry a failed task from the drawer with an optional note.
- Goal 9 follow-ups: an emergency guard on workers (pause the newest job near OOM, as the controller does).
- UI-REVIEW #18's second half: a "Phone size" toggle that re-emulates the viewport at the stage size.
- AUDIT #39, #44, #47, #48, #42 (cluster half), #52, #41 (Chromium sandbox): as listed in AUDIT.md.
- UI-REVIEW #28's app.css half (Files switch, Max tasks) and #30: the off switch track gets its own ≥ 3:1 token and 51×31.
- UI-REVIEW round 2, remaining: #19 and round 1 #9 fallback editor as a sheet (owner's decision); #21 swipe-to-dismiss;
  #26 Machines as one sheet; #29 an in-app confirm sheet (also for ext.js's skill delete and "Discard your changes?");
  #31 focus containment; #32 a visible Copy on the install command; #34 one Deny button; #35 verbs in the Actions log.
- Voice dictation in the composer on iOS via the Web Speech API when available.
Other:
- AUDIT #38 is the run sandbox (AGENTIC.md phase 2). Owner's call on when.
- AGENTIC.md phase 1 (files-only `workspace` project type, statement ingestion, reconciliation report) when the owner asks
  for computer work again; connectors (Gmail etc.) only on the owner's say-so.
- extensions.mjs `importSkill` with a commit sha as the ref (`/tree/<sha>/…`) fails on `--branch`; fetch the sha instead.
- Run `bin/orch-e2e.mjs` against the restarted controller once the Mac undrains.
- Owner branches `claude/mode-menu`, `claude/processes-panel`, `claude/topbar-safe-area`, `claude/heuristic-visvesvaraya-d78c0d`
  and `agent-orch/task-197/-199/-209` are far behind main: ask before landing or deleting.
- Split public/app.js (~7k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
