# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 14:20 (reflect #425, a rapid top-up after #413)._ Main is at d99af1f. Everything #413 queued has landed except the
two files-manager steps (#418, #419, queued): #420 http connectors through the gate proxy, #421 worktrees.mjs retries, #422
browser-tasks GC, #424 login wording; #423 (CLUSTER.md) waits on #344. #364 integrated #345 (workers clone and push through the
head's cluster-git.mjs). Running: #400; queued: #344, #382, #385, #386, #398, #399, #407, #414–#419, #423; needs integration:
#305, #347, #374, #378, #380, #381, #392, #402, #406. For this reflection the tests of the unheld modules ran to a log (gate-proxy
×2, extensions, worktree, retention, push ×2, stats, digest, changes, cluster-git ×2, verify, git-retry, approval-gate ×2,
delegate, models, usage, search ×2, connections, node-metrics, worker-cap, worker-status, mcp-probe, agent-share, attachments,
agent-health, media): **210 ran, 210 passed, 0 failed**. No full-suite run (owner: keep suite runs minimal). Nothing is broken on
main in the unheld set.

**What failed and why.** #389 (gate.mjs AUDIT #68) failed after four sessions because its Done-when also ran
test/approval-gate-browser.test.mjs, which needs Chromium, on a Mac where no Playwright browser launches. #390 and #397 were
blocked behind it. The loopholes are still open: `browser_file_upload`, `browser_mouse_click_xy`/`_drag_xy` and
`javascript:`/`data:` navigation are still in BROWSER_DRAFT, and `browser_press_key`'s Always key is still the key name alone.
The re-run below checks only the pure classifier test, so it passes on any machine.

**What is held.** Queued and running work holds orchestrator.mjs, parallel.mjs, cluster.mjs, worker.mjs, server.mjs, version.mjs,
browser.mjs, bin/browser-mcp.mjs, agents.mjs, browser-task.mjs, browser-live.mjs, browser-view.mjs, files.mjs, CLUSTER.md and
public/app.js|app.css|index.html|files.*|browser.*|stats.js. Every open UI-REVIEW row lives in app.js/app.css and every "wire it"
item below needs server.mjs or orchestrator.mjs. Free and worth a step now (the owner's direction: features on what exists, plus
loopholes and error handling with tests):
- **gate.mjs AUDIT #68** (above): four classifier loopholes, a browser-free check this time.
- **cluster-git.mjs buffers a whole push in RAM** (`readAll`, up to 1 GiB) before git sees it, on a 1-core head whose memory is the
  emergency brake for every task. The command list is the first few pkt-lines; the rest can stream into `git http-backend`. A
  client that disconnects mid-clone also leaves the CGI running with nobody reading it.
- **gate-proxy http: a stale `Mcp-Session-Id`.** When the upstream restarts (hosted connectors do) every later POST answers 404 and
  the run fails each call until it is restarted; the spec says re-initialize once and retry.
