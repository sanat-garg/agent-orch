# Task #487: Integrate #479: Task cards: a coloured phase progress strip along the bottom edge

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-09-28 18:14  
- files: public/app.js, public/app.css, test/ui-phase-strip*.test.mjs

## Prompt

Task #479 ("Task cards: a coloured phase progress strip along the bottom edge") finished in its own git worktree, but its branch `agent-orch/task-479` conflicts with `main`, which changed meanwhile (conflicting files: public/app.css). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #479's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #479's instructions were:

Show a task's progression on its card without opening the drawer. Along the bottom edge of every task card (taskCard in public/app.js: the queue, chat cards and the Machines lists), inside the card just above its lower border, render a thin (3-4px) segmented strip built from the same phase timeline the drawer's 'Timeline' uses (the job phases from #229: queued → cloning/fetching → installing → running agent → checking → committing → pushing → merging → done). Completed phases are filled, the current one pulses gently (no pulse under prefers-reduced-motion), and future ones are faint. Give each phase its own colour from a theme-consistent palette (define CSS vars, legible in light and dark): e.g. queued grey, preparing (clone/install) blue, running agent orange (the accent), checking purple, pushing/merging teal, done green, failed red, waiting-on-limit amber. Add a small legend in the Queue modal header, and a tooltip on the strip ('Checking · 2m 10s'). It updates live from the WebSocket. Tests: a running-agent task shows the orange current segment; a failed task shows red; the legend exists. Run only the touched test files.

## Done when

`node --test test/ui-phase-strip*.test.mjs` passes (current phase colour, failed red, legend present)

## Result — done (check passed) (2026-09-28 18:15)

AGENT-ORCH-STATUS: done — app.css conflict resolved, keeping phase and pace colours; tests pass
