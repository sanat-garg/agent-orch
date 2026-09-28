# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 13:55 (reflect #405, a rapid top-up after #379)._ Main is at 4021ee4 (#388, #391, #395, #396, #371, #403 landed
since #379). Running: #378, #384, #389, #392, #393, #394, #401, #402, #404, #406; queued: #364, #363, #382, #385, #386, #390,
#397–#400, #407; needs integration: #374, #380, #381. For this reflection the tests of the unheld modules ran to a log
(gate-proxy, approvals, push, digest, changes, search, github, models, stats, retention, attachments, connections,
remote-login, agent-share, node-metrics, worker-cap, worker-status, delegate, runtimes, resources, agent-health, runcheck,
media, helper-kill, cluster-protocol, compute-only, ui-contrast, ui-static): **204 ran, 203 passed, 1 failed**. No full-suite
run (owner: keep suite runs minimal).

**One thing is broken on main.** test/compute-only.test.mjs "the scheduler never places plan or reflect work on a worker"
inserts its project with `perpetual=0` and then waits for its reflect task to finish. Since #383 (Keep improving off = no
reflection at all) RUNNABLE never claims a reflect task of an off project, so the test waits 60 s and times out. #388's
worker-cap fix has landed, so this is the only red test in the unheld set. Queued first (task 1 below).