- **AUDIT ledger round 8** (#68–#70) was never written (#397 blocked on #389). #69 is fixed by #393 + #412 + #420, #70 by #388.

Goals 1–8, 10 and 11 of the brief are met. Goal 9 is the owner's active push (#344, #378 pending integration; #384 landed).
Goal 12 has its foundations and waits for the owner. Goal 6's push notifications are backend-complete; the phone side is #305.

Open ledgers: AUDIT round 6 has open #38, #39, #42, #44, #47, #48, #52 (held files). Round 7: #61, #65, #66 fixed but unmarked;
#54–#57, #59, #60, #63 (worker half), #67 open (#54's push half landed in #411, unwired; #63's head half in #422). Round 8 is the
ledger step below. UI-REVIEW round 2 has 11 open rows (#9, #19, #21, #24–#26, #29–#32, #34, #35), all in app.js/app.css.

Things the owner should know:
- **`autoRestart` is still off** (kv `parallel_settings`). AUDIT #43's preflight is live, so it is safe to turn on in gear →
  Settings. Until a restart the live server does not run anything merged since 2026-09-27, including cluster-git.
- **Landed but unwired** (needs server.mjs / orchestrator.mjs, held by the browser, version and placement work): #409 git
  retries (orchestrator/worker halves), #411 push coalescing, #370/#371 check refusal, #394 MCP probe, #340 digest, #330 task changes.
- **A task the owner cancels records no reason**, so the Stats "Why tasks failed" card (#392) says "cancelled" without a why.
- **AUDIT #38 (high) stays open by design:** approvals are a log and a speed bump until AGENTIC.md's run sandbox.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

## Next (queued by #425)
1. gate.mjs AUDIT #68 re-run: uploads, coordinate clicks and `javascript:`/`data:` navigation are outbound; Enter's Always key
   names the field. Checked by the pure classifier test only.
2. cluster-git.mjs: a push is checked from its first pkt-lines and streamed into git, never buffered whole; git is killed when
   the client goes away.
3. gate-proxy.mjs http: on a 404 for a stale session, initialize again once and retry the call.
4. AUDIT.md round 8 (#68–#70), after 1.
Queued by earlier reflections: #418, #419, #423; the owner's #344, #382, #385, #386, #398–#400, #407, #414–#417.

## Later
Once the integrators and the owner's #344/#399/#400/#407/#415/#417 free orchestrator.mjs, server.mjs, worker.mjs and app.js:
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
- Retry a failed task from the drawer with an optional note. Voice dictation in the composer on iOS (Web Speech API).
- worker.mjs: #359's remaining parts (pin the head's resolved IP with a DNS fallback, `caffeinate` while jobs run, `status --word`);
  AUDIT #63's worker half (`dropWorktree` for browser jobs, sweep `browser-tasks/` at boot); AUDIT #67 (the shared Claude token only
  in Claude runs' env; back up a worker's own Codex auth.json); AUDIT #52 (refuse an http head unless loopback).
- AUDIT #60: back off rapid top-up after a reflection that added nothing ready; never top up past an `awaiting_review` checkpoint.
- AUDIT #55–#59: generic push bodies and active-project badges; screen prompts refused for nodes `place` can't pick (409), resumed
  with "check the page for what is already done", lost ones failed with their steps; `browserTaskStatus` through `fail()`;
  `GET /api/browser/tasks` without steps plus `/api/browser/tasks/:id`.
- tests: the gate proxy holds a file upload and a coordinate click end to end with the fake browser MCP (#390's idea), pinned to
  a machine with Chromium.
- UI-REVIEW #25 "Needs you" group at the top of the Queue; #24 machine names instead of node ids; #19/#9 fallback editor as a sheet;
  #21 swipe-to-dismiss; #26 Machines as one sheet; #29 an in-app confirm sheet; #31 focus containment; #32 a visible Copy on the
  install command; #34 one Deny button; #35 verbs in the Actions log; #30 switch tracks.
- Goal 9 follow-ups: an emergency guard on workers (pause the newest job near OOM, as the controller does).
- AUDIT #39, #44, #47, #48, #42 (cluster half): as listed in AUDIT.md. #38 is the run sandbox (AGENTIC.md phase 2): owner's call.
- AGENTIC.md phase 1 (files-only `workspace` project type, statement ingestion, reconciliation report) when the owner asks for
  computer work again; connectors (Gmail etc.) only on the owner's say-so.
- extensions.mjs `importSkill` with a commit sha as the ref (`/tree/<sha>/…`) fails on `--branch`; fetch the sha instead.
- cluster-git.mjs: workers can fetch any ref of a project, `backup/pre-agent-orch` included; hide refs outside main and task branches.
- Run `bin/orch-e2e.mjs` against the restarted controller once the Mac undrains.
- Owner branches `claude/mode-menu`, `claude/processes-panel`, `claude/topbar-safe-area`, `claude/heuristic-visvesvaraya-d78c0d`
  and `agent-orch/task-197/-199/-209` are far behind main: ask before landing or deleting.
- Split public/app.js (~7k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
