# Task #165: AUDIT round 4: worktrees, parallel scheduling, delegation and new adapters

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 09:57  
- files: .agent-orch/AUDIT.md

## Prompt

Review, don't fix. Find real bugs in the code added since AUDIT round 3 (2026-09-25): worktrees.mjs and orchestrator.mjs mergeTask/startIntegration/cleanupWorktrees/serialGit (worktree merges land on the LIVE checkout, so focus on data loss, a dirty main tree, lost commits, stuck needs_integration tasks, restart mid-merge), parallel.mjs + runnable/tick/claimNext/spreadAssign (file overlap, multi-deps, slot caps, cancel cascades), delegate.mjs + fallback snapshots, and the opencode/kiro/copilot adapters in agents.mjs (process cleanup, limit detection, API-key/billing env leakage: the brief requires subscription logins only). For each finding, verify it by reading code and, where cheap, a small repro with node on a temp dir (never touch port 3000 or data/). Append a '## Round 4 (2026-09-26, task #<id>)' section to .agent-orch/AUDIT.md in the existing format (numbered from 27, severity, What / Repro or reasoning / Fix). Only list issues you are confident are real; say so if a module looks clean. Do not modify source files.

## Done when

`grep -q 'Round 4' .agent-orch/AUDIT.md`

## Result — done (check passed) (2026-09-26 10:03)

AGENT-ORCH-STATUS: done — AUDIT.md Round 4 lists six verified findings (#27–32)
