# Task #127: Live dependency labels everywhere after reorder, start or finish

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 19:33

## Prompt

Task cards stay where they were created in the chat, under each planner reply. Do NOT move, merge or remove them, and don't add a queue dock. Reordering happens only in the existing Queue modal (#queueModal, drag-and-drop from task #115). Make every dependency/ordering label update live without a reload whenever the order changes (the move API), a task starts or finishes, or a task is cancelled or retried: the card subtitle wherever taskCard() renders ('waiting for #N', 'after #N', 'next up', 'running') in the chat reply cards, the Queue modal and the drawer links; the task drawer's 'Starts after' and 'Then' sections (public/app.js ~lines 2801-2804 render d.dependsOn/d.followers; refresh them if the drawer is open); and the order numbers in the Queue modal. Server: after every move, claim, finish, cancel or retry, broadcast one 'order' WebSocket message with the ordered open-task ids plus depends_on per task. The client updates all visible cards from it in one pass (no per-card refetch storms), and cards in the Queue modal animate to their new positions (FLIP, none under prefers-reduced-motion). Tests: a server test that a move emits the order broadcast with the updated sequence and depends_on.

## Done when

`npm test` passes with an order-broadcast test, and app.js handles an 'order' WebSocket message that updates the card subtitles and the open drawer's Starts after/Then sections
