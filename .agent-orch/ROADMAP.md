# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 12:30 (reflect #346)._ Main is clean at 4575531. Since #337 landed #321 (Skills & tools back to Settings) and
#331 (Files find); #338–#341 (gate-proxy loophole, github push, digest, chat search wiring) and the owner's #344/#345
(placement on every machine, git through the head) are queued. For this reflection the tests of the modules touched below
were run to a log (verify, push, worktree, browser-task, ui-browser-view): 33 of 33 pass, none skipped. No full-suite run
(owner: keep suite runs minimal). Nothing is known broken on main.

**The push is in flight.** #299, #302, #305 and #319 wait for integrators #314, #311, #312 and #334; #301 (measured
concurrency) waits on #299; #344/#345 are the owner's urgent placement and head-git work. Together with #315–#317, #323,
#328, #335 and #338–#341 they hold orchestrator.mjs, cluster.mjs, worker.mjs, server.mjs, parallel.mjs, resources.mjs,
capacity.mjs, cluster-git.mjs, taskrun.mjs, gate.mjs, gate-proxy.mjs, agent-share.mjs, browser-view.mjs, retention.mjs,
github.mjs, digest.mjs, public/app.js|app.css|index.html|sw.js|stats.*, README.md, AUDIT.md, UI-REVIEW.md and CONTEXT.md.
So this reflection queues work in files nobody holds, taking the owner's direction (features on what exists, reliability
with tests) and AUDIT round 7's own priority order:
- **The verifier (round 7 #64–#66, its priority 1).** Verified again today: a fenced block passes when only its last line
  passes; `` `node_modules` `` becomes a command (`node_modules && npm test` exits 127, "command not found", accepted
  unverified); `CI=1 npm test` and `npm test 2>&1 | grep …` are refused, which leaves the task with no check at all.
  Two small taskrun.mjs tasks (they serialise behind #335 through `files`).
- **push.mjs #53:** an unreadable VAPID key file is replaced by a new pair (every device then fails with 403 forever) and
  a bad PEM throws at server boot. Generate only on ENOENT; otherwise log and turn push off.
- **worktrees.mjs #62:** a symlinked worktrees root makes every reuse delete the worktree's uncommitted work.
- **browser-task.mjs #58:** status by phrase match calls bookings "failed" and CAPTCHA blocks "done". Ask for the marker
  on the last line and trust it first (the orchestrator half, routing failures through `fail()`, waits for orchestrator.mjs).
- **Feature: earlier prompts in the Browser tab.** BX.tasks already holds the profile's recent screen prompts, but the panel
  shows one. A compact list with tap-to-show and "Ask again" makes the tab a history, not a single slot.
- An AUDIT ledger task marks those five fixed once they land (AUDIT.md is held by #315–#317 until then).

Goals 1–8, 10 and 11 of the brief are met. Goal 9 lands with #311/#314, #301 and the owner's #344/#345. Goal 12 has its
foundations and waits for the owner. Goal 6's push notifications are backend-complete (#304/#306); the phone side is #312.

Open ledgers: AUDIT round 6 has 11 open findings (#38, #39, #41, #42, #44, #46–#50, #52), of which #41/#42/#46/#49/#50 are
queued (#315–#318 partly landed). Round 7 (#53–#67): #61 is #328, #53/#58/#62/#64/#65/#66 are queued by this reflection;
#54–#57, #59, #60, #63 and #67 need orchestrator.mjs/server.mjs/worker.mjs and wait. UI-REVIEW round 2 has 14 open rows;
#23 (integrator #334) is in flight, #18 and #33 landed.

Things the owner should know:
- **`autoRestart` is still off** (kv `parallel_settings` = `{"controllerWork":true}`). AUDIT #43's preflight is live, so it
  is safe to turn on in gear → Settings. Until a restart the live server does not run anything merged since 2026-09-27
  (push routes, screen prompts, the Browser tab's prompt box, rapid top-up, the verifier fixes, search, changes).
- **Push notifications work only in the home-screen app on iPhone**, after #312 lands and the server restarts.
- **AUDIT #38 (high) stays open by design:** approvals are a log and a speed bump until AGENTIC.md's run sandbox. Keep
  connectors with outbound tools out of the MCP list until then.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

## Next (queued by #346)
1. taskrun.mjs, AUDIT #64: every line of a fenced Done-when block and every `;`-separated part of a snippet must pass (joined
   with ` && `; the grep "prints nothing" rewrite keeps its own `; test $? -eq 1`).
2. taskrun.mjs, AUDIT #65/#66 (extractor half): runner names need a word boundary, path-like snippets are not commands,
   `2>&1`, env prefixes, a leading `cd <dir> &&` and up to three `&&` are accepted. The other half (a refused snippet fails
   the task instead of merging unchecked; 127 accepted only for a missing first word) lives in orchestrator.mjs: later.
3. push.mjs, AUDIT #53: a key pair is generated only on ENOENT; a bad file or PEM disables push without overwriting or
   throwing; `checkSub` rejects a p256dh that is not on the curve; an https `sub`.
4. worktrees.mjs, AUDIT #62: the worktrees root is resolved through realpath so a symlinked root still matches git's list.
5. browser-task.mjs, AUDIT #58: the last-line `AGENT-ORCH-STATUS: done|failed` marker decides; the phrase heuristic applies
   only to the last paragraph of a reply without a marker.
6. Browser tab: an "Earlier prompts" list under the activity panel with tap-to-show and "Ask again".
7. AUDIT ledger: mark #53, #58 (module half), #62, #64, #65/#66 (extractor half) once 1–5 land.
Still queued from earlier reflections: #315–#317, #323, #328, #334, #335, #338–#341; integrators #311, #312, #314; the
owner's #301, #344, #345.

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
- Wire the digest (#340): `GET /api/orch/digest?since=`; a "Since you were away" group at the top of the Queue.
- Wire task changes (#330): `GET /api/orch/task/:id/changes`; a "Changes" section in the task drawer.
- Settings "Send a test notification" (`POST /api/push/test`).
- UI-REVIEW #25 "Needs you" group at the top of the Queue with a count the app badge reuses.
- Retry a failed task from the drawer with an optional note.
- Goal 9 follow-ups: an emergency guard on workers (pause the newest job near OOM, as the controller does).
- UI-REVIEW #18's second half: a "Phone size" toggle that re-emulates the viewport at the stage size.
- AUDIT #39, #44, #47, #48, #42 (cluster half), #52, #41 (Chromium sandbox): as listed in AUDIT.md.
- gate-proxy.mjs: a per-call ceiling (the approval TTL) so a forwarded call whose upstream never answers can't block the
  chain for good.
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
