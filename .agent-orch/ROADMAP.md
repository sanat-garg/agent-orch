# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 01:10 (reflect #246)._ The cluster push (BRIEF goal 11) is code-complete on the head with tests, but the
live cluster still has zero workers: the owner's Mac install fails under macOS bash 3.2. The fix is finished on local
branch `agent-orch/task-244` (installer here-docs, bash 3.2 test binary + tests, and the verifier's quoted-pipe grep
bug in taskrun.mjs); its tests pass in a worktree, and its only conflict with main is .agent-orch/CONTEXT.md. Landing
it is the one urgent item.

Two more finished pieces sit on unmerged branches: skills/subagents/MCP sync to remote workers
(`claude/heuristic-visvesvaraya-d78c0d`, 6 commits behind main, conflicts in cluster.mjs/cluster-protocol.mjs/docs)
and UI-REVIEW #1 (`claude/topbar-safe-area`, one trivial test conflict). AUDIT #35 is the last open audit item; mobile
HIG findings #2–#5 remain. CONTEXT.md was cut from 16.8 kB to 12 kB this pass.

## Next (queued)
1. Land `agent-orch/task-244` (urgent: unblocks the Mac worker; restart when idle afterwards so the verifier fix is live).
2. Land the worker extension sync from `claude/heuristic-visvesvaraya-d78c0d` (rebase on main, resolve cluster conflicts).
3. Land UI-REVIEW #1 from `claude/topbar-safe-area`.
4. UI-REVIEW #2: keyboard-aware composer via `visualViewport`; hide the orch bar while typing.
5. AUDIT #35: `Object.hasOwn` agent checks and chat mode validation.

## Later
- UI-REVIEW #3 (task-card titles wrap on phones), #4 (orchestrator settings as a bottom sheet), #5 (44pt targets),
  then #6–#8. Mark each fixed in UI-REVIEW.md.
- Once a Mac is paired: run `bin/orch-e2e.mjs` against it, then revisit cluster max-parallel (goal 9) with measured
  per-agent footprints (#209/#228 were cancelled, not done).
- Owner branches `claude/mode-menu`, `claude/processes-panel` are unmerged and conflict with main; ask the owner whether
  they are wanted before landing them.
- Split public/app.js (~6.9k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- AUDIT #34's lasting fix is a hostname under a domain the owner controls (owner's decision).
