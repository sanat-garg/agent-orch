# Task #521: No progress bar on waiting tasks

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 19:24  
- files: public/app.js, public/app.css, test/ui-phase-strip*.test.mjs

## Prompt

Task cards (the compact .tl-bar from #507, rendered in taskCard in public/app.js, also on the Machines star cards and in the queue lists) currently show a progress strip even for tasks that haven't started. Hide it entirely (don't render the element, not just give it zero width) for tasks that are waiting: status queued, waiting on a prerequisite, waiting on a usage limit or reset, held by a review checkpoint, or awaiting approval before start, i.e. any task with no started run. Show the bar only once a run has started (running), and keep it for finished tasks (done or failed) showing their final timeline. A task that's paused mid-run keeps its bar, frozen. The drawer's Timeline section follows the same rule (hidden until the first run starts). Tests: a queued task card has no .tl-bar; one waiting on a prerequisite or a limit has none; a running task has one; a done task keeps one; a paused one keeps a frozen one. Run only the touched test files.

## Done when

`node --test test/ui-phase-strip*.test.mjs` passes with no .tl-bar on queued/waiting cards and bars on running, done and paused ones

## Result — done (check passed) (2026-09-28 19:25)

AGENT-ORCH-STATUS: done — Timeline bars now hidden on waiting tasks, shown once a run starts
