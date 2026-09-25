# Task #77: Restart-when-idle waits for busy chat and planner turns, and can be cancelled (AUDIT #24)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 09:09

## Prompt

Fix AUDIT.md item #24 (read the full finding in .agent-orch/AUDIT.md). In /home/ubuntu/agent-orch/server.mjs, around lines 1135-1150, the restart-when-idle path currently exits as soon as orch.drain() resolves. Make it also wait until no chat work is busy: no Claude chat runtime with rt.busy, no entry in agentTurns, and no chat planner turn in planning/planningProjects. Re-check whenever a chat result or turn ends, or poll every few seconds as a simpler option. While draining, don't start new chat planner turns: planTurn should check the draining flag and post a short notice that the reply will come after the restart, or queue the turn. Also add POST /api/restart-when-idle with body {cancel:true}. It should clear restartPending and the orchestrator's draining flag (add an undrain()/cancelDrain() method in orchestrator.mjs if needed) so task claiming resumes, then broadcast status. Keep the endpoint behind the same auth and same-origin checks as the existing one. Put the 'is chat idle' check in a small exported helper so it can be tested. Add tests in test/drain.test.mjs: the exit waits while a chat turn is busy, and cancel resumes claiming. Mark #24 Fixed in AUDIT.md.

## Done when

`npm test` passes, including new drain tests for busy-chat waiting and drain cancellation, and AUDIT.md marks #24 Fixed.
