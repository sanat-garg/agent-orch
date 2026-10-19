# Task #2260: Integrate #2247: Leaving Orchestrator Mode stops new tasks only; the queue keeps running

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-10-19 14:22  
- files: orchestrator.mjs, server.mjs, public/app.js, test/orch-mode-intake*.test.mjs

## Prompt

Task #2247 ("Leaving Orchestrator Mode stops new tasks only; the queue keeps running") finished in its own git worktree, but its branch `agent-orch/task-2247` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/tasks/2247-leaving-orchestrator-mode-stops-new-tasks-only-t.md). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #2247's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #2247's instructions were:

Today, switching a chat out of Orchestrator Mode pauses the whole project: orchestrator.mjs setConvoMode (~line 4781) sets projects.status='paused' and calls pauseProject(), which aborts running tasks, and server.mjs (~line 3101) emits 'Orchestrator paused. Switch back to Orchestrator Mode to resume its work.' The owner wants: leaving Orchestrator Mode must NOT pause queued or running tasks, only stop ADDING new ones. Change it: 1) Add a per-project flag projects.intake (1 = new tasks may be added, the default; 0 = closed), with a migration. Leaving Orchestrator Mode sets intake=0 and keeps status 'active' (no pauseProject, no aborts); entering it sets intake=1 (and status active as today). 2) With intake=0: no reflection or rapid top-up is spawned for the project (gate every reflect/top-up path on intake, alongside perpetual), and no planner turns run from the chat (the chat is in a normal mode anyway). Owner actions still work: Retry, Assign, Do next, reordering, checkpoints, and adding tasks explicitly through the UI. Queued and running tasks are claimed and finish normally, including integrators. 3) The notice becomes 'Orchestrator Mode off: queued tasks keep running; no new tasks will be added. Switch back to plan new work.' The orchestrator bar shows 'Running X · Queue Y' plus a small 'no new tasks' tag while intake=0. The Pause button stays the explicit way to stop work (unchanged). 4) Projects already paused by this old behaviour: on migration, set paused projects whose chat isn't in Orchestrator Mode back to active with intake=0, so their queues resume (log each one). 5) Tests: switching out of orchestrator keeps a running task running and a queued one gets claimed; no reflect task is created while intake=0; switching back sets intake=1 and reflection can run; the Pause button still pauses. Run only the touched test files.

## Done when

`node --test test/orch-mode-intake*.test.mjs` passes (running/queued continue after leaving the mode, no reflection while intake=0, re-entering re-enables, Pause still pauses)

## Result — done (check passed) (2026-10-19 14:25)

AGENT-ORCH-STATUS: done — conflict resolved; intake tests pass on merged main
