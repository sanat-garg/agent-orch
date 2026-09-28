# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 12:33 (reflect #356, a rapid top-up two minutes after #346)._ Main is clean at 08d9ae5. Since #346 landed #338–#341
(gate-proxy holds page actions on an unreadable page, github push without gh, digest.mjs, chat search wired) and #335 (no
substitution inside double quotes). #346's seven tasks (#349–#355) are queued; the owner's #344/#345/#347/#348 (placement on
every machine, git through the head, the live browser fix and one shared browser per profile) are running or queued. For this
reflection the tests of the two modules touched below ran to a log (gate-proxy, files): 9 of 9 pass, none skipped. No full-suite
run (owner: keep suite runs minimal). Nothing is known broken on main.

**What is held.** Queued and running work holds orchestrator.mjs, server.mjs, cluster.mjs, cluster-git.mjs, worker.mjs,
parallel.mjs, taskrun.mjs, push.mjs, worktrees.mjs, browser-task.mjs, browser-live.mjs, browser-view.mjs, browser.mjs,
gate.mjs, agent-share.mjs, public/app.js|app.css|index.html|sw.js|stats.*|browser.*, README.md, AUDIT.md, UI-REVIEW.md and
CONTEXT.md. So this top-up takes the owner's direction (a feature on what exists, a reliability fix with tests) in files nobody
holds:
- **gate-proxy.mjs: a per-call ceiling.** Calls run one at a time through `chain`, and a forwarded tools/call waits on
  `waiting` with no timeout (gate-proxy.mjs:137). A Playwright call whose upstream never answers (a hung page, a dialog the
  MCP is stuck on) blocks every later call of the run for good, including the hook's checks; the agent then sits until the
  task's own timeout. Snapshots already have `snapshotMs`; forwarded calls get `callMs` (default 5 min) with an audited
  "timed out" tool error and late answers dropped. Listed under Later since #337; now it fits.
- **Files tab: find text inside files.** #331 finds files by name (`GET /api/files/find`, files.mjs's own router, no
  server.mjs change). The natural next step for someone checking a project from the phone is "where does this string
  appear": `GET /api/files/grep?cid=&q=` (case-insensitive, text files only, capped and yielding) and a Names | Contents
  switch on the search, results as file › line number › the matching line, tap opens Quick Look.

Not re-queued: #328 (AUDIT #61, retention keeps pending approval screenshots and prunes stale uploads) failed in setup
(`cannot lock ref refs/remotes/origin/main`: two git fetches on the main checkout at once), not in its own work. Its root
cause is the orchestrator's fetch racing another (orchestrator.mjs, held by #344/#345, which move git through the head
anyway). Re-queue #61 unchanged once #345 lands and the setup fetch is serialised under `serialGit`.

Goals 1–8, 10 and 11 of the brief are met. Goal 9 lands with #311/#314, #301 and the owner's #344/#345. Goal 12 has its
foundations and waits for the owner. Goal 6's push notifications are backend-complete (#304/#306); the phone side is #312.

