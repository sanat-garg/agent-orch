# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 10:55 (reflect #298)._ Main is clean at 62b462b, nothing is queued or unmerged, and the live server was restarted at
10:39 so it now runs main (the approvals table, verifier `|` fix, retention GC, restart preflight and phone CSS are all live).
Reflection #297 never queued its five steps: it ended its turn waiting on a background `npm run test:full` and emitted no
task block, so #286's blockless-reflection retry produced this reflection. Lesson recorded in this file: run the suite first
and emit the block in the same message. The full suite was run again for #298: see the note at the end of this section.

**BRIEF goal 9 was rewritten by the owner during this reflection (rapid development mode: the MacBook runs 10 tasks, this VPS
4, owner caps are the limit, memory only an emergency guard).** The code does not meet it yet: `parallel.mjs taskSlots` allows
1 or 2 controller slots and grants the second only above 2.5 GB free; `setParallelSettings` rejects `parallelTasks` above 2;
and worker placement (`freeWorkers`/`nodeCap`) clips an owner-set `maxSlots` by spare memory and a 3 GB Mac floor. Steps 1–2
below fix that first. Goals 1–8, 10 and 11 of the brief are met; goal 12 has its foundations (browser tasks, the approval gate, AGENTIC.md) and waits for the
owner. The owner's direction for this reflection is **new features for users, built on what exists**. The biggest gap in the
mobile-first goal is that the app is silent when it is closed: approvals (which auto-deny at a deadline), chat permission
prompts, failed tasks and review checkpoints only reach the owner as a toast and a sound while the page is open. Web Push
works in iOS home-screen apps since 16.4 and needs no dependency (VAPID and RFC 8291 with node:crypto), so steps 1–3 below add
it (steps 3–5). The "Needs you" Queue group (UI-REVIEW #25) and a "Changes" section in the task drawer are the next two
feature steps, listed first under Later.

Open ledgers: AUDIT round 6 has 11 open findings (#38, #39, #41, #42, #44, #46–#50, #52: one high, three medium, seven low);
UI-REVIEW round 2 has 16 open rows (18, 19, 21, 23–35). Both are listed under Later; the #297 plan (AUDIT #39 halves, #44,
#47+#48, UI-REVIEW #30+#28) is the next thing to queue once the feature steps land.

Things the owner should know:
- **`autoRestart` is still off** (kv `parallel_settings` = `{"controllerWork":true}`). AUDIT #43's preflight is live now, so it
  is safe to turn on in gear → Settings.
- **Push notifications (steps 1–3) only work in the home-screen app on iPhone**, not in Safari tabs, and need Caddy's HTTPS
  (already in place). The switch lives in gear → Settings once step 2 lands.
- **AUDIT #38 (high) stays open by design:** approvals are a log and a speed bump until AGENTIC.md's run sandbox. Keep
  connectors with outbound tools out of the MCP list until then.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

Full suite (`npm run test:full`) for #298 on 62b462b: 516 tests, 516 passed, 0 failed (exit 0).

## Next (queued by #298)
1. Goal 9, controller: `parallelTasks` 1–16 (default 4), `taskSlots` returns the owner's number unless MemAvailable is under
   the emergency floor; the Settings sheet gets a "This server runs up to N" select and loses the "needs more free memory" hint.
2. Goal 9, workers: an owner-set node cap is the limit; placement skips the headroom and spare-memory clipping for capped nodes
   and keeps only the worker's own `node worker.mjs limit` and an emergency floor.
3. Web Push backend with no new dependency: `push.mjs` (VAPID keys and subscriptions in data/, aes128gcm encryption, `send`),
   plus `/api/push/key` and `/api/push/subscribe`.
4. Service worker and Settings switch: `public/sw.js` shows notifications and opens the task on tap; `#task-<id>` deep link;
   app badge from the pending-approval count.
5. Send pushes for what needs the owner: approval requests, chat permission prompts, failed tasks, review checkpoints and
   planner "waiting" events, tagged per task so repeats replace.

## Later
Next feature steps (queue first):
- UI-REVIEW #25: a "Needs you" group at the top of the Queue (pending approvals, review checkpoints, paused tasks, chat
  permission prompts) with a count the app badge reuses.
- Task drawer "Changes": `GET /api/orch/task/:id/changes` returns the task's commit stat and patch (capped) and the drawer
  renders it with collapsible files.
- Goal 9 follow-ups: an emergency guard on workers (pause the newest job near OOM, as the controller does), and the planner
  prompt asking for more, smaller file-disjoint tasks with integrators so every slot has work.
Reflection #297's plan, in order (queue next):
- AUDIT #39, worker half: a worker job whose synced MCP list has a connector with `outbound` tools opens the gate like a
  browser job does. Controller half: planner and reflection runs never receive an ungated connector with `outbound` tools.
- AUDIT #44: the restart drain waits only for local runs and, for a run held on an approval, waits a capped time and names it.
- AUDIT #47 and #48: `revoke()` clears `tasks.run_on` with a task event; a remote task whose worker ran no check fails
  verification instead of merging as "check unavailable".
- UI-REVIEW #30 and #28: the off switch track gets its own ≥ 3:1 token and 51×31 on touch; dark mode gets `--seg-on`.
AUDIT round 6, remaining, in value order (one finding per task, two if tiny):
- #42 per-connection frame budget, `cpu` clipped to 256 entries, version sha only from `hello`, a cached gzipped extension
  bundle, a cap on pending approvals per run.
- #49 no "Always" for arbitrary-code tools; #46 keep `auth.json.prev`, reject a future `last_refresh`; #50 `bv_open`'s `url`
  only when this socket may drive; #52 workers refuse an `http://` head unless loopback or `--insecure`; #41 block
  loopback/private origins in the Playwright MCP and enable the Chromium sandbox where the kernel allows.
- #38 is the run sandbox (AGENTIC.md phase 2). Owner's call on when.
UI-REVIEW round 2, remaining:
- #18 live browser view on a phone: pinch/pan, double-tap 1×/fit, phone-size emulation.
- #19 and round 1 #9: the fallback editor as an edge-to-edge sheet on phones (owner's decision).
- #21 swipe-to-dismiss for `.modal.sheet`; #26 Machines as a sheet with Add machine inside it.
- #24 node names instead of ids on cards, drawer and browser lines.
- #29 an in-app confirm sheet replacing the 10 `window.confirm`/`prompt` calls; #23 heatmap labels ≥ 11px; #27 Stats tabs and
  range on one row; #31 focus containment in sheets; #32 a visible Copy on the install command; #33 back to Settings from
  Skills & tools; #34 one Deny button; #35 verbs instead of tool ids in the Actions log.
More feature ideas for users (after the steps above):
- Chat search across conversations (`GET /api/convos?q=` over titles and message text) with a search field in the sidebar.
- A "Today" digest at the top of the Queue: tasks finished since the owner last opened the app, with their one-line results.
- Retry a failed task from the drawer with an optional note (a fresh task that cites the failure), instead of re-planning.
- Voice dictation in the composer on iOS via the Web Speech API when available.
Other:
- AGENTIC.md phase 1 (files-only `workspace` project type, statement ingestion, reconciliation report) when the owner asks
  for computer work again; connectors (Gmail etc.) only on the owner's say-so.
- Run `bin/orch-e2e.mjs` against the restarted controller once the Mac undrains, then revisit cluster max-parallel (goal 9)
  with measured per-agent footprints (#209/#228 were cancelled; local branch `agent-orch/task-209` holds partial work).
- Owner branches `claude/mode-menu`, `claude/processes-panel`, `claude/topbar-safe-area`, `claude/heuristic-visvesvaraya-d78c0d`
  and `agent-orch/task-197/-199/-209` are far behind main: ask before landing or deleting.
- Split public/app.js (~7k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
- Reflections: run `npm run test:full` to a log file first and emit the task block in the final message; never end the turn
  waiting on a background job (#297 lost its plan that way).
