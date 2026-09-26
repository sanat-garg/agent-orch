# Task #202: Pause a running task, or hand it to another agent mid-run

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 14:32  
- files: orchestrator.mjs, server.mjs, agents.mjs, test/pause-handoff*.test.mjs

## Prompt

Add controls to a running task's drawer and card. 1) Pause: stop the agent session gracefully (abort, keep the worktree and session id), and mark it 'paused', which the scheduler skips. Resume continues the same session on the same agent (resume id) in the same worktree. 2) Hand off / Delegate while running: pick another agent/model (fallback editor picker). The orchestrator stops the current session, keeps the worktree with its uncommitted changes, and starts the new agent in the same worktree with a handoff prompt: the original task prompt and done_when, the previous agent's last assistant messages and a summary of its tool calls (from the run log), `git status` and `git diff --stat` of the worktree, and the instruction to continue from the current state without redoing work. Record delegated_from and the reason 'moved by owner', and it shows in modelStatus. 3) Endpoints: POST /api/orch/tasks/:id/pause, POST /api/orch/tasks/:id/resume, POST /api/orch/tasks/:id/handoff {agent, account?, model}. Handle the races (the task finishes while pausing, or a limit hits mid-handoff). Tests with stub adapters: pause keeps the worktree and resume reuses the session; handoff starts the new agent in the same worktree with the diff context in its prompt.

## Done when

`npm test` passes with pause/resume and running-handoff tests, and the running task drawer has Pause and 'Hand off…' buttons
