# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 08:45 (reflect #291)._ Main is clean at 858b1af, nothing is queued or unmerged, and every root and bin module
passes `node --check`. All five steps queued by #285 landed (blockless-reflection retry, AUDIT round 6, UI-REVIEW round 2,
retention GC, the kv migration): 83 reflection-queued tasks passed in the last week, none failed. Goals 1–11 of the brief
are met; goal 12 has its foundations and waits for the owner.

The two reviews just landed are now the backlog. AUDIT round 6 lists 16 findings (#37–#52): two high, six medium, eight
low, none fixed yet. UI-REVIEW round 2 lists rows 18–35, none fixed yet. This reflection queues the fixes with the best
value per hour; the rest are listed under Later in the reviews' own suggested order.

Things the owner should know:
- **The live server (started 03:40) still runs df72699, now 30+ commits behind main.** Press "Restart when idle" once.
  That brings live the `approvals` table, the verifier `|` fix, the phone CSS server-side pieces, retention GC, the kv
  migration, the auto-restart setting (off by default; gear → Settings) and the disk auto-undrain.
- **The MacBook Air stays "draining" only because the controller is stale** (the recorded reason says 1.4 GB free; the
  live controller predates #265, so it never lifts the drain). A restart lifts it after three healthy frames.
- **Auto-restart is a foot-gun until AUDIT #43 is fixed:** it exits into whatever HEAD is, and a boot crash trips
  systemd's start limit, taking the web terminal down with the app. Step 2 below fixes that before the owner turns it on.
- **AUDIT #37 (high) is a one-line bug with real effect:** on the controller, task runs get neither the approval gate nor
  the browser, so an owner connector's outbound tools would run unapproved. Step 1 below.
- **AUDIT #38 (high) has no cheap fix:** the gate and the agent share one Unix user and the agent has a shell, so a run can
  answer its own approvals. The real fix is AGENTIC.md's run sandbox (phase 2). Until then, treat approvals as a log and a
  speed bump, not a hard stop, and keep connectors with outbound tools out of the MCP list.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

## Next (queued by #291)
1. AUDIT #37: `setMcpSource((agent, run) => ext.mcpRun(agent, run))` in server.mjs, with a regression check.
2. AUDIT #43: the restart drain preflights the new HEAD (`node --check` on every module, then a throwaway boot on a spare
   port with `CW_NO_ORCHESTRATOR=1` that must answer `/auth/check`) before `process.exit(0)`; a failure keeps the app up,
   logs it and skips that HEAD. README recommends `StartLimitIntervalSec=0` in the unit.
3. AUDIT #40: the browser classifier treats Enter / Ctrl+Enter / Meta+Enter key presses and `browser_type` with `submit`
   as outbound, adds Post, Reply, Submit, Buy, Order, Checkout, Tweet and "Save & send" to the defaults, and treats
   nameless buttons as outbound.
4. AUDIT #45 and #51: the hub refuses the socket of a disabled node and never shares credentials or extensions with it;
   the worker's gate reads `shots/<id>` only for `MEDIA_ID_RE` ids.
5. UI-REVIEW #20 and #22: one `(pointer: coarse)` CSS pass: 16px for every field that still zooms iOS Safari, and 44pt
   for the Stats/Skills/Files tabs, range pickers, Max tasks, search and URL fields, drawer summaries and the queue card's
   Pause and review flag.

## Later
AUDIT round 6, in value order (one finding per task, two if tiny):
- #39 gate every run that gets a server with `outbound` tools (worker code jobs, planner, reflection), or leave connectors
  out of those runs.
- #44 the restart drain doesn't wait on remote jobs (they are re-adopted after boot); approval-held runs get a capped wait.
- #42 per-connection frame budget, `cpu` clipped to 256 entries, version sha only from `hello`, cached gzipped bundle,
  a cap on pending approvals per run.
- #47 `revoke()` clears `tasks.run_on` for that node; #48 a remote task with no `job.check` fails verification instead of
  merging as "check unavailable"; #49 no "Always" for arbitrary-code tools, connector keys include recipient-like args;
  #46 keep `auth.json.prev`, reject a future `last_refresh`, adopt only a login that decodes to the same account;
  #50 `bv_open`'s `url` only when this socket may drive; #52 workers refuse an `http://` head unless loopback or `--insecure`;
  #41 block loopback/private origins in the Playwright MCP and enable the Chromium sandbox where the kernel allows.
- #38 is the run sandbox (AGENTIC.md phase 2): a separate Unix user or container per run, the gate dir and profiles
  outside its reach, no DevTools port exposed. Owner's call on when.
UI-REVIEW round 2, in the review's suggested order after step 5:
- #18 live browser view on a phone: pinch/pan on the canvas, double-tap 1×/fit, an optional phone-size emulation.
- #19 and round 1 #9: the fallback editor as an edge-to-edge sheet on phones (owner's decision).
- #21 swipe-to-dismiss for `.modal.sheet`; #26 Machines as a sheet with Add machine inside it.
- #30 and #28: off-switch track ≥ 3:1 and 51×31 on touch; a `--seg-on` token for the selected segment in dark mode.
- #24 node names instead of ids on cards, drawer and browser lines; #25 a "Needs you" group at the top of the Queue.
- #23 heatmap labels ≥ 11px and only recent days on phones; #27 Stats tabs and range on one row; #29 an in-app confirm
  sheet instead of `window.confirm`/`prompt`; #31 focus containment in sheets; #32 a visible Copy on the install command;
  #33 back to Settings from Skills & tools; #34 one Deny button; #35 verbs instead of tool ids in the Actions log.
Other:
- AGENTIC.md phase 1 (files-only `workspace` project type, statement ingestion, reconciliation report) when the owner
  asks for computer work again; connectors (Gmail etc.) only on the owner's say-so.
- Once the controller is restarted and the Mac undrains: run `bin/orch-e2e.mjs` against it, then revisit cluster
  max-parallel (goal 9) with measured per-agent footprints (#209/#228 were cancelled; local branch `agent-orch/task-209`
  holds partial work).
- Owner branches `claude/mode-menu`, `claude/processes-panel`, `claude/topbar-safe-area`,
  `claude/heuristic-visvesvaraya-d78c0d` and `agent-orch/task-197/-199/-209` are far behind main: ask before landing or deleting.
- Split public/app.js (~7k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
