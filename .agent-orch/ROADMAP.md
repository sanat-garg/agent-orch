# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-28 00:50 (reflect #245)._ The cluster push (BRIEF goal 11) is code-complete on the head: pairing, worker daemon,
placement, failover, health, power policy, compute-only lock, local cap, Machines view and diagram all landed with
tests (427 passing on main at #231). But the live cluster still has zero workers: the owner's first Mac install
failed because macOS's bash 3.2 re-parses `declare -f` output differently from bash 5. Task #244 fixed that (installer
here-docs, a bash 3.2 test binary and test, plus the verifier's own grep-pipe bug in taskrun.mjs) and its work sits
complete on the local branch `agent-orch/task-244`, but the task was marked failed by the very verifier bug it fixes
(a `|` inside the quoted grep pattern). Landing that branch is the one urgent item: the owner is blocked on it.

Beyond that, two finished-but-unmerged pieces of work exist on local branches (UI-REVIEW #1 top bar on
`claude/topbar-safe-area`), AUDIT #35 (prototype agent names) is still open, and the mobile HIG review's high
findings #2–#5 are untouched. Remote workers still don't receive the owner's skills, subagents or MCP servers.

## Next (queued)
1. Land the bash 3.2 installer fix from `agent-orch/task-244` (urgent; unblocks the Mac worker).
2. Land UI-REVIEW #1 (top bar height includes the safe-area inset) from `claude/topbar-safe-area`.
3. UI-REVIEW #2: keyboard-aware composer via `visualViewport`; hide the orch bar while typing.
4. AUDIT #35: `Object.hasOwn` agent checks and mode validation.
5. UI-REVIEW #3: task-card titles wrap instead of truncating on phones; short model chip.

## Later
- Ship skills, subagents and MCP servers to remote workers (job.start carries the extension set; the worker writes them
  into its own home before the run). Needed before any real work goes to the Mac.
- Once a Mac is paired: run `bin/orch-e2e.mjs` against it, then revisit cluster max-parallel (goal 9) with measured
  per-agent footprints (#209/#228 were cancelled, not done).
- UI-REVIEW #4 (orchestrator settings as a bottom sheet), #5 (44pt touch targets), then #6–#8 (contrast, type size,
  bottom chrome). Mark each one fixed in UI-REVIEW.md.
- Owner branches `claude/mode-menu`, `claude/processes-panel`, `claude/heuristic-*` are unmerged; ask the owner whether
  they are wanted before landing them.
- Split public/app.js (~6.9k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- The lasting fix for AUDIT #34 is a hostname under a domain the owner controls (owner's decision).
