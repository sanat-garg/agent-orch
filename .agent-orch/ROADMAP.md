# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 11:50 (reflect #325)._ Main is clean at ac4f7b7 (#313 integrated #309: the Browser header tab is on main). For
this reflection the free modules' tests were run to a log (push, push-events, retention, verify, runcheck, attachments,
worktree, files, media, browser-task, worker-report, stats, usage, delegate, cluster-protocol, github, browser-live-ui,
ui-browser-view): 79 of 80 pass. **One test is broken on main:** test/cluster-protocol.test.mjs expects FEATURE_LIST without
`browser-task`, which #308 added. Queued first (task 1 below). No full-suite run (owner: keep suite runs minimal).

**The push is in flight, not done.** Three tasks still wait for their queued integrators: #299 (owner caps → #314), #302
(controller slots 1–16 → #311) and #305 (push UI + service worker → #312); #301 (measured AIMD concurrency, urgent) waits on
#299. With #315–#324 they hold orchestrator.mjs, parallel.mjs, cluster.mjs, worker.mjs, resources.mjs, capacity.mjs,
server.mjs, app.js, app.css, index.html, sw.js, gate.mjs, approvals.mjs, node-metrics.mjs, agent-share.mjs, browser-view.mjs,
search.mjs, stats.js/css, ext.js/css, README.md, AUDIT.md, UI-REVIEW.md and CONTEXT.md. This reflection therefore queues only
work in files none of them touch, in the owner's direction (features on what exists, reliability with tests):
- Broken: the stale FEATURE_LIST expectation.
- Loophole: the done-when verifier voids the whole check (task merges "check unavailable") when a quoted grep pattern
  contains `>` or `rm `; the risk test must look at the unquoted command.
- Reliability: retention GC never prunes `<DATA>/uploads/<id>` and does not see approval screenshots kept only in the DB;
  push.mjs retries a dead-for-good subscription (401/403/413) forever and ignores `Retry-After`.
- Features: a task "Changes" module (stat + capped patch from the merged commit or the live branch; wiring follows when
  server.mjs and app.js are free), find-by-name across the project in the Files tab (files.mjs owns its routes, so no
  server.mjs change), and UI-REVIEW #18 (high): pinch/pan and double-tap zoom on the phone live view.

Goals 1–8, 10 and 11 of the brief are met. Goal 9 (rapid mode) lands with the integrators above plus #301. Goal 12 has its
foundations (browser tasks, screen prompts, the approval gate, AGENTIC.md) and waits for the owner. Goal 6's silence when the
app is closed is closed on the backend (#304/#306); the phone side is #305/#312.

Open ledgers: AUDIT round 6 has 11 open findings (#38, #39, #41, #42, #44, #46–#50, #52); #41, #42 (halves outside
cluster.mjs), #46, #49 and #50 are queued (#315–#318). UI-REVIEW round 2 has 16 open rows; #23, #27, #33 are queued
(#319–#321) and #18 is queued here.

Things the owner should know:
- **`autoRestart` is still off** (kv `parallel_settings` = `{"controllerWork":true}`). AUDIT #43's preflight is live, so it is
  safe to turn on in gear → Settings. Until a restart the live server does not run #300/#303/#304/#306/#308/#309 (push
  routes, screen prompts, the Browser tab's prompt box, rapid top-up).
- **Push notifications work only in the home-screen app on iPhone**, after #312 lands and the server restarts.
- **AUDIT #38 (high) stays open by design:** approvals are a log and a speed bump until AGENTIC.md's run sandbox. Keep
  connectors with outbound tools out of the MCP list until then.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

## Next (queued by #325)
1. Fix the stale test: test/cluster-protocol.test.mjs expects `browser-task` in FEATURE_LIST.
2. Verifier loophole: extractCommand judges `>`, `rm`, `sudo`, `curl`, `git push` and the `;`/`&&` count on the unquoted
   command, so a quoted grep pattern never voids the check.
3. Retention GC: prune `<DATA>/uploads/<id>` older than 30 days that no chat log names; approval screenshots referenced in the
   `approvals` table survive.
4. push.mjs: a subscription that answers 400/401/403/413 three sends in a row is dropped; 429/503 with `Retry-After` pauses
   that device until then.
5. changes.mjs: `taskChanges(info, id)` → `{files: [{path, add, del}], patch, truncated, source}` from the task's merged commit
   (`agent-orch #<id>:`) or its live branch, with tests.
6. Files tab: find files by name across the project (`GET /api/files/find?cid=&q=` in files.mjs; Enter in the filter field
   searches the whole project, results open their folder).
7. UI-REVIEW #18: two-finger pinch/pan and double-tap 1×/fit-width on the live view canvas, stage centred vertically on phones.
Still queued from #310: #315–#324 (AUDIT #41/#42/#46/#49/#50, UI-REVIEW #23/#27/#33, chat search backend, README, AUDIT round 7).

## Later
Once the integrators (#311–#314) and #301 land, in this order:
- Wire chat search: `GET /api/convos?q=` in server.mjs using search.mjs, a search field in the sidebar (app.js).
- Wire task changes: `GET /api/orch/task/:id/changes` in server.mjs using changes.mjs; a "Changes" section in the task drawer
  with collapsible files (app.js, app.css).
- Browser tab: an "Earlier prompts" list under the activity panel (BX.tasks already holds them) with tap-to-show and "Ask
  again" (public/browser.js; after task 7 above so browser.js is free).
- Settings "Send a test notification" button (`POST /api/push/test`, server.mjs + app.js).
- UI-REVIEW #25: a "Needs you" group at the top of the Queue (pending approvals, review checkpoints, paused tasks, chat
  permission prompts) with a count the app badge reuses.
- Retry a failed task from the drawer with an optional note (a fresh task that cites the failure), instead of re-planning.
- A "Today" digest at the top of the Queue: tasks finished since the owner last opened the app, with their one-line results.
- Goal 9 follow-ups: an emergency guard on workers (pause the newest job near OOM, as the controller does).
- UI-REVIEW #18's second half: a "Phone size" toggle that re-emulates the viewport at the stage size (browser-live.mjs,
  `mobile: true`, dsf 2–3) only while the owner is in control.
- AUDIT #39: worker half (a worker job whose synced MCP list has a connector with `outbound` tools opens the gate) and
  controller half (planner and reflection runs never get an ungated outbound connector).
- AUDIT #44: the restart drain waits only for local runs and, for a run held on an approval, a capped time.
- AUDIT #47 and #48: `revoke()` clears `tasks.run_on` with a task event; a remote task whose worker ran no check fails
  verification instead of merging as "check unavailable".
- AUDIT #42, cluster half: a per-connection frame budget, version sha only from `hello`, a cached gzipped extension bundle.
- AUDIT #52: workers refuse an `http://` head unless loopback or `--insecure`. AUDIT #41's other half: Chromium sandbox
  (`AGENT_ORCH_BROWSER_SANDBOX=1`) where the kernel allows.
- UI-REVIEW #30 and #28: the off switch track gets its own ≥ 3:1 token and 51×31 on touch; dark mode gets `--seg-on`.
- UI-REVIEW round 2, remaining: #19 and round 1 #9 fallback editor as an edge-to-edge sheet (owner's decision); #21
  swipe-to-dismiss; #24 plain-language approvals; #26 Machines as one sheet; #29 an in-app confirm sheet for the
  `window.confirm` calls; #31 focus containment; #32 a visible Copy on the install command; #34 one Deny button; #35 verbs
  instead of tool ids in the Actions log.
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
  A task that adds a FEATURE or MSG must update test/cluster-protocol.test.mjs's expected lists (#308 missed it).