**A root cause behind three recent failures.** #328, #376 and #359 all died on git ref locks, not on their work:
`cannot lock ref 'refs/remotes/origin/main': is at … but expected …` during a worker's setup fetch, and GitHub's
`[remote rejected] main -> main (cannot lock ref 'refs/heads/main')` on the head's push of main. The worker serialises its
own cache operations (`withCache`), but the agent's own `git fetch` in a sibling worktree shares the cache's refs, and two
pushes to main (head merge + the owner's Mac) race on GitHub's side. Both are transient and safe to retry, and nothing
retries them. The shared retry helper lands now in taskrun.mjs (the one module both worker.mjs and orchestrator.mjs may
import); the two `git()` helpers adopt it once those files are free (Later).

**What is held.** Queued and running work holds orchestrator.mjs, parallel.mjs, cap.mjs, server.mjs, version.mjs, cluster.mjs,
cluster-git.mjs, worker.mjs, browser-live.mjs, browser-view.mjs, browser.mjs, bin/browser-mcp.mjs, browser-task.mjs,
agents.mjs, files.mjs, gate.mjs, extensions.mjs, mcp-probe.mjs, public/app.js|app.css|index.html|sound.js|files.*|browser.*|
ext.js|stats.js, test/fixtures/fake-mcp.mjs and AUDIT.md. Every open UI-REVIEW row lives in app.js/app.css, so this top-up
again takes the owner's direction (features on what exists, plus loopholes and error handling with tests) in files nobody holds:
- **Git retries** (above): taskrun.mjs `transientGit` + `retryGit`.
- **health.mjs:** a model list kept after a failed rediscovery (#366's `failedAt`) still reads as healthy; `healthRow` should
  report "models: last discovery failed <date>, showing the list from <date>" (a re-run of #376, which failed in setup).
- **Pushes you never get (AUDIT #54):** server.mjs `notify` drops a different message that shares a tag within the minute
  (the memory warning right after "not signed in" is lost for good) and has no global cap (15 failed tasks = 15 buzzes).
  A `createNotifier` in push.mjs keeps the newest dropped message per tag and sends it when the minute is up, doesn't spend
  the minute on a failed send, and caps bursts at 5 per 10 min with one "N more need you" summary. server.mjs wires it later.
- **Gate for http connectors (AUDIT #69's lasting fix):** gate-proxy.mjs only spawns a stdio upstream, which is why #393
  must withhold http connectors from gated runs. Speaking streamable http upstream (POST JSON-RPC, `Mcp-Session-Id`, JSON or
  SSE answers) lets extensions.mjs route them through the proxy instead.

Goals 1–8, 10 and 11 of the brief are met. Goal 9 is the owner's active push (#378, #384, #344's rules; #301 cancelled in
favour of CPU-only gating). Goal 12 has its foundations and waits for the owner. Goal 6's push notifications are
backend-complete; the phone side is #312.

Open ledgers: AUDIT round 6 has 9 open findings (#38, #39, #42, #44, #47, #48, #52 need held files; #49 and #41 fixed by #317,
#50 is #363). Round 7: #61, #65, #66 fixed but unmarked (ledger held); #54–#57, #59, #60, #63, #67 open. Round 8 (#397, after
#388/#389/#393) opens #68–#70. UI-REVIEW round 2 has 11 open rows, all in app.js/app.css.

Things the owner should know:
- **`autoRestart` is still off** (kv `parallel_settings`). AUDIT #43's preflight is live, so it is safe to turn on in gear →
  Settings. Until a restart the live server does not run anything merged since 2026-09-27, including #406's build number.
- **A task the owner cancels records no reason**, so the new Stats "Why tasks failed" card (#392) says "cancelled" without a
  why until orchestrator.mjs `cancel` writes one (Later).
- **Three failed tasks were infrastructure, not work:** #328, #359 and #376 (git ref locks, above). #328's work landed as
  #369; #376's is task 3 below; #359's (pin the head's IP, keep Macs awake, a one-word status) still needs worker.mjs.
- **AUDIT #38 (high) stays open by design:** approvals are a log and a speed bump until AGENTIC.md's run sandbox.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

## Next (queued by #405)
1. **Fix the failing test:** test/compute-only.test.mjs's scheduler test creates its project with `perpetual=1` and a far
   `next_reflect_at`, so its own reflect task runs locally as before and the scheduler adds no reflection of its own.
2. taskrun.mjs: `transientGit(text)` recognises ref-lock, index.lock, remote-rejected-lock and network errors; `retryGit(fn,
   {attempts, backoffMs})` retries only those with backoff. New test/git-retry.test.mjs.
3. health.mjs: a kept-but-stale model list (`failedAt`) is an error with both dates, in `healthRow` and bin/agent-health.mjs.
4. push.mjs AUDIT #54: `createNotifier(send, opts)` coalesces per tag (newest dropped message sent when the minute ends), a
   failed send doesn't spend the minute, and a global budget of 5 per 10 min then one summary.
5. gate-proxy.mjs: `cfg.upstream.url` selects a streamable-http upstream (POST JSON-RPC with `Mcp-Session-Id`, JSON or SSE
   responses, notifications posted, 202 accepted); stdio unchanged. New fixture test/fixtures/fake-http-mcp.mjs.
Queued by earlier reflections: #390, #397; the owner's #364, #363, #382, #385, #386, #398–#400, #407.

## Later
Once the integrators and the owner's #378/#384/#399/#400/#401–#404/#406/#407 free orchestrator.mjs, server.mjs, worker.mjs,
extensions.mjs and app.js:
- Wire task 2: worker.mjs `git()` and orchestrator.mjs `git()`/`mergeTask`'s push go through `retryGit` (closes the #328/#359/
  #376 failure class); a new AUDIT item for the unretried lock race.
- Wire task 4: server.mjs `notify` = `createNotifier(push.send)`, and Settings shows `push.disabled` and a device's last error
  (AUDIT #53's open half).
- Wire task 5: extensions.mjs `mcpFor` routes http/sse connectors with outbound tools through the proxy (upstream `{url,
  headers}`) instead of withholding them (#393's stop-gap); the AUDIT #69 ledger note.
- Wire #370/#371: `finishWork` fails a task with "Done-when check was refused: …" and accepts a 127 only when `checkUnavailable`
  says so (AUDIT #65/#66 closed); then the AUDIT ledger for #61, #65, #66.
- Wire the MCP probe (#394): `POST /api/ext/mcp/:name/check` and a "Check" button in Skills & tools.
- Owner cancel writes a reason into `tasks.result` ("cancelled by you" / the note), so Stats and the digest can say why.
- #359's remaining parts in worker.mjs: pin the head's resolved IP with a DNS fallback, `caffeinate` while jobs run, and
  `node worker.mjs status --word` printing one of online/asleep/offline/pairing.
- CLUSTER.md "Scheduling" and "Local cap" still describe headroom placement and the head's RAM-cap arithmetic; rewrite them once
  #344 and #384 settle the rules.
- AUDIT #58's other half: screen-prompt failures go through `fail()`; a reply without a marker shows as "Unclear".
- AUDIT #57: a resumed screen prompt gets "Continue; check the page for what is already done"; a lost one fails with its
  steps so far. AUDIT #56: refuse a screen prompt for a node `place` could never pick (409).
- AUDIT #60: back off rapid top-up after a reflection that added nothing ready; never top up past an `awaiting_review`
  checkpoint; a stale 5 h reading counts as cautious.
- AUDIT #55: generic push bodies; badge only for active projects. AUDIT #59: `GET /api/browser/tasks` without steps plus
  `GET /api/browser/tasks/:id`. AUDIT #63: delete screen-prompt workspaces on done/failed/cancelled and sweep `browser-tasks/`
  at boot. AUDIT #67: the shared Claude token only in Claude runs' env; back up a worker's own Codex auth.json.
- Wire the digest (#340): `GET /api/orch/digest?since=`; a "Since you were away" group at the top of the Queue.
- Wire task changes (#330): `GET /api/orch/task/:id/changes`; a "Changes" section in the task drawer.
- Settings "Send a test notification" (`POST /api/push/test`).
- UI-REVIEW #25 "Needs you" group at the top of the Queue; #24 machine names instead of node ids in cards and approvals.
- Retry a failed task from the drawer with an optional note.
- Goal 9 follow-ups: an emergency guard on workers (pause the newest job near OOM, as the controller does).
- UI-REVIEW #18's second half: a "Phone size" toggle that re-emulates the viewport at the stage size.
- AUDIT #39, #44, #47, #48, #42 (cluster half), #52: as listed in AUDIT.md.
- UI-REVIEW #28's app.css half (Files switch, Max tasks) and #30: the off switch track gets its own ≥ 3:1 token and 51×31.
- UI-REVIEW round 2, remaining: #19 and round 1 #9 fallback editor as a sheet (owner's decision); #21 swipe-to-dismiss;
  #26 Machines as one sheet; #29 an in-app confirm sheet (also for ext.js's skill delete and "Discard your changes?");
  #31 focus containment; #32 a visible Copy on the install command; #34 one Deny button; #35 verbs in the Actions log.
- login.html's subtitle says "Sign in to Claude Code on <host>"; the product is agent-orch (goal 4). One-line change with
  the other login polish when someone is in public/login.*.
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
