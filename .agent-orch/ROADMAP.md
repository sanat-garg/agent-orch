# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 12:40 (reflect #361, a rapid top-up after #356)._ Main is clean at e949809. Since #356 landed #349's neighbours
(#350–#352, #354), #316, #321, #334 and #311. Six tasks are running (#344, #345, #347, #358, #360 and this one) and nine are
queued. For this reflection the tests of the unheld modules ran to a log (stats, search, digest, changes, attachments,
retention, usage, media, the Stats UI): 42 of 42 pass, none skipped. No full-suite run (owner: keep suite runs minimal).
Nothing is known broken on main. CONTEXT.md was trimmed to what a fresh session needs.

**What is held.** Queued and running work holds orchestrator.mjs, server.mjs, cluster.mjs, cluster-git.mjs, net-resolve.mjs,
worker.mjs, parallel.mjs, taskrun.mjs, files.mjs, gate-proxy.mjs, gate.mjs, browser-task.mjs, browser-live.mjs,
browser-view.mjs, browser.mjs, public/app.js|app.css|index.html|sw.js|files.*|browser.*, README.md and AUDIT.md. So this
top-up takes the owner's direction (a feature on what exists, a reliability fix with tests) in files nobody holds:
- **Stats: a Machines tab.** The cluster is goal 11 and the owner just asked for placement across every machine (#344),
  but nothing shows what each machine actually did. `GET /api/stats` already carries `node` on every task and run;
  stats.mjs adds the `nodes` table (names) and stats.js a tab with one row per machine: tasks done/failed, check pass
  rate, busy time, tokens, last active, within the range picker.
- **models.mjs keeps the last good list when a rediscovery fails.** Verified in the code: `refresh` stores whatever
  `discover` returns, so a transient failure at the daily refresh (the CLI busy on a loaded VPS, a timeout, a network
  blip) replaces a good cached list with an empty one and `save()` persists it. The model selector for that agent is
  then empty until the next day, health reports "0 models", and delegation's `listed()` check treats the agent as
  having no models. Goal 7 (honest data) and goal 8 (foolproof fallbacks) both break. The fix keeps the old list with
  the error and retries at the next hourly tick.

Not re-queued: #328 (AUDIT #61, retention keeps pending approval screenshots and prunes stale uploads) failed in setup
(`cannot lock ref refs/remotes/origin/main`: two fetches on one checkout at once), not in its own work. #345 (git through
the head) removes the racing fetch on workers; re-queue #61 unchanged once it lands. AUDIT #67's Codex half needs
worker.mjs `applyCredential` (held by #344/#345/#359).

Goals 1–8, 10 and 11 of the brief are met. Goal 9 lands with #314, #301 and the owner's #344/#345. Goal 12 has its
foundations and waits for the owner. Goal 6's push notifications are backend-complete; the phone side is #312.

Open ledgers: AUDIT round 6 has 11 open findings (#38, #39, #41, #42, #44, #46–#50, #52), of which #41/#49/#50 are queued
(#315, #317). Round 7 (#53–#67): #53/#62/#65/#66 landed (ledger #355 waits), #58/#64 are #353/#349, #61 waits (above);
#54–#57, #59, #60, #63 and #67 need orchestrator.mjs/server.mjs/worker.mjs. UI-REVIEW round 2 has 11 open rows, all in
app.js/app.css.

Things the owner should know:
- **`autoRestart` is still off** (kv `parallel_settings` = `{"controllerWork":true}`). AUDIT #43's preflight is live, so it
  is safe to turn on in gear → Settings. Until a restart the live server does not run anything merged since 2026-09-27.
- **Push notifications work only in the home-screen app on iPhone**, after #312 lands and the server restarts.
- **AUDIT #38 (high) stays open by design:** approvals are a log and a speed bump until AGENTIC.md's run sandbox. Keep
  connectors with outbound tools out of the MCP list until then.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

## Next (queued by #361)
1. Stats Machines tab: `nodes` in `GET /api/stats` (stats.mjs) and a fifth tab in public/stats.js with one row per machine
   (This server + each node): done/failed, check pass rate, busy time, tokens, last active; a busy-time share bar; range-aware;
   fits 375px. Tests in test/stats.test.mjs and test/ui-stats.test.mjs.
2. models.mjs: a failed rediscovery keeps the previous non-empty list (with `error` and `failedAt`), never saves an empty
   list over a good one, and `refreshStale` retries an errored entry after `retryMs` (default 1 h) instead of a day. Tests
   in test/models.test.mjs.
Queued by earlier reflections: #349, #353, #355, #357 (gate-proxy callMs), #359 (owner), #315, #317, #323; integrators
#312, #314; the owner's #348.

## Later
Once the integrators (#312, #314), #301 and #344/#345/#347/#348/#360 free orchestrator.mjs, server.mjs, worker.mjs and app.js:
- AUDIT #61 (#328's content): retention keeps screenshots of pending approvals (scan `<DATA>/audit/` and `approvals.screenshot`)
  and prunes `<DATA>/uploads/<id>` older than the media age. Queue after #345 lands.
- AUDIT #66's other half: a refused Done-when snippet fails the task instead of merging unchecked; #65's 127 rule.
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
- Files tab follow-ups once #358 lands: a regex toggle and a glob filter, and "Open in chat" pasting `path:line`.
- Settings "Send a test notification" (`POST /api/push/test`).
- UI-REVIEW #25 "Needs you" group at the top of the Queue; #24 machine names instead of node ids in cards and approvals.
- Retry a failed task from the drawer with an optional note.
- Goal 9 follow-ups: an emergency guard on workers (pause the newest job near OOM, as the controller does).
- UI-REVIEW #18's second half: a "Phone size" toggle that re-emulates the viewport at the stage size.
- AUDIT #39, #44, #47, #48, #42 (cluster half), #52, #41 (Chromium sandbox): as listed in AUDIT.md.
- UI-REVIEW #30 and #28: the off switch track gets its own ≥ 3:1 token and 51×31 on touch; dark mode gets `--seg-on`.
- UI-REVIEW round 2, remaining: #19 and round 1 #9 fallback editor as a sheet (owner's decision); #21 swipe-to-dismiss;
  #26 Machines as one sheet; #29 an in-app confirm sheet; #31 focus containment; #32 a visible Copy on the install
  command; #34 one Deny button; #35 verbs instead of tool ids in the Actions log.
- Voice dictation in the composer on iOS via the Web Speech API when available.
Other:
- AUDIT #38 is the run sandbox (AGENTIC.md phase 2). Owner's call on when.
- AGENTIC.md phase 1 (files-only `workspace` project type, statement ingestion, reconciliation report) when the owner asks
  for computer work again; connectors (Gmail etc.) only on the owner's say-so.
- Run `bin/orch-e2e.mjs` against the restarted controller once the Mac undrains.
- Owner branches `claude/mode-menu`, `claude/processes-panel`, `claude/topbar-safe-area`, `claude/heuristic-visvesvaraya-d78c0d`
  and `agent-orch/task-197/-199/-209` are far behind main: ask before landing or deleting.
- Split public/app.js (~7k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
