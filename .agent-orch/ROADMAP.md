# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 05:20 (reflect #268)._ Everything queued by the last reflection landed: the verifier `|` fix (#263), worker disk
hygiene (#264), disk auto-undrain (#265) and UI-REVIEW #3 and #5 (#266, #267). Main is clean, nothing is queued or
unmerged, and `npm run test:full` on main passes 486/486.
Goals 1–11 of the brief are met; goal 12 has its foundations (browser capability, approval gate + audit log, live
browser view, worker extension sync) and waits for the owner to ask for phase 1 (files-only workspace) or connectors.

Things the owner should know:
- **The live server (started 03:40) predates the last nine merges.** The `approvals` table doesn't exist in the live DB
  yet, and the disk auto-undrain isn't running, so the Mac worker still shows "draining" with a stale reason. "Restart
  when idle" from the banner brings all of it live.
- The MacBook Air has 2.4 GB free; it undrains itself (after the restart) once 3 GB are free. Its swap is at 55% with
  4 slots configured: watch for memory pressure once it runs two browser tasks at once.
- Task #96 ("Answer owner's message", project soham) has sat queued since 09-25 because that project is paused. By
  design; resuming the project runs it.

Real gaps found:
- README.md says nothing about the browser capability, the approval gate, the audit log, the live browser view or worker
  extension sync (BRIEF goal 1: the README explains setup).
- AUDIT #35 (prototype names like `constructor` pass the `AGENTS[x]` checks; chat modes unvalidated) is the last open
  audit item; #251 was cancelled before it started.
- UI-REVIEW rows 11, 12 and 17 are already fixed in the code (theme-color per scheme + apple-touch-icon, switch-style
  settings toggles, swipe-to-dismiss toasts) but still read as open. Rows 6 (contrast), 7 (text size), 9, 10, 13–16
  are genuinely open; login.html still has a single dark `theme-color`.

## Next (queued)
1. README: document computer work (browser capability, approval gate + audit log, live browser view, extension sync).
2. AUDIT #35: `Object.hasOwn(AGENTS, x)` everywhere an agent name comes from a client; validate modes against `MODES`.
3. UI-REVIEW #6: light-theme `--faint` and filled-button contrast ≥ 4.5:1, with a static contrast test; mark rows
   6, 11, 12, 17 fixed and add the light `theme-color` to login.html.
4. UI-REVIEW #10: Connections opens as a bottom sheet on phones, no focus ring on touch, status lines wrap.
5. UI-REVIEW #15 + #16: inline code pills clone across line breaks, tool summary rows 44pt, time cells in the system
   font with tabular numerals.

## Later
- UI-REVIEW #7 (phone body text 16–17px, metadata ≥ 12px), #9 (fallback editor as an edge-to-edge sheet), #13 (drawer
  priority select styled like the chips; drawer as a large-detent sheet), #14 (sidebar footer font and phone summary row).
- AGENTIC.md phase 1 (files-only `workspace` project type, statement ingestion, reconciliation report) when the owner
  asks for computer work again; connectors (Gmail etc.) only on the owner's say-so.
- Worker inventory should carry the worker's commit so the Machines view can show "outdated" without guessing.
- Once the Mac has room: run `bin/orch-e2e.mjs` against it, then revisit cluster max-parallel (goal 9) with measured
  per-agent footprints (#209/#228 were cancelled, not done; branch `agent-orch/task-209` holds the partial work).
- Dead task branches `agent-orch/task-187` (Copilot, removed), `-197`, `-199`, `-244` (landed via #263/#254), `-247`
  can be deleted; `-209` holds partial adaptive-slots work. Owner branches `claude/mode-menu`, `claude/processes-panel`,
  `claude/topbar-safe-area` are 09-27 snapshots far behind main: ask the owner before landing or deleting them.
- Split public/app.js (~7k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
