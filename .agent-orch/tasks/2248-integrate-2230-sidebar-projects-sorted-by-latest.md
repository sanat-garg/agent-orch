# Task #2248: Integrate #2230: Sidebar projects sorted by latest activity; remove priority drag order

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-10-19 14:16  
- files: public/app.js, public/app.css, server.mjs, orchestrator.mjs, test/ui-sidebar-activity*.test.mjs

## Prompt

Task #2230 ("Sidebar projects sorted by latest activity; remove priority drag order") finished in its own git worktree, but its branch `agent-orch/task-2230` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #2230's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #2230's instructions were:

Change the sidebar project list (public/app.js, app.css; plus the project list API in server.mjs/orchestrator.mjs for an activity timestamp). 1) Remove the drag-to-reorder for priority from #510 (the pointer drag, the Alt+↑/↓ reorder, the 'Drag to set priority' hint and drop indicators) and its client code and CSS. Keep the POST /api/orch/projects/reorder endpoint only if something else uses it, otherwise remove it. Don't change projects.priority values or the scheduler's use of them. 2) Sort projects by LAST ACTIVITY, descending: the max of the latest chat message, task created/started/finished, merge to main, and planner/reflection activity for that project. Expose it as `lastActivityAt` (epoch ms) in the project list payload (compute it with one SQL query over tasks/events/messages, not N+1 queries) and update it live over the WebSocket so a project jumps to the top when something happens in it. Ties break by name. 3) Each project row shows a subtle relative time ('2m', '3h', 'Mon') on the right, updating every minute. The currently open project stays highlighted wherever it lands. Tests: three projects with different activity times render newest first; a new task event on the oldest moves it to the top; no drag handlers or 'Drag to set priority' text remain; lastActivityAt is in the payload. Run only the touched test files.

## Done when

`node --test test/ui-sidebar-activity*.test.mjs` passes (newest-first order, live re-sort on activity, relative time shown, no drag handlers), and `! grep -n 'Drag to set priority' public/app.js`

## Result — done (check passed) (2026-10-19 14:24)

AGENT-ORCH-STATUS: done — merge conflicts resolved; sidebar-activity, ui-static and digest tests pass
