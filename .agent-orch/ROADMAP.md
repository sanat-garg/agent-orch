# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 09:20 (reflect #297)._ Main is clean at df0eb82, nothing is queued or unmerged, every root and bin module passes
`node --check`, and the full suite (`npm run test:full`, 103 files) was run for this reflection: see the note at the end of
this section for the result. All five steps queued by #291 landed (AUDIT #37, #43, #40, #45+#51, UI-REVIEW #20+#22), so 88
reflection-queued tasks passed in the last week with none failed. Goals 1–11 of the brief are met; goal 12 has its
foundations (browser tasks, the approval gate, AGENTIC.md) and waits for the owner. CONTEXT.md was cut from 8.0 KB to 6.5 KB
in this reflection: only cross-module rules, conventions, decisions and gotchas remain.

The backlog is the two review ledgers. AUDIT round 6 has 11 open findings (#38, #39, #41, #42, #44, #46–#50, #52): one high
(#38, needs the run sandbox), three medium, seven low. UI-REVIEW round 2 has 16 open rows (18, 19, 21, 23–35).

Things the owner should know:
- **The live server (started 03:40) still runs df72699, 38 commits behind main.** Press "Restart when idle" once. That brings
  live the `approvals` table, the verifier `|` fix, retention GC, the kv migration, the restart preflight, the disk
  auto-undrain, and every phone CSS fix. `autoRestart` is off (kv `parallel_settings` = `{"controllerWork":true}`); now that
  AUDIT #43's preflight is on main it is safe to turn on in gear → Settings after that first restart.
- **The MacBook Air shows as paired and enabled** (node `n_97aedd112345`). Whether it is still draining is decided by the live
  controller, which predates the auto-undrain: the restart above settles it.
- **AUDIT #38 (high) stays open by design:** approvals are a log and a speed bump until AGENTIC.md's run sandbox. Keep
  connectors with outbound tools out of the MCP list until then. Steps 1–2 below close the cheaper half of the same hole
  (#39): today a connector reaches worker code jobs, planner turns and reflections with no gate at all.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

## Next (queued by #297)
1. AUDIT #39, worker half: a worker job whose synced MCP list has a connector with `outbound` tools opens the gate like a
   browser job does, so those calls are held and audited on the head.
2. AUDIT #39, controller half: planner and reflection runs never receive an ungated connector with `outbound` tools (gated
   where the run has a task and run id, dropped otherwise).
3. AUDIT #44: the restart drain waits only for local runs (remote jobs are re-adopted after boot) and, for a local run held
   on an approval, waits a capped time and tells the owner which approval the restart waits on.
4. AUDIT #47 and #48: `revoke()` clears `tasks.run_on` for that node with a task event; a remote task whose worker ran no
   check fails verification instead of merging as "check unavailable".
5. UI-REVIEW #30 and #28: the off switch track gets its own ≥ 3:1 token and 51×31 on touch; dark mode gets `--seg-on` for
   the selected segment with a 600-weight label; test/ui-contrast.test.mjs asserts both.

## Later
AUDIT round 6, in value order (one finding per task, two if tiny):
- #42 per-connection frame budget, `cpu` clipped to 256 entries, version sha only from `hello`, a cached gzipped extension
  bundle, a cap on pending approvals per run. Two tasks: budget + clip first, then bundle cache + approvals cap.
- #49 no "Always" for arbitrary-code tools, connector keys include recipient-like args; #46 keep `auth.json.prev`, reject a
  future `last_refresh`, adopt only a login that decodes to the same account; #50 `bv_open`'s `url` only when this socket
  may drive; #52 workers refuse an `http://` head unless loopback or `--insecure`; #41 block loopback/private origins in
  the Playwright MCP and enable the Chromium sandbox where the kernel allows.
- #38 is the run sandbox (AGENTIC.md phase 2): a separate Unix user or container per run, the gate dir and profiles outside
  its reach, no DevTools port exposed. Owner's call on when.
UI-REVIEW round 2, in the review's suggested order:
- #18 live browser view on a phone: pinch/pan on the canvas, double-tap 1×/fit, an optional phone-size emulation.
- #19 and round 1 #9: the fallback editor as an edge-to-edge sheet on phones (owner's decision).
- #21 swipe-to-dismiss for `.modal.sheet` (one shared pointer handler that clicks the sheet's `[data-close]`); #26 Machines
  as a sheet with Add machine inside it.
- #24 node names instead of ids on cards, drawer and browser lines; #25 a "Needs you" group at the top of the Queue.
- #29 an in-app confirm sheet replacing the 10 `window.confirm`/`prompt` calls in app.js, browser.js and ext.js; #23 heatmap
  labels ≥ 11px and only recent days on phones; #27 Stats tabs and range on one row; #31 focus containment in sheets; #32 a
  visible Copy on the install command; #33 back to Settings from Skills & tools; #34 one Deny button; #35 verbs instead of
  tool ids in the Actions log.
Other:
- AGENTIC.md phase 1 (files-only `workspace` project type, statement ingestion, reconciliation report) when the owner asks
  for computer work again; connectors (Gmail etc.) only on the owner's say-so.
- Once the controller is restarted and the Mac undrains: run `bin/orch-e2e.mjs` against it, then revisit cluster
  max-parallel (goal 9) with measured per-agent footprints (#209/#228 were cancelled; local branch `agent-orch/task-209`
  holds partial work).
- Owner branches `claude/mode-menu`, `claude/processes-panel`, `claude/topbar-safe-area`, `claude/heuristic-visvesvaraya-d78c0d`
  and `agent-orch/task-197/-199/-209` are far behind main: ask before landing or deleting.
- Split public/app.js (~7k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
