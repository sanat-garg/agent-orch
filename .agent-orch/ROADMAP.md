# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 05:55 (reflect #279)._ All four steps from the last reflection landed (#275–#278). Main is clean, nothing
is queued or unmerged, every module passes `node --check`, the six UI test files pass together (36/36), and the live
journal since 03:40 has no errors. Goals 1–11 of the brief are met; goal 12 has its foundations and waits for the
owner. AUDIT.md has no open items; UI-REVIEW.md has one open row (#9, an owner decision).

Things the owner should know:
- **The live server (started 03:40) still runs code from before the last 19 merges.** The `approvals` table, the
  verifier `|` fix, disk auto-undrain and all the phone CSS are on disk but not live (CSS loads on refresh; server code
  needs "Restart when idle"). Nothing in the product restarts on its own: that is the gap this round closes (opt-in).
- The MacBook Air worker is drained: 1.4 GB free on its repo disk (was 2.3 GB at the last reflection) and falling. The
  worker's cache pruning (#264) only helps once the worker self-updates; it lifts itself at 3 GB. Free space by hand.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

Real problems found this round:
- **Nothing brings merged server code live.** `commitsSinceBoot` only feeds the banner. When the owner is away, fixes
  the orchestrator itself made (e.g. the verifier fix) stay dead for hours, and AUDIT-style "stale running code" confusion
  recurs. An opt-in "restart automatically once idle after code changes" setting reuses the existing drain path.
- **`removeWorktree` leaves a directory behind.** Seven `../.agent-orch-worktrees/agent-orch-task-*` dirs (216–219, 229,
  231, 232) remain after `git worktree remove` succeeded, each holding only `node_modules/.cache`. The `rmSync` fallback
  only runs when the remove fails, and nothing sweeps orphans git no longer lists.
- Dead local task branches: `agent-orch/task-187` (Copilot, removed), `-244` and `-247` (landed via #254/#263) clutter
  `git branch` and confuse integrators. `-197`, `-199`, `-209` hold unlanded partial work; ask the owner before deleting.
- kv keeps rows for removed agents (`planner_session:2:antigravity`, `unknown_limit_streak:copilot`, …): harmless, cosmetic.

## Next (queued)
1. Auto-restart setting (backend): kv `restart_settings.auto`, exposed with the other orchestrator settings; when on and a
   commit since boot touched server-side code, run the same drain-and-exit path as POST /api/restart-when-idle.
2. Auto-restart setting (UI): a switch in the gear's Settings sheet and banner wording that says a restart is automatic.
3. `removeWorktree` always deletes the directory; `ensureWorktree`'s prune sweeps orphan task dirs git no longer lists.
4. Delete the dead local branches `agent-orch/task-187`, `-244`, `-247` after confirming their content is on main.

## Later
- Media and run-log retention: `<DATA>/media` grows ~20 MB/day (455 files, 67 MB, all from the last 3 days) and
  `data/orchestrator/runs` holds every run log forever (306 files, 20 MB). Fine for months on this disk; add a GC of
  unreferenced media and old run logs before it matters.
- UI-REVIEW #9: the fallback editor as an edge-to-edge sheet on phones (today it is a compact popover like the other
  composer menus; decide with the owner whether a sheet is wanted).
- AGENTIC.md phase 1 (files-only `workspace` project type, statement ingestion, reconciliation report) when the owner
  asks for computer work again; connectors (Gmail etc.) only on the owner's say-so.
- Once the Mac has room: run `bin/orch-e2e.mjs` against it, then revisit cluster max-parallel (goal 9) with measured
  per-agent footprints (#209/#228 were cancelled, not done; local branch `agent-orch/task-209` holds the partial work).
- Owner branches `claude/mode-menu`, `claude/processes-panel`, `claude/topbar-safe-area`,
  `claude/heuristic-visvesvaraya-d78c0d` are snapshots far behind main: ask the owner before landing or deleting them.
- Drop stale kv rows for removed agents in a one-time migration.
- Split public/app.js (~7k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