Open ledgers: AUDIT round 6 has 11 open findings (#38, #39, #41, #42, #44, #46–#50, #52), of which #41/#42/#46/#49/#50 are
queued (#315–#318 partly landed). Round 7 (#53–#67): #61 waits (above); #53/#58/#62/#64/#65/#66 are #349–#353; #54–#57,
#59, #60, #63 and #67 need orchestrator.mjs/server.mjs/worker.mjs and wait. UI-REVIEW round 2 has 14 open rows; #23
(integrator #334) is in flight, #18 and #33 landed.

Things the owner should know:
- **`autoRestart` is still off** (kv `parallel_settings` = `{"controllerWork":true}`). AUDIT #43's preflight is live, so it
  is safe to turn on in gear → Settings. Until a restart the live server does not run anything merged since 2026-09-27
  (push routes, screen prompts, the Browser tab's prompt box, rapid top-up, the verifier fixes, search, changes).
- **Push notifications work only in the home-screen app on iPhone**, after #312 lands and the server restarts.
- **AUDIT #38 (high) stays open by design:** approvals are a log and a speed bump until AGENTIC.md's run sandbox. Keep
  connectors with outbound tools out of the MCP list until then.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

## Next (queued by #356)
1. gate-proxy.mjs: a forwarded tools/call is answered with an audited tool error after `callMs` (config, default 5 min) and
   the chain moves on; a late upstream answer is dropped, not sent to the client twice. Fixture gains a `FAKE_MCP_HANG=<tool>`
   mode.
2. Files tab: `GET /api/files/grep?cid=&q=` in files.mjs (shares #331's walker; text files ≤ 1 MB, case-insensitive, hits and
   visited files capped, yields to the event loop) and a Names | Contents switch in public/files.js whose results show
   file › line › text and open Quick Look on tap.
Queued by #346: #349–#355 (verifier #64–#66 extractor half, push #53, worktrees #62, browser-task #58, Browser tab earlier
prompts, the AUDIT ledger). Still queued from earlier reflections: #315–#317, #323, #334; integrators #311, #312, #314;
the owner's #301, #344, #345, #347, #348.

## Later
Once the integrators (#311–#314, #334), #301 and #344/#345 free orchestrator.mjs, server.mjs and app.js, in this order:
- AUDIT #66's other half: a refused Done-when snippet fails the task ("Done-when check was refused: …") instead of merging
  unchecked; #65's 127 rule (accept only when the command's first word is absent from PATH before the check runs).
- AUDIT #58's other half: screen-prompt failures go through `fail()` (push + event); a reply without a marker shows as
  "Unclear" in the Browser tab.
- AUDIT #57: a resumed screen prompt gets "Continue; check the page for what is already done"; a lost one fails with its
  steps so far instead of re-running. AUDIT #56: refuse a screen prompt for a node `place` could never pick (409).
- AUDIT #60: back off rapid top-up after a reflection that added nothing ready; never top up past an `awaiting_review`
  checkpoint; a stale 5 h reading counts as cautious; split `requested` across perpetual projects.
- AUDIT #54/#55: keep the newest dropped push per tag and send it after the minute; a global push budget with a summary;
  generic push bodies; badge and checkpoints only for active projects with a chat.
- AUDIT #59: `GET /api/browser/tasks` without steps plus `GET /api/browser/tasks/:id`; cached steps for finished tasks.
- AUDIT #63: delete screen-prompt workspaces on done/failed/cancelled (controller and worker) and sweep `browser-tasks/`
  at boot. AUDIT #67: the shared Claude token only in Claude runs' env; back up a worker's own Codex auth.json.
- AUDIT #61 (#328's content): retention keeps screenshots of pending approvals and prunes `.agent-orch/uploads` older than the
  media age; queue once the setup fetch is serialised (see Assessment).
- Files tab follow-ups once grep lands: a regex toggle and a glob filter (`*.mjs`), and "Open in chat" that pastes `path:line`
  into the composer (app.js).
- Wire the digest (#340): `GET /api/orch/digest?since=`; a "Since you were away" group at the top of the Queue.
- Wire task changes (#330): `GET /api/orch/task/:id/changes`; a "Changes" section in the task drawer.
- Settings "Send a test notification" (`POST /api/push/test`).
- UI-REVIEW #25 "Needs you" group at the top of the Queue with a count the app badge reuses.
- Retry a failed task from the drawer with an optional note.
- Goal 9 follow-ups: an emergency guard on workers (pause the newest job near OOM, as the controller does).
- UI-REVIEW #18's second half: a "Phone size" toggle that re-emulates the viewport at the stage size.
- AUDIT #39, #44, #47, #48, #42 (cluster half), #52, #41 (Chromium sandbox): as listed in AUDIT.md.
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
  waiting on a background job (#297 lost its plan that way). Check which files queued integrators hold before queuing;
  when AUDIT.md is held, queue the code fixes without it and one ledger task `after` them.
  A task that adds a FEATURE or MSG must update test/cluster-protocol.test.mjs's expected lists (#308 missed it).
