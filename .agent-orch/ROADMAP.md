# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 08:15 (reflect #285)._ Main is clean at 69c7a6a, nothing is queued or unmerged, every root and bin module passes
`node --check`, and the static UI and compute-only suites pass. The events log has no errors since 06:00. The previous
reflection's partial `npm run test:full` (stopped at its nine-minute cap) had 121 passing subtests and no failure. Goals
1–11 of the brief are met; goal 12 has its foundations and waits for the owner. AUDIT.md has no open items; UI-REVIEW.md
has one open row (#9, an owner decision).

**What went wrong since the last reflection: reflection #284 queued nothing.** It started the full test suite in the
background, ended its turn with "I'll emit the task block once the run reports", and the session closed there. The
orchestrator read the missing block as "found nothing valuable", bumped the empty streak and slept for 120 minutes, so
the four steps it had planned were never queued and two hours of the 5h window went unused. Two lessons: a reflection
must finish inline (never wait on a background job), and the orchestrator should tell "no block at all" apart from "an
explicit empty list" and retry soon instead of backing off. The latter is step 1 below.

Things the owner should know (unchanged, still true):
- **The live server (started 03:40) runs df72699, 26 commits behind main.** Press "Restart when idle" once. That brings
  live the `approvals` table, the verifier `|` fix, the phone CSS server-side pieces, the auto-restart setting (off by
  default; in the gear's Settings sheet) and the disk auto-undrain.
- **The MacBook Air is stuck draining only because the controller is stale.** Its repo disk now has 5.5 GB free (the drain
  reason says 1.4 GB), well above the 3 GB undrain line; the live controller predates #265 so it never lifts the drain.
  A restart lifts it after three healthy frames. The Mac's load has settled (about 2.2, swap 66%).
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

Gaps (none broken, all hardening; the same four as last time plus the reflection fix):
- **No security audit covers the surfaces added since round 5 (2026-09-26):** the cluster WSS protocol and pairing,
  approvals and the audit log, browser live view, extension sync to workers, the restart and machines APIs.
- **The mobile HIG review (round 1, #178) saw 13 screens.** The Settings sheet as it is now, Machines, Stats, Extensions,
  Files, Approvals and the live browser view were added or reworked since and were never reviewed.
- Retention: `data/media` holds 458 files (68 MB, content-hashed PNGs) and `data/orchestrator/runs` keeps all 312 run
  logs (20 MB) forever. Deleted chats leave their images behind. A GC is cheap now.
- kv keeps four rows for removed agents (`planner_session:2:antigravity`, `unknown_limit_streak:antigravity`,
  `unknown_limit_streak:antigravity:3p`, `unknown_limit_streak:copilot`). Cosmetic.

## Next (queued by #285)
1. finishReflection: a run with no task block (or an unparsable one) logs a warning, leaves the empty streak alone and
   schedules the next reflection in five minutes; only an explicit empty list counts as "nothing valuable".
2. AUDIT round 6: cluster protocol/pairing, approvals + audit log, browser live view, extension sync, restart/machines
   APIs. Findings only, into AUDIT.md; fixes are queued from them next reflection.
3. UI-REVIEW round 2: HIG review of the screens round 1 never saw (Settings sheet, Machines, Stats, Extensions, Files,
   Approvals, live browser view) at 390 px. Findings only, into UI-REVIEW.md.
4. Retention GC: run logs of tasks finished more than 30 days ago and media files older than 7 days that no chat log or
   run log references, at boot and daily.
5. One-time kv migration that drops rows for removed agents (antigravity, opencode, kiro, copilot).

## Later
- Fix tasks from AUDIT round 6 and UI-REVIEW round 2, sized one finding (or two tiny ones) per task.
- UI-REVIEW #9: the fallback editor as an edge-to-edge sheet on phones (owner's decision).
- AGENTIC.md phase 1 (files-only `workspace` project type, statement ingestion, reconciliation report) when the owner
  asks for computer work again; connectors (Gmail etc.) only on the owner's say-so.
- Once the controller is restarted and the Mac undrains: run `bin/orch-e2e.mjs` against it, then revisit cluster
  max-parallel (goal 9) with measured per-agent footprints (#209/#228 were cancelled; local branch `agent-orch/task-209`
  holds partial work).
- Owner branches `claude/mode-menu`, `claude/processes-panel`, `claude/topbar-safe-area`,
  `claude/heuristic-visvesvaraya-d78c0d` and `agent-orch/task-197/-199/-209` are far behind main: ask before landing or deleting.
- Split public/app.js (~7k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
