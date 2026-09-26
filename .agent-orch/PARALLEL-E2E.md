# Parallel e2e (task #166)

Live check that two file-disjoint work tasks run concurrently, each in its own worktree, and both merge.

## Command
    node bin/orch-e2e.mjs --parallel --agent claude --model haiku --keep

(`haiku` = Haiku 4.5, the cheapest model in the Claude catalog. The script boots server.mjs on a random free port
with a temp `CW_DATA_DIR`, a scratch git project and a local bare `origin`; never port 3000 or the live DB.
Task #1 owns `src/a.mjs` + `test/a.test.mjs`, task #2 owns `src/b.mjs` + `test/b.test.mjs`, no `after`.)

## Result (2026-09-26, exit 0, ~50 s)
    parallel e2e (claude/haiku)
      #1 done  09:59:01 → 09:59:39  worktree: /tmp/orch-e2e-claude-BkF19E/.agent-orch-worktrees/project-task-1  commit: 1aa9f6d
      #2 done  09:59:01 → 09:59:34  worktree: /tmp/orch-e2e-claude-BkF19E/.agent-orch-worktrees/project-task-2  commit: 0c9c78d
    overlap: yes (task intervals; agent runs overlap: yes; both seen running at once: yes)
    own worktrees under ../.agent-orch-worktrees: yes
    both done: yes; both on main: yes; pushed to origin: yes; npm test on main: pass
    leftovers: worktrees 0, agent-orch/task-* branches 0 (clean)

Scratch main == bare origin main:
`1aa9f6d agent-orch #1`, `0c9c78d agent-orch #2`, `4cf76eb agent-orch: uncommitted changes before #1`, `34536a6 scratch`.
The live DB gained no scratch project.

## Bugs found
None in the scheduler or merge path. Observation only: the first worktree task commits the files `initProject`
seeds into the main tree (`.agent-orch/…`) as "uncommitted changes before #1"; expected behaviour, not a bug.
