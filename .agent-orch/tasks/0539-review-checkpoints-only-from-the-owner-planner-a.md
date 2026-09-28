# Task #539: Review checkpoints only from the owner: planner and reflection never add them

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 19:47  
- files: orchestrator.mjs, test/checkpoint*.test.mjs

## Prompt

The owner's rule (now in .agent-orch/CONTEXT.md): NEVER queue review checkpoints automatically. Only the owner adds them via '+ Review break'. Changes in orchestrator.mjs: 1) Remove the 'Review breaks' instruction from the planner/TASKS_FORMAT prompt (~line 187) and any reflection-prompt text that suggests adding a checkpoint after risky or direction-setting tasks (the #201 rule is revoked). 2) The tasks-block parser (~lines 575-579) IGNORES kind:'review' entries from planner and reflection output (drop them with a logged note 'review checkpoints are owner-only'), so a model can't add one even if it tries. 3) Check every other auto-insert path (post-failure follow-ups, integrator flows, request-changes re-arming an existing checkpoint is fine since the owner created it) and make sure none creates a new checkpoint without an owner action; the only creator is the owner's POST /api/orch/tasks/:id/checkpoint. 4) Tests: a planner block containing a kind:'review' task queues the work tasks but no review task; the reflection prompt text contains no checkpoint instruction; the owner's endpoint still creates one. Run only the touched test files.

## Done when

`node --test test/checkpoint*.test.mjs` passes (planner/reflection review entries dropped, owner endpoint still works), and `! grep -n 'Review breaks' orchestrator.mjs`
