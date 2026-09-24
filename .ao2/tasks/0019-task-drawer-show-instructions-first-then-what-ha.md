# Task #19: Task drawer: show instructions first, then what happened, then done-when

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-24 23:37

## Prompt

In public/app.js, the task detail drawer is built in the function around lines 2040-2210 (look for section('Instructions it was given') and section('Done when')). Change the order of the main (non-folded) sections to: 1) 'Instructions it was given' (the task prompt, d.task.prompt, in a pre.dr-pre), moved OUT of the <details class="dr-more"> block to the top of the body, right after the title/actions header; 2) 'What happened' / 'What it found' (the current section 3, unchanged); 3) 'Done when' (d.task.done_when), moved to come after What happened. Everything else (commands and output, check, order, deadline, activity) stays inside the folded Details. Keep showing Instructions only for kind === 'work' as now. If a long prompt makes the drawer awkward, cap its height with CSS in public/app.css (e.g. max-height with overflow:auto on that pre). Don't change the other sections. Check with `node --check public/app.js` and make sure `npm test` still passes.

## Done when

In public/app.js, section('Instructions it was given') is appended to body before the What happened section, which is before section('Done when'), and neither is inside the dr-more details; `node --check public/app.js && npm test` passes
