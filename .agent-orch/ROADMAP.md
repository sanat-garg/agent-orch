# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 12:52 (reflect #367, a rapid top-up after #361)._ Main is clean at 6497a12 (#366 landed: models.mjs keeps the
last good list). Since #361, #362, #360, #357, #358, #354, #353, #349, #350–#352, #316, #317, #334, #311 and #355 landed.
Running: #344; queued: #301, #312, #314, #323, #347, #348, #359, #363, #364, #365; needs integration: #299, #305, #315,
#345. For this reflection the tests of the unheld modules ran to a log (retention, attachments, digest, changes, search,
github, worktrees, verifier, push, approvals, agent-share, usage, media, files, delegate, health, helpers, extensions,
remote-login, connections, worker-cap, worker-status, gate-proxy, browser-task, runtimes, node-metrics): 151 passed, 0
failed before the run was cut short by a session restart. No full-suite run (owner: keep suite runs minimal). Nothing is
known broken on main.

**What is held.** Queued and running work holds orchestrator.mjs, server.mjs, cluster.mjs, cluster-git.mjs, capacity.mjs,
resources.mjs, parallel.mjs, net-resolve.mjs, worker.mjs, browser-live.mjs, browser-view.mjs, browser.mjs, bin/browser-mcp.mjs,
bin/install-worker-macos.sh, stats.mjs, public/app.js|app.css|index.html|sw.js|browser.*|stats.*, README.md and AUDIT.md.
Every open UI-REVIEW row and most open AUDIT items (#39, #42, #44, #47, #48, #52, #54–#57, #59, #60, #63, #67) live in
those files, so this top-up takes the owner's direction in files nobody holds:
- **Files tab features on what #331/#358 built** (files.mjs, public/files.js are free): search options for Contents mode
  (match case, whole word, regular expression); a "Changed" view listing what the agents changed in the project (git
  status with +/− counts) with a per-file diff in Quick Look; and "Ask in chat", which drops `path:line` into the composer
  from Quick Look or a Contents hit, so the owner can go from finding a line to asking about it without typing paths.
- **Reliability, verified in the code:** retention.mjs still deletes approval screenshots after 7 days while the approval
  is pending and never prunes `<DATA>/uploads` (AUDIT #61; #328 failed only in setup, a fetch race on one checkout).
  taskrun.mjs `extractCommand` returns null both for "no command" and "refused", so the orchestrator can't fail a refused
  Done-when (AUDIT #66's second half) and `runCheck` can't tell a missing program from a missing script inside an npm
  script (AUDIT #65's second half); both halves are queued in taskrun.mjs so the orchestrator wiring becomes a two-line
  change once it is free. health.mjs still reports an agent whose daily rediscovery failed as if nothing were wrong now
  that #366 keeps the old list. approvals.mjs writes "No answer within 24 h" on rows that expired after a shorter TTL.

Goals 1–8, 10 and 11 of the brief are met. Goal 9 lands with #314, #301 and the owner's #344/#345. Goal 12 has its
foundations and waits for the owner. Goal 6's push notifications are backend-complete; the phone side is #312.

Open ledgers: AUDIT round 6 has 10 open findings (#38, #39, #42, #44, #47, #48, #49 wait for the ledger, #50 is #315/#363,
#52). Round 7 (#53–#67): #53/#58/#62/#64/#65/#66 marked (#355), #61 queued below, #54–#57, #59, #60, #63 and #67 need
orchestrator.mjs/server.mjs/worker.mjs. UI-REVIEW round 2 has 11 open rows, all in app.js/app.css.

Things the owner should know:
- **`autoRestart` is still off** (kv `parallel_settings` = `{"controllerWork":true}`). AUDIT #43's preflight is live, so it
  is safe to turn on in gear → Settings. Until a restart the live server does not run anything merged since 2026-09-27.
- **Push notifications work only in the home-screen app on iPhone**, after #312 lands and the server restarts.
- **AUDIT #38 (high) stays open by design:** approvals are a log and a speed bump until AGENTIC.md's run sandbox. Keep
  connectors with outbound tools out of the MCP list until then.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

## Next (queued by #367)
1. retention.mjs AUDIT #61: media referenced by `approvals.screenshot`, `<DATA>/audit/*.jsonl` or a review task's result
   survives; `<DATA>/uploads/<id>` older than mediaDays and referenced by no chat log is pruned. test/retention.test.mjs.
2. taskrun.mjs: `extractCheck(doneWhen)` → `{command, refused}` so a refused snippet can fail the task (AUDIT #66 half two);
   `extractCommand` unchanged. test/verify.test.mjs.
3. taskrun.mjs: `checkUnavailable(command, output, code, env)` is true only for a 127 whose missing program is the
   command's own first word and absent from PATH (AUDIT #65 half two). test/verify.test.mjs.
4. Files tab: Contents search options (match case, whole word, regex) in files.mjs `grepFiles` and three chips in files.js.
5. files.mjs: `GET /api/files/changed` (git status + numstat) and `GET /api/files/diff?path=` (one file's unified diff, capped).
6. Files tab ui: a "Changed" view over 5 with +/− counts and a coloured diff in Quick Look (after 5).
7. Files tab ui: "Ask in chat" from Quick Look and a Contents hit puts `path:line` into the composer.
8. health.mjs: a kept-but-stale model list (`error` with models) is an error, not a problem, and says when the list is from.
9. approvals.mjs: the expiry note states the row's real TTL; a pending row past its `expires_at` at boot expires at once.
Queued by earlier reflections: #365 (Stats Machines tab), #363/#364 integrators, #323, #312, #314; the owner's #301, #347,
#348, #359.

## Later
Once the integrators (#312, #314, #363, #364), #301 and #344/#347/#348/#359 free orchestrator.mjs, server.mjs, worker.mjs and app.js:
- Wire tasks 2 and 3: `finishWork` fails a task with "Done-when check was refused: …" and accepts a 127 only when
  `checkUnavailable` says so (AUDIT #65/#66 closed); then the AUDIT ledger for #61, #65, #66.
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
- Skills & tools: "Check" an MCP server (start it, `tools/list`, show its tools or the error) before a task depends on it.
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
