# Task #46: Planner-busy guard so plan tasks and chat planner turns never overlap (AUDIT #5)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:55  
- starts after: #45

## Prompt

Fix AUDIT #5 in .agent-orch/AUDIT.md. In orchestrator.mjs, `planTurn` (chat, ~1207) adds project.id to `planningProjects`, but plan-kind tasks (execute path ~1338 calling `plannerRun`) neither check nor set it. Two `--resume <chat_session_id>` runs can therefore overlap on one session. (1) Make plan-kind task execution mark the project in `planningProjects` for its duration (finally removes it). (2) When the scheduler picks a task, skip plan-kind tasks whose project is in planningProjects (leave them queued, so they run once the chat turn ends). (3) In `planTurn`, if the project is already planning because of a plan task, don't start a second plannerRun. Instead, save the text to the `messages` table (as the blocked branch does), so the running or next plan task answers it, and emit a notice to the chat. Make sure a plan task picks up messages that arrive while it runs, or that another plan task is queued for them. (4) In plannerRun's rate-limited branch (~1252), reuse the 'already queued or running plan task' check used in planTurn's blocked branch, so duplicate 'Answer owner's message' tasks don't pile up; factor it into a small helper used in both places. Add a focused test if the code can be exercised without a real SDK (e.g. the dedupe helper); otherwise keep `npm test` green. Mark AUDIT #5 Fixed with a one-line note, and update .agent-orch/CONTEXT.md's orchestrator notes with a sentence about the guard. Never touch the running server.

## Done when

`npm test` passes and `grep -A14 '### 5\.' .agent-orch/AUDIT.md | grep -q Fixed`
