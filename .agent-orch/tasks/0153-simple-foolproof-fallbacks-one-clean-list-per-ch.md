# Task #153: Simple, foolproof fallbacks: one clean list per chat and for reflection

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 04:21  
- starts after: #152

## Prompt

Replace the confusing Auto Delegate / fallback UX with one simple model (see BRIEF goal 8). 1) The composer: remove the 'Auto Delegate' option from the model selector. The selector picks the primary model only. Next to it, a small 'Fallbacks' button shows the count ('Fallbacks · 2', or 'No fallbacks'). It opens a clean sheet titled 'If <primary> hits its limit' with an ordered list of models (a number, a model display name, an agent name in muted text, and a remove ×), drag to reorder (pointer events, long-press on touch) plus Alt+↑/↓, and one '+ Add model' button that opens a searchable picker of connected agents' discovered models. That's all: no scores, no suggestions, no statuses other than a small dot if that model is currently limited. Every change saves instantly (PUT /api/convos/:id/fallbacks). Reuse renderFallbackEditor but strip it down to this. 2) Semantics: a chat's fallback list is snapshotted onto the tasks queued from its messages. A non-empty list means those tasks move down the list on rate limits, and an empty list means they wait. Remove the autoDelegate/pinned flags from the message path, tasks.auto_delegate and the delegate eligibility matrix, and keep the tasks.fallbacks snapshot. Migrate: chats that had Auto Delegate on with fallbacks=null get an empty list. 3) Reflection fallbacks in orchestrator settings (#obPop) use the exact same sheet, must open instantly (render from the already-loaded model lists, no network wait and no metrics fetch; show a skeleton at most for one frame), and save via the existing endpoint. 4) Remove now-dead code paths (the preview endpoint's suggestions, and the forecast bits if unused). Tests: fallback save/load; a queued task moves to the first available fallback when its primary is limited; with an empty list it waits. Screenshots on desktop and 390px via bin/shot.mjs.

## Done when

`npm test` passes with fallback-move and empty-list-waits tests, `! grep -n "Auto Delegate" public/app.js public/index.html` finds nothing, and the reflection fallback sheet renders without any fetch (asserted in test/ui-fallbacks.test.mjs)

## Result — done (check passed) (2026-09-26 04:50)

AGENT-ORCH-STATUS: done — Fallback lists replace Auto Delegate everywhere; 189 tests pass
