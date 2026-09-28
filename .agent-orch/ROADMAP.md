# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 06:10 (reflect #284)._ All four steps from the last reflection landed (#280–#283). Main is clean, nothing is
queued or unmerged, every module passes `node --check`, and the live journal since 05:00 has no errors. A partial
`npm run test:full` (stopped at the nine-minute cap this single core allows) passed TESTCOUNT subtests with no failure; every
recent commit's own change-aware run passed. Goals 1–11 of the brief are met; goal 12 has its foundations and waits for
the owner. AUDIT.md has no open items; UI-REVIEW.md has one open row (#9, an owner decision).

Things the owner should know:
- **The live server (started 03:40) still runs code from before the last 23 merges.** Press "Restart when idle" once. That
  brings live: the `approvals` table, the verifier `|` fix, the phone CSS server-side pieces, and the auto-restart setting
  (off by default; turn it on in the gear's Settings sheet if you want future merges to restart the app by themselves).
- **The disk auto-undrain (#265) is not live, and it cost real work today.** The MacBook Air's repo disk went from 2.2 GB
  to 3.8 GB free at 05:52 (the worker self-updated and pruned its caches) and stayed above 3 GB for eight minutes, which
  should have lifted its drain. The stale controller never saw it; the disk has since fallen back to about 2.2 GB.
- **Something on the MacBook Air is hammering it while no job runs:** since 06:02 all eight cores sit at 100%, load
  is 15–21, swap use jumped from 53% to 74% and free disk dropped 1.6 GB in ten minutes. That is not the worker
  (`running: []`, not held awake). Check Activity Monitor; the worker will not take jobs until the disk holds ≥ 3 GB.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

Gaps found this round (none broken, all hardening):
- **No security audit covers the surfaces added since round 5 (2026-09-26):** the cluster WSS protocol and pairing,
  approvals and the audit log, browser live view, extension sync to workers, the restart and machines APIs. Round 6 is due.
- **The mobile HIG review (round 1, #178) only saw 13 screens.** The Settings sheet as it is now, Machines, Stats,
  Extensions, Files, Approvals and the live browser view were added or reworked since and were never reviewed.
- Retention: `<DATA>/media` grows ~20 MB/day (461 files, 70 MB) and `data/orchestrator/runs` keeps every run log
  forever (311 files, 20 MB). Deleted chats leave their images behind. Fine for months on 35 GB, but a GC is cheap now.
- kv keeps rows for removed agents (`planner_session:2:antigravity`, `unknown_limit_streak:copilot`, …). Cosmetic.

## Next (queued)
1. AUDIT round 6: cluster protocol/pairing, approvals + audit log, browser live view, extension sync, restart/machines
   APIs. Findings only, into AUDIT.md; fixes are queued from them next reflection.
2. UI-REVIEW round 2: HIG review of the screens round 1 never saw (Settings sheet, Machines, Stats, Extensions, Files,
   Approvals, live browser view) at 390 px. Findings only, into UI-REVIEW.md.
3. Retention GC: delete run logs of tasks finished more than 30 days ago and media files no run log or chat log references,
   at boot and daily.
4. One-time kv migration that drops rows for removed agents (antigravity, opencode, kiro, copilot).

## Later
- Fix tasks from AUDIT round 6 and UI-REVIEW round 2, sized one finding (or two tiny ones) per task.
- UI-REVIEW #9: the fallback editor as an edge-to-edge sheet on phones (owner's decision).
- AGENTIC.md phase 1 (files-only `workspace` project type, statement ingestion, reconciliation report) when the owner
  asks for computer work again; connectors (Gmail etc.) only on the owner's say-so.
- Once the Mac has room and is quiet: run `bin/orch-e2e.mjs` against it, then revisit cluster max-parallel (goal 9)
  with measured per-agent footprints (#209/#228 were cancelled; local branch `agent-orch/task-209` holds partial work).
- Owner branches `claude/mode-menu`, `claude/processes-panel`, `claude/topbar-safe-area`,
  `claude/heuristic-visvesvaraya-d78c0d` and `agent-orch/task-197/-199/-209` are far behind main: ask before landing or deleting.
- Split public/app.js (~7k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
