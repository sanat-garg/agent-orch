# Task #306: Send pushes for what needs the owner: approvals, chat permission prompts, failed tasks, review checkpoints and waiting events

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-28 10:55  
- starts after: #304  
- files: orchestrator.mjs, server.mjs, test/push-events.test.mjs, .agent-orch/CONTEXT.md

## Prompt

Wire push.mjs (`push.send({title, body, tag, url, badge})`, created in server.mjs) to the events that need the owner while the app is closed. (1) orchestrator.mjs: accept a `notify` function in createOrchestrator's options (like `usageLog`; a no-op default so tests and worker code are unaffected) and call it at: a new approval (next to `broadcast({ t: 'oapproval', approval: a, kind })` when kind is 'new': title 'Approval needed', body `#<id> <task title>: <action>`, tag `approval-<taskId>`, url `/#task-<taskId>`); a task entering 'failed' or 'needs_integration' (in the place `updateTask` sets those statuses on run end: title 'Task failed' / 'Needs integration', tag `task-<id>`); a review checkpoint entering 'awaiting_review' (title 'Review needed'); and `logEvent` calls with level 'warn' whose message starts with 'waiting:' (sign-in needed, memory low; tag 'waiting'). Every call passes `badge` = the number of pending approvals plus awaiting checkpoints (`pendingApprovals().length + count of tasks with status awaiting_review`). (2) server.mjs: pass `notify: (n) => push.send(n)` into createOrchestrator, and in the chat permission prompt (`canUseTool` → `broadcast(convo.id, { t: 'perm', ...req })`) send a push 'Claude needs permission' with body `<convo title>: <tool>`, tag `perm-<cid>`, url `/#<cid>`, only if no answer arrives within 15 s (a timer cleared by perm_reply, so an owner who is watching gets no duplicate). Rate-limit in push.mjs' caller or here: at most one push per tag per 60 s. (3) Tests: test/push-events.test.mjs using createOrchestrator with a fake `query` and a recording `notify` stub (copy test/approval-gate-run.test.mjs or test/checkpoint.test.mjs setup): a run that fails yields one notify call with tag `task-<id>`; inserting a checkpoint and finishing its prerequisite yields 'Review needed'; a gate approval request yields 'Approval needed' with a badge of 1. Document the event list in a comment above the notify hook and one line in CONTEXT.md's Architecture list. Run `npm test -- test/push-events.test.mjs test/checkpoint.test.mjs test/approval-gate-run.test.mjs`.

## Done when

`npm test -- test/push-events.test.mjs test/checkpoint.test.mjs test/approval-gate-run.test.mjs` passes and `grep -n 'notify' orchestrator.mjs` prints a line

## Result — done (check passed) (2026-09-28 11:27)

AGENT-ORCH-STATUS: done — Owner pushes wired for approvals, failures, reviews, waits, permissions
