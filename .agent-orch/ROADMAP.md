# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 11:35 (reflect #310)._ Main is clean at 9654f0e. Since #298's full run (516/516 on 62b462b) the tasks #300, #303,
#304, #306 and #308 landed; their test files (push, push-events, browser-task ×3, cluster-capacity, rapid-planning, parallel,
approval-gate, browser-live) were re-run for this reflection: all pass (exit 0). No full-suite run this time (owner: keep suite
runs minimal; nothing else changed on main).

**The push is in flight, not done.** Four tasks finished on branches but hit rebase conflicts and wait for their queued
integrators: #299 (owner caps, → #314), #302 (controller slots 1–16, → #311), #305 (push UI + service worker, → #312) and #309
(Browser header tab with prompt box, → #313). #301 (measured AIMD concurrency, urgent) waits on #299. Between them these hold
orchestrator.mjs, parallel.mjs, cluster.mjs, worker.mjs, resources.mjs, server.mjs, public/app.js, app.css, index.html,
browser.js and CONTEXT.md, so this reflection queues only work in files none of them touch: audit fixes in browser-view,
agent-share, gate, node-metrics and approvals; Stats and Skills & tools HIG rows; a chat-search module; README; AUDIT round 7.
Ten tasks rather than eleven: stretching into held files would only create more integrators.

Goals 1–8, 10 and 11 of the brief are met. Goal 9 (rapid mode) lands with the integrators above plus #301. Goal 12 has its
foundations (browser tasks, screen prompts via `/api/browser/task`, the approval gate, AGENTIC.md) and waits for the owner.
Goal 6's biggest gap, silence when the app is closed, is closed on the backend (#304/#306); the phone side is #305/#312.

Open ledgers: AUDIT round 6 has 11 open findings (#38, #39, #41, #42, #44, #46–#50, #52); this reflection queues #41, #42
(the halves outside cluster.mjs), #46, #49 and #50. UI-REVIEW round 2 has 16 open rows; #23, #27 and #33 are queued.

Things the owner should know:
- **`autoRestart` is still off** (kv `parallel_settings` = `{"controllerWork":true}`). AUDIT #43's preflight is live, so it is
  safe to turn on in gear → Settings. Until a restart, the live server does not run #300/#303/#304/#306/#308 (push routes,
  screen prompts, rapid top-up): a restart when idle is needed for those to take effect.
- **Push notifications work only in the home-screen app on iPhone**, after #312 lands and the server restarts.
- **AUDIT #38 (high) stays open by design:** approvals are a log and a speed bump until AGENTIC.md's run sandbox. Keep
  connectors with outbound tools out of the MCP list until then.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

## Next (queued by #310)
1. AUDIT #50: `bv_open`'s `url` is honoured only when the socket may drive (no active task, or the take-over controller).
2. AUDIT #46: `fromWorker` keeps `auth.json.prev`, rejects a `last_refresh` in the future, and checks the token's account.
3. AUDIT #49 and #41 in gate.mjs: no "always" key for arbitrary-code tools, connector keys carry an argument hash, and
   navigation to loopback/link-local/private hosts is outbound.
4. AUDIT #42, the halves outside cluster.mjs: `sampleOf` clips `cpu` to 256 cores and `read()` is bounded; a run with 20
   pending approvals gets new ones auto-denied.
5. UI-REVIEW #23: heatmap labels ≥ 11px, a text value per cell, and 14 days on phones with "Show all days".
6. UI-REVIEW #27: Stats tabs and the range chip on one row on phones; the subtitle scrolls with the body.
7. UI-REVIEW #33: closing Skills & tools returns to Settings when it was opened from there.
8. Chat search backend: `search.mjs` `searchConvos` over titles and chat logs, streamed and capped, with tests (the
   `GET /api/convos?q=` route and the sidebar field follow once server.mjs and app.js are free).
9. README: parallel section rewritten for goal 9, plus push notifications and the Browser tab (after #311 and #312).
10. AUDIT round 7: push.mjs, screen prompts, rapid top-up, retention GC, worktree sweep, the verifier and agent-share.

## Later
Once the integrators (#311–#314) and #301 land, in this order:
- Wire chat search: `GET /api/convos?q=` in server.mjs using search.mjs, a search field in the sidebar (app.js).
- UI-REVIEW #25: a "Needs you" group at the top of the Queue (pending approvals, review checkpoints, paused tasks, chat
  permission prompts) with a count the app badge reuses.
- Task drawer "Changes": `GET /api/orch/task/:id/changes` returns the task's commit stat and patch (capped) and the drawer
  renders it with collapsible files.
- Retry a failed task from the drawer with an optional note (a fresh task that cites the failure), instead of re-planning.
- A "Today" digest at the top of the Queue: tasks finished since the owner last opened the app, with their one-line results.
- Goal 9 follow-ups: an emergency guard on workers (pause the newest job near OOM, as the controller does); a Settings
  "Send a test notification" button (`POST /api/push/test`).
- AUDIT #39: worker half (a worker job whose synced MCP list has a connector with `outbound` tools opens the gate) and
  controller half (planner and reflection runs never get an ungated outbound connector).
- AUDIT #44: the restart drain waits only for local runs and, for a run held on an approval, a capped time.
- AUDIT #47 and #48: `revoke()` clears `tasks.run_on` with a task event; a remote task whose worker ran no check fails
  verification instead of merging as "check unavailable".
- AUDIT #42, cluster half: a per-connection frame budget, version sha only from `hello`, a cached gzipped extension bundle.
- AUDIT #52: workers refuse an `http://` head unless loopback or `--insecure`. AUDIT #41's other half: Chromium sandbox
  (`AGENT_ORCH_BROWSER_SANDBOX=1`) where the kernel allows.
- UI-REVIEW #30 and #28: the off switch track gets its own ≥ 3:1 token and 51×31 on touch; dark mode gets `--seg-on`.
- UI-REVIEW round 2, remaining: #18 live view pinch/pan on phones; #19 and round 1 #9 fallback editor as an edge-to-edge
  sheet (owner's decision); #21 swipe-to-dismiss; #24 plain-language approvals; #26 Machines as one sheet; #29 an in-app
  confirm sheet for the `window.confirm` calls; #31 focus containment; #32 a visible Copy on the install command; #34 one
  Deny button; #35 verbs instead of tool ids in the Actions log.
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
- Reflections: run the needed tests to a log file first and emit the task block in the final message; never end the turn
  waiting on a background job (#297 lost its plan that way). Check which files queued integrators hold before queuing.
