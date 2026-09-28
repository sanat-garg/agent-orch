# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 05:45 (reflect #274)._ All five steps from the last reflection landed (#269–#273): README computer-work
docs, AUDIT #35, UI-REVIEW #6, #10, #15 and #16. Main is clean, nothing is queued or unmerged, every module passes
`node --check`, and the live journal since 03:40 has no errors. Goals 1–11 of the brief are met; goal 12 has its
foundations and waits for the owner to ask for phase 1 or connectors. AUDIT.md has no open items.

Things the owner should know:
- **The live server (started 03:40) predates the last 15 merges.** The `approvals` table doesn't exist in the live DB
  yet, the disk auto-undrain isn't running, and the Mac still shows "draining" with a stale reason (its disk is at
  2.3 GB free; it lifts itself at 3 GB once the new code runs). "Restart when idle" brings all of it live.
- The MacBook Air's swap sits at 55% with 4 slots configured: watch memory once it runs two browser tasks at once.
- Task #96 ("Answer owner's message", project soham) waits because that project is paused. By design.

Real problems found this round:
- **Sidebar project drag is dead.** public/app.js declares `function dragMove` twice at top level (the project-list
  drag at ~line 600 and the queue drag at ~line 6518). Classic scripts hoist the later one, so lifting a project card
  never moves it (Alt+↑/↓ still works). No test catches duplicate top-level names across the public/*.js scripts.
- **Integrated tasks leave their branch on GitHub.** After an integrator merges, `mergeTask`'s cleanup deletes only the
  integrator's own `agent-orch/task-<id>` from origin, never the integrated task's; `origin/agent-orch/task-258` is
  such a leftover.
- UI-REVIEW rows 7 (phone text 14–15px, metadata 11–11.5px), 9 (fallback editor is a 300px popover), 13 and 14 are
  still open. Rows 4 and 8 are effectively done (settings moved to the gear sheet; the bar is one row and hides while
  typing) and row 13's priority `select` no longer exists, but the table doesn't say so.

## Next (queued)
1. Fix the `dragMove` name clash and add a static test that top-level function names are unique across public/*.js.
2. Delete the integrated task's origin branch after an integrator merge; remove the stale `agent-orch/task-258`.
3. UI-REVIEW #7: 16px body text and ≥12px metadata on phones, guarded by a static test.
4. UI-REVIEW #13 + #14: sidebar footer in the body font at 44pt on touch, centred `.btn.small`; mark rows 4, 8 and 13
   with their real status.

## Later
- UI-REVIEW #9: the fallback editor as an edge-to-edge sheet on phones (today it is a compact popover like the other
  composer menus; decide with the owner whether a sheet is wanted).
- AGENTIC.md phase 1 (files-only `workspace` project type, statement ingestion, reconciliation report) when the owner
  asks for computer work again; connectors (Gmail etc.) only on the owner's say-so.
- Once the Mac has room: run `bin/orch-e2e.mjs` against it, then revisit cluster max-parallel (goal 9) with measured
  per-agent footprints (#209/#228 were cancelled, not done; local branch `agent-orch/task-209` holds the partial work).
- Dead local task branches `agent-orch/task-187` (Copilot, removed), `-197`, `-199`, `-244` (landed via #263/#254),
  `-247` can be deleted; `-209` holds partial adaptive-slots work. Owner branches `claude/mode-menu`,
  `claude/processes-panel`, `claude/topbar-safe-area`, `claude/heuristic-visvesvaraya-d78c0d` are snapshots far behind
  main: ask the owner before landing or deleting them.
- Split public/app.js (~7k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
