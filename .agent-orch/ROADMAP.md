# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 11:55 (reflect #337)._ Main is clean at 2301754. Since #333 six more tasks landed (#322 chat search backend, #326,
#329, #330 task changes module, #332 pinch-zoom, #336 worker-status tests). For this reflection the free modules' tests were
run to a log (approval-gate-run, worktree, media, attachments, github, helper-kill): 29 of 29 pass. No full-suite run (owner:
keep suite runs minimal). Nothing is known broken on main.

**The push is in flight, not done.** Three tasks still wait for their queued integrators: #299 (owner caps → #314), #302
(controller slots 1–16 → #311) and #305 (push UI + service worker → #312); #301 (measured AIMD concurrency, urgent) waits on
#299; #319's integrator is #334. With #315–#335 they hold orchestrator.mjs, parallel.mjs, cluster.mjs, worker.mjs,
resources.mjs, capacity.mjs, server.mjs, app.js, app.css, index.html, sw.js, gate.mjs, agent-share.mjs, browser-view.mjs,
files.mjs, retention.mjs, taskrun.mjs, cluster-protocol.mjs, public/stats|files|ext.*, README.md, AUDIT.md, UI-REVIEW.md and
CONTEXT.md. New features that need server.mjs or app.js can only be queued behind those; this reflection (target: 4 tasks)
queues three in files nobody holds plus one feature wiring that waits its turn:
- **Gate loophole (verified):** gate-proxy.mjs classifies with an empty snapshot when `browser_snapshot` errors or times out
  (60 s). `classify('browser_click', {target:'e3', element:'the blue button'})` with no snapshot → `draft`, so a click on a
  real "Send" button passes when the page can't be read; only the agent's own description is checked. gate.mjs is held by
  #317, so the fix lives in the proxy: a page that can't be read makes element tools, key presses and dialogs outbound.
- **github.mjs blocks pushes on `gh api user`.** `createRepo` throws "GitHub is not linked" before it looks for an existing
  origin, so a transient gh/network failure stops every push of an already-created repo. Only one test covers the module.
- **Chat search is built (#322) but not reachable.** Wire `GET /api/convos?q=` and a sidebar search field.
- **A "Today" digest backend** (what finished, failed or needs the owner since they last looked) for the Queue's top, as a
  pure module with tests, wired once server.mjs/app.js are free.

Goals 1–8, 10 and 11 of the brief are met. Goal 9 (rapid mode) lands with the integrators above plus #301. Goal 12 has its
foundations (browser tasks, screen prompts, the approval gate, AGENTIC.md) and waits for the owner. Goal 6's silence when the
app is closed is closed on the backend (#304/#306); the phone side is #305/#312.

Open ledgers: AUDIT round 6 has 11 open findings (#38, #39, #41, #42, #44, #46–#50, #52); #41, #42 (halves outside
cluster.mjs), #46, #49 and #50 are queued or running (#315–#318); round 7 is being written (#324). UI-REVIEW round 2 has 15
open rows; #23 (integrator #334) and #33 (#321) are in flight, #18 landed (#332).

Things the owner should know:
- **`autoRestart` is still off** (kv `parallel_settings` = `{"controllerWork":true}`). AUDIT #43's preflight is live, so it is
  safe to turn on in gear → Settings. Until a restart the live server does not run #300/#303/#304/#306/#308/#309/#322/#327/
  #329/#330 (push routes, screen prompts, the Browser tab's prompt box, rapid top-up, the verifier fix, search, changes).
- **Push notifications work only in the home-screen app on iPhone**, after #312 lands and the server restarts.
- **AUDIT #38 (high) stays open by design:** approvals are a log and a speed bump until AGENTIC.md's run sandbox. Keep
  connectors with outbound tools out of the MCP list until then.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

## Next (queued by #337)
1. gate-proxy.mjs: a snapshot that errors or times out makes element tools, key presses and dialogs outbound (held), with a
   `snapshotMs` config for tests; the fixture gains `FAKE_MCP_SNAPSHOT=error|hang`; a new test/gate-proxy.test.mjs also
   covers the hook ticket path (a pre-checked call is forwarded without a second snapshot).
2. github.mjs: an existing origin is pushed without asking gh; only creating a repo needs the gh sign-in; tests with a local
   bare remote (repoOf, unpushed, push ok, push failure surfaces the last stderr line).
3. digest.mjs: `digest({dbFile, since, now})` → tasks finished/failed/needing the owner since `since`, per project, with
   one-line results; tests on a temp DB.
4. Wire chat search (after #322): `GET /api/convos?q=` using search.mjs, a search field above the chat list, results open the
   chat; test/search-api.test.mjs. Runs once #311/#312/#314 free server.mjs and app.js.
Still queued from #310–#333: #315–#321, #323, #324, #328, #331, #334, #335 (AUDIT #41/#42/#46/#49/#50, UI-REVIEW #23/#33,
Files find, retention, README, AUDIT round 7, verifier substitution fix).

## Later
Once the integrators (#311–#314, #334) and #301 land, in this order:
- Wire the digest: `GET /api/orch/digest?since=` in server.mjs; a "Since you were away" group at the top of the Queue
  (app.js) that remembers the last open time in localStorage.
- Wire task changes: `GET /api/orch/task/:id/changes` in server.mjs using changes.mjs; a "Changes" section in the task drawer
  with collapsible files (app.js, app.css).
- Browser tab: an "Earlier prompts" list under the activity panel (BX.tasks already holds them) with tap-to-show and "Ask
  again" (public/browser.js).
- Settings "Send a test notification" button (`POST /api/push/test`, server.mjs + app.js).
- UI-REVIEW #25: a "Needs you" group at the top of the Queue (pending approvals, review checkpoints, paused tasks, chat
  permission prompts) with a count the app badge reuses (shares the digest's needs-you query).
- Retry a failed task from the drawer with an optional note (a fresh task that cites the failure), instead of re-planning.
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
- gate-proxy.mjs: a forwarded call whose upstream never answers blocks the chain for good; a per-call ceiling (the approval
  TTL) that answers the client with an error and moves on.
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
