# Task #445: Assign task button on machine cards: pick a ready task, start it there now

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 14:40  
- files: public/app.js, public/app.css, test/ui-assign*.test.mjs

## Prompt

UI for manual assignment (public/app.js, app.css). Add renderAssignButton(node) (see the rule in .agent-orch/CONTEXT.md) and use it on EVERY machine card in the Machines view and in the machine's detail panel (and in the head's card): an 'Assign task' button (disabled with a tooltip when the node is offline). It opens a compact picker (a popover on desktop, a bottom sheet on phones) titled 'Run on <machine> now' that lists ONLY the tasks returned by GET /api/cluster/nodes/:id/assignable (ready: no unfinished prerequisite), each row with #id, title, urgency, agent·model and how long it has waited, plus a search filter. Tap or click a row (or press Enter) → POST /api/orch/tasks/:id/assign {node}; on success, close it, show a toast 'Started #N on <machine>' (with ' · CPU busy' if warning), and the card updates live. On 409, show the reason inline in the row. An empty state reads 'No ready tasks: everything queued is waiting on another task'. The contract is exactly this; the parallel backend task implements it. Theme-consistent, keyboard accessible, and 44pt rows on phones. Tests with mocked endpoints: the button exists on each machine card and in the detail panel; the picker lists only the returned tasks; selecting one posts the right body and shows the toast; a 409 shows its reason. Run only the touched test files.

## Done when

`node --test test/ui-assign*.test.mjs` passes (button on every card and detail panel, picker lists assignable tasks, assign posts and toasts, 409 reason shown)

## Result — done (check passed) (2026-09-28 14:56)

AGENT-ORCH-STATUS: done — Assign task picker on every machine card and detail panel
