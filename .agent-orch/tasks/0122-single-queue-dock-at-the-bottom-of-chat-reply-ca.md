# Task #122: Single Queue dock at the bottom of chat; reply cards move into it

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 18:21

## Prompt

Today each planner reply renders its own list of task cards in the chat history (public/app.js ~line 902: case 'tasks' builds a div.task-cards per reply; case 'reflect' likewise), so several replies show several 'queues'. Replace this with ONE live queue. 1) A Queue dock pinned at the bottom of the chat view, above the composer: a header 'Queue · N' with a collapse/expand chevron (state in localStorage), holding every open task (running, queued, waiting on a limit) of the current project. Running tasks come first, then queued in scheduler order (tasks.position if present, else the current order), rendered with the existing taskCard(). Max height ~40% of the viewport with internal scroll; on mobile it's a compact bar that expands into a sheet. 2) Chat history: the 'tasks'/'reflect' events no longer render full cards. They render a compact receipt, e.g. 'Queued 3 tasks · #12 #13 #14', whose chips show each task's live status (dot and title on hover or tap) and open the task drawer. While those tasks are open, the receipt says '→ in queue'. 3) Transition: when a new 'tasks' event arrives live, or on page load for older replies, cards that are still open animate out of the old reply spot into the dock (FLIP: measure, move, transform, ~250 ms, no motion under prefers-reduced-motion). Ongoing tasks stay at the top of the dock, and the newly added ones slide in below them with a brief highlight. There is never more than one queue visible. 4) Finished tasks leave the dock with a fade (done ones are reachable from the receipt chips and the Activity views). Keep the existing WebSocket-driven card refresh (refreshCards) working for the dock. Extend the static UI smoke test for new ids. Test on a separate port with CW_DATA_DIR=$(mktemp -d) and CW_NO_ORCHESTRATOR=1, and capture desktop and mobile screenshots with bin/shot.mjs.

## Done when

`node --check public/app.js && npm test` passes, index.html/app.js has exactly one queue dock element (#queueDock), and the 'tasks' event handler no longer appends taskCard() elements into the chat history
