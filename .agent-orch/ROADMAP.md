# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 14:06 (reflect #413, a rapid top-up after #405)._ Main is at 83c29a5. Everything #405 queued has landed (#408's
compute-only test fix is running; #409 git retries, #410 stale model list, #411 push coalescing, #412 http gate proxy are in),
plus #384 head capacity, #363, #368, #371, #377, #388, #391, #393–#396, #401, #403, #404. Running: #378, #389, #400, #408;
queued: #344, #364, #382, #385, #386, #390, #397–#399, #407, #414–#416 (integrators for #402, #406, #392); needs integration:
#305, #345, #347, #374, #380, #381. For this reflection the tests of the unheld modules ran to a log (extensions, worker,
git-retry, gate-proxy-http, push, agent-health, mcp-probe, digest, changes, retention, attachments, stats, worker-status,
cluster-protocol, approval-gate, approval-gate-run, ext-sync, worker-report, files-ops, files): **149 ran, 148 passed, 1
skipped, 0 failed**. No full-suite run (owner: keep suite runs minimal). Nothing is broken on main in the unheld set;
#408 covers the one red test #405 found.

**What is held.** Queued and running work holds orchestrator.mjs, parallel.mjs, server.mjs, version.mjs, cluster.mjs,
cluster-git.mjs, worker.mjs, browser-live.mjs, browser-view.mjs, browser.mjs, bin/browser-mcp.mjs, browser-task.mjs,
agents.mjs, gate.mjs, README.md, public/app.js|app.css|index.html|sw.js|files.*|browser.*|stats.js, test/compute-only and
AUDIT.md. Every open UI-REVIEW row lives in app.js/app.css, and every "wire it" item below needs server.mjs, orchestrator.mjs
or worker.mjs, so this top-up again takes the owner's direction (features on what exists, plus loopholes and error handling
with tests) in files nobody holds:
- **Files tab as a real file manager.** Copy/move/zip/unzip landed (#403/#404); rename, new file/folder and delete are the
  missing basics. Backend in files.mjs first, then the context menu in files.js.
- **Gate for http connectors, for real (AUDIT #69).** gate-proxy speaks streamable http now (#412), but extensions.mjs still
  withholds http/sse connectors from gated runs. `mcpFor` should route an http connector with outbound tools through the
  proxy with `upstream: {url, headers}`; only `sse` (the legacy transport the proxy doesn't speak) stays withheld.
- **Lock races on the main tree.** Other sessions and auto-commits touch the live checkout at once, so `worktrees.mjs`'s
  `worktree add`, `commitAll` and `mergeBack` can hit `index.lock` / ref locks. `retryGit` (#409) exists for exactly this;
  worktrees.mjs is free while orchestrator.mjs and worker.mjs are not.
- **Screen-prompt workspaces pile up (AUDIT #63, head half).** `<orchestrator>/browser-tasks/<id>` is never deleted; retention.mjs
  already runs daily with the DB and can sweep finished ones.
- **CLUSTER.md "Scheduling" and "Local cap"** still describe headroom placement and RAM-cap arithmetic that #384 replaced.
- **login.html** still says "Sign in to Claude Code on <host>" (goal 4).

Goals 1–8, 10 and 11 of the brief are met. Goal 9 is the owner's active push (#378, #344; #384 landed). Goal 12 has its
foundations and waits for the owner. Goal 6's push notifications are backend-complete; the phone side is #305/#312.

Open ledgers: AUDIT round 6 has open #38, #39, #42, #44, #47, #48, #52 (held files). Round 7: #61, #65, #66 fixed but
unmarked (ledger held); #54–#57, #59, #60, #63, #67 open (#54's push half landed in #411, unwired). Round 8 (#397) opens
#68–#70. UI-REVIEW round 2 has 11 open rows, all in app.js/app.css.

Things the owner should know:
- **`autoRestart` is still off** (kv `parallel_settings`). AUDIT #43's preflight is live, so it is safe to turn on in gear →
  Settings. Until a restart the live server does not run anything merged since 2026-09-27.
- **Landed but unwired** (needs server.mjs / orchestrator.mjs, held by the browser and version work): #409 git retries, #411
  push coalescing, #412 http gate proxy, #370/#371 check refusal, #394 MCP probe, #340 digest, #330 task changes.
- **A task the owner cancels records no reason**, so the Stats "Why tasks failed" card (#392) says "cancelled" without a why.
- **AUDIT #38 (high) stays open by design:** approvals are a log and a speed bump until AGENTIC.md's run sandbox.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

## Next (queued by #413)
1. files.mjs: `POST /api/files/rename`, `/new` and `/delete` with the same path rules as copy/move (never `.git`, never the root).
2. Files tab: Rename, New file, New folder and Delete in the context menu (after 1).
3. extensions.mjs AUDIT #69: http connectors with outbound tools go through gate-proxy (`upstream: {url, headers}`); only sse is withheld.
4. worktrees.mjs: `git()` retries lock races and network blips through `retryGit`.
5. retention.mjs AUDIT #63 (head half): sweep `browser-tasks/<id>` of finished or unknown tasks.
6. CLUSTER.md: Scheduling and Local cap rewritten for the #384/#344 rules (after #344).
7. public/login.html: "Sign in to agent-orch on <host>".
Queued by earlier reflections: #390, #397; the owner's #344, #364, #382, #385, #386, #398–#400, #407, #414–#416.

## Later
Once the integrators and the owner's #344/#364/#378/#399/#400/#407/#415 free orchestrator.mjs, server.mjs, worker.mjs and app.js:
- Wire #409: worker.mjs `git()` and orchestrator.mjs `git()`/`mergeTask`'s push through `retryGit` (closes the #328/#359/#376
  failure class); an AUDIT item for the unretried lock race.
- Wire #411: server.mjs `notify` = `createNotifier(push.send)`; Settings shows `push.disabled` and a device's last error (AUDIT #53's
  open half); `POST /api/push/test` and a "Send a test notification" button.
- Wire #370/#371: `finishWork` fails a task with "Done-when check was refused: …" and accepts a 127 only when `checkUnavailable`
  says so (AUDIT #65/#66 closed); then the AUDIT ledger for #61, #65, #66.
- Wire #394: `POST /api/ext/mcp/:name/check` and a "Check" button in Skills & tools.
- Wire #340 (`GET /api/orch/digest?since=`, a "Since you were away" group in the Queue) and #330 (`GET /api/orch/task/:id/changes`,
  a "Changes" section in the drawer).
- Owner cancel writes a reason into `tasks.result`, so Stats and the digest can say why.
- worker.mjs: #359's remaining parts (pin the head's resolved IP with a DNS fallback, `caffeinate` while jobs run, `status --word`);
  AUDIT #63's worker half (`dropWorktree` for browser jobs, sweep `browser-tasks/` at boot); AUDIT #67 (the shared Claude token only
  in Claude runs' env; back up a worker's own Codex auth.json); AUDIT #52 (refuse an http head unless loopback).
- AUDIT #60: back off rapid top-up after a reflection that added nothing ready; never top up past an `awaiting_review` checkpoint.
- AUDIT #55–#59: generic push bodies and active-project badges; screen prompts refused for nodes `place` can't pick (409), resumed
  with "check the page for what is already done", lost ones failed with their steps; `browserTaskStatus` through `fail()`;
  `GET /api/browser/tasks` without steps plus `/api/browser/tasks/:id`.
- UI-REVIEW #25 "Needs you" group at the top of the Queue; #24 machine names instead of node ids; #19/#9 fallback editor as a sheet;
  #21 swipe-to-dismiss; #26 Machines as one sheet; #29 an in-app confirm sheet; #31 focus containment; #32 a visible Copy on the
  install command; #34 one Deny button; #35 verbs in the Actions log; #28's app.css half and #30 switch tracks; #18's "Phone size".
- Retry a failed task from the drawer with an optional note. Voice dictation in the composer on iOS (Web Speech API).
- Goal 9 follow-ups: an emergency guard on workers (pause the newest job near OOM, as the controller does).
- AUDIT #39, #44, #47, #48, #42 (cluster half): as listed in AUDIT.md. #38 is the run sandbox (AGENTIC.md phase 2): owner's call.
- AGENTIC.md phase 1 (files-only `workspace` project type, statement ingestion, reconciliation report) when the owner asks for
  computer work again; connectors (Gmail etc.) only on the owner's say-so.
- extensions.mjs `importSkill` with a commit sha as the ref (`/tree/<sha>/…`) fails on `--branch`; fetch the sha instead.
- gate-proxy http: re-initialize once when the upstream answers 404 for a stale `Mcp-Session-Id`.
- Run `bin/orch-e2e.mjs` against the restarted controller once the Mac undrains.
- Owner branches `claude/mode-menu`, `claude/processes-panel`, `claude/topbar-safe-area`, `claude/heuristic-visvesvaraya-d78c0d`
  and `agent-orch/task-197/-199/-209` are far behind main: ask before landing or deleting.
- Split public/app.js (~7k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
