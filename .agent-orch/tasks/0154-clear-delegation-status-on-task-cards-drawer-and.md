# Task #154: Clear delegation status on task cards, drawer and chat

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 04:21  
- starts after: #153

## Prompt

Make it obvious which model a task is on and what happens on a limit (BRIEF goal 8). One consistent vocabulary everywhere, rendered by a single helper modelStatus(task): (a) running or queued normally: 'Opus' (a model chip); (b) queued with fallbacks: 'Opus · then Astra' (only the next fallback, with the full list in a tooltip or the drawer); (c) waiting on a limit with no usable fallback: 'Waiting for Opus · 5:00 AM' (the reset time client-side in the browser's timezone); (d) delegated: 'Astra · moved from Opus (limit until 5:00 AM)' with a small ↪ icon, and the chip coloured to show it's not the primary. The task drawer gets one 'Model' row with the same text plus the ordered fallback list, marking the current one, and an event history line for every move ('04:12 Opus hit its limit → moved to Astra'). Chat: when a task from the chat gets delegated, post one compact notice in the chat ('#152 moved to Astra — Opus is limited until 5:00 AM'). Remove any older, duplicate or verbose delegation labels, badges and reason blurbs, so this is the only representation. Test the helper for the four states, and take screenshots of each state via bin/shot.mjs with seeded tasks.

## Done when

`npm test` passes with modelStatus() tests for the four states, and taskCard and the drawer both use modelStatus()
