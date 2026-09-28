# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 04:50 (reflect #262)._ The cluster push (BRIEF goal 11) is live: the owner's MacBook Air is paired and ran
tasks #249, #250 and #258. Goal 12's first pieces landed today (browser capability, approval gate with audit log, live
browser view, worker extension sync), everything is merged to main, and the full suite passes on main. Nothing is
queued or unmerged except the two owner snapshot branches noted under Later. The owner cancelled the Gmail connector
(#259), so connectors wait for the owner; AGENTIC.md's rollout starts with a files-only workspace anyway.

Real problems found:
- The Mac worker is **auto-drained for low disk** (1.4 GB free at 03:54; its disk is a few GB free of 245 GB). Free space
  recovered to 3–4 GB, but nothing undrains a node when the cause clears, so the Mac sits idle until the owner clicks.
  The worker also never prunes its `deps/<lockfile-hash>` node_modules copies or its npm cache, so every lockfile change
  costs another few hundred MB on an already full disk.
- The Done-when verifier still treats a `|` inside a quoted grep pattern as a pipe (the `unquoted` fix from the
  abandoned `agent-orch/task-244` branch never landed), so clean "prints nothing" checks fail.
- The live server (started 03:40) predates the last three merges; the owner should "Restart when idle" for the approval
  gate and extension sync to go live.
- Mobile HIG findings #3 (task titles truncated) and #5 (touch targets under 44pt) remain; #4 is superseded (the
  orchestrator settings popover became the gear's Settings sheet).
- AUDIT #35 (prototype agent names / chat-mode validation) is the last open audit item; #251 was cancelled unstarted.

## Next (queued)
1. Land the verifier fix: `taskrun.mjs unquoted` + its test/verify.test.mjs cases.
2. Worker disk hygiene: prune unreferenced `deps/` caches and cap the npm cache in `sweepLeftovers`, with a test.
3. Auto-undrain a node once the disk that drained it has stayed above the threshold with margin, with a notice.
4. UI-REVIEW #3: task-card titles wrap to two lines on phones; tags move under the title.
5. UI-REVIEW #5: 44pt touch targets for chips, small buttons and icon buttons under `(pointer: coarse)`.

## Later
- AUDIT #35 (`Object.hasOwn` agent checks, chat-mode validation) as a background fix.
- UI-REVIEW #6–#17 (contrast, text size, sheets, switches, PWA chrome), one row per task, marked fixed in UI-REVIEW.md.
- AGENTIC.md phase 1 (files-only workspace project type, statement ingestion) when the owner asks for computer work
  again; connectors (Gmail etc.) only on the owner's say-so.
- Once the Mac has room: run `bin/orch-e2e.mjs` against it, then revisit cluster max-parallel (goal 9) with measured
  per-agent footprints (#209/#228 were cancelled, not done).
- Owner branches `claude/mode-menu`, `claude/processes-panel` are 2026-09-27 snapshots far behind main; ask the owner
  whether they are wanted before landing them. Delete `agent-orch/task-244`/`-247`/`-187`/`-197`/`-199`/`-209` once
  confirmed dead.
- Split public/app.js (~7k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
