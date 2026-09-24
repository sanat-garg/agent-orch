# Task #22: Rename project memory dir .ao2 to .agent-orch with auto-migration

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-24 23:37  
- starts after: #21

## Prompt

Rename the per-project memory directory from .ao2/ to .agent-orch/ everywhere: orchestrator.mjs (ao2Dir helper ~line 950, PLANNER_TOOLS Write/Edit/MultiEdit globs, every prompt string mentioning .ao2/), server.mjs (~lines 811-861 memory prompt), github.mjs (any ignore/commit rules), README.md and code comments. Migration: wherever project memory is initialised or read (initMemory/readMemory), if <project>/.ao2 exists and <project>/.agent-orch doesn't, rename it; use `git mv` semantics if the project is a git repo (a plain fs.renameSync is fine; the next commit picks it up). Also rename the .ao2 variable names (ao2Dir etc.) to agentOrchDir or memDir. In THIS repo, run `git mv .ao2 .agent-orch`. Add a node:test case in test/ that creates a temp project with .ao2/BRIEF.md and asserts it ends up at .agent-orch/BRIEF.md after init. Note: the running server keeps using .ao2 until the owner restarts it, and its migration then handles the move. The new code must therefore work whether or not .ao2 is still present.

## Done when

`grep -rn '\.ao2' --include=*.mjs --include=*.js --include=*.md . | grep -v node_modules | grep -v test/` prints only the migration code, `.agent-orch/BRIEF.md` exists in the repo, and `npm test` passes
