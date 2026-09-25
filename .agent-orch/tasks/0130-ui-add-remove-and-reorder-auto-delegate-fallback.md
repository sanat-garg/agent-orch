# Task #130: UI: add, remove and reorder Auto Delegate fallbacks in the composer

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 19:45  
- starts after: #129

## Prompt

In the composer's Auto Delegate summary (added by task #125: 'Start → fallback → fallback' with a popover/sheet of ranked candidates), let the owner edit the list using the backend from the previous task (PUT /api/convos/:id/fallbacks, GET /api/delegate/preview?convo=). In the popover (a bottom sheet on mobile): 1) Show the current fallbacks in order, each row with the agent, model, availability dot, key metrics, a remove (×) button and drag-to-reorder (pointer events, long-press on touch; up/down buttons as a keyboard/accessible alternative). 2) An '+ Add fallback' row opens a searchable list of ALL discovered models grouped by agent (Claude, Codex, Antigravity), showing availability and Coding/Agentic Index where known. Models already in the list are marked. Picking one appends it. 3) A 'Suggested' section shows the automatic top picks not yet in the list, with one-tap add. 4) 'Reset to automatic' sets fallbacks to null (with confirmation), and the header says 'Automatic' or 'Your list'. 5) Save on every change (optimistic, with revert and a toast on error), and update the compact composer summary immediately. The summary must stay compact and not overflow the composer (it collapses to 'Start +N' on narrow widths). When a specific model is selected instead of Auto Delegate, none of this shows. Test on a separate port with CW_DATA_DIR=$(mktemp -d) and CW_NO_ORCHESTRATOR=1, with desktop and 390px screenshots via bin/shot.mjs.

## Done when

`node --check public/app.js && npm test` passes, and app.js calls PUT /api/convos/:id/fallbacks from add, remove, reorder and reset actions
