# Task #503: Integrate #499: Browser tab: show only the current task, no history

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-09-28 18:56  
- files: public/browser.js, public/browser.css, test/ui-browser-view*.test.mjs

## Prompt

Task #499 ("Browser tab: show only the current task, no history") finished in its own git worktree, but its branch `agent-orch/task-499` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #499's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #499's instructions were:

Simplify the Browser tab (public/browser.js, browser.css): remove the 'Earlier prompts' list (from #354) and any past/finished browser task history, including old step lists and results from previous prompts. The panel under the prompt box shows ONLY the task currently running on this profile (its live steps, approval cards, Stop), or nothing once it finishes: keep the just-finished task's final result visible until the owner types a new prompt or 30 s pass, then clear it. Don't fetch history on load (GET /api/browser/tasks is only used for the running task; filter to status running, or add ?active=1 if the endpoint supports it, else filter client-side). Remove the dead CSS and code. Tests: with a finished task in the mocked response, nothing historical renders; a running task shows its steps; after it finishes, the result clears on a new prompt. Run only the touched test files.

## Done when

`node --test test/ui-browser-view*.test.mjs` passes with no Earlier prompts/history rendered and only the running task shown

## Result — done (check passed) (2026-09-28 18:57)

AGENT-ORCH-STATUS: done — CONTEXT.md conflict resolved; browser-view tests pass
