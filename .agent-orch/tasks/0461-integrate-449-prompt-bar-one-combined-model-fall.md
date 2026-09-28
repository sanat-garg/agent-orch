# Task #461: Integrate #449: Prompt bar: one combined model + fallbacks control

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-09-28 15:08  
- files: public/app.js, public/app.css, public/index.html, test/ui-model-fallbacks*.test.mjs, test/ui-static.test.mjs

## Prompt

Task #449 ("Prompt bar: one combined model + fallbacks control") finished in its own git worktree, but its branch `agent-orch/task-449` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #449's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #449's instructions were:

In the chat composer, the agent/model selector and the separate 'Fallbacks · N' button (the stripped-down fallback editor from #153/#140, renderFallbackEditor, saving via PUT /api/convos/:id/fallbacks) sit side by side. Merge them into ONE control (public/app.js, app.css, index.html; the backend and APIs are unchanged): 1) The pill shows the primary model's display name plus, when fallbacks exist, an arrow and the first fallback ('Opus 5 → Astra'; '+N' only if there's more than one). Its width fits its content within the existing max-width/ellipsis rules from #124, with the full text in the title/aria-label ('Model Opus 5, then Astra, then GPT-6 Sol'). 2) Tap or click opens a single popover (a bottom sheet on phones) with two sections: 'Model': the grouped searchable model list (by agent; signed-out agents disabled with a 'Sign in' link, as today); choosing one sets the primary and keeps the sheet open. 'If <primary> hits its limit': the ordered fallback list with drag or Alt+↑/↓ reordering, remove ×, '+ Add model' (the same picker) and the limited-dot markers, saving instantly via PUT /api/convos/:id/fallbacks. Esc and outside click close it. 3) Remove the separate Fallbacks button and its markup/CSS/handlers; keep the per-task fallbacks editor in the task drawer as is. 4) The effort control, if present, stays separate. 5) It works at 390px without overflow (the pill truncates the fallback part first). Update the static UI test ids and add test/ui-model-fallbacks*.test.mjs: the pill renders 'primary → first fallback'; choosing a model updates the pill; adding, removing and reordering in the sheet PUTs the right list; the old Fallbacks button is gone. Run only the touched test files.

## Done when

`node --test test/ui-model-fallbacks*.test.mjs test/ui-static.test.mjs` passes (combined pill text, model pick, fallback edits PUT, old button removed)

## Result — done (check passed) (2026-09-28 15:14)

AGENT-ORCH-STATUS: done — CONTEXT.md merged; model-fallbacks and static UI tests pass

## Result — verify failed (1) (2026-09-28 15:14)

Command: merge main again

main changed meanwhile; conflicts in: .agent-orch/CONTEXT.md

## Result — done (check passed) (2026-09-28 16:53)

AGENT-ORCH-STATUS: done — CONTEXT.md conflict re-resolved; model-fallbacks, ui-static and orchbar tests pass

## Result — verify failed (2) (2026-09-28 16:53)

Command: merge main again

main changed meanwhile; conflicts in: .agent-orch/CONTEXT.md

## Result — done (check passed) (2026-09-28 16:53)

AGENT-ORCH-STATUS: done — CONTEXT.md conflict resolved again; Done-when tests pass (23/23)
