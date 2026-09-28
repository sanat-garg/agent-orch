# Task #323: README docs: parallel tasks rewritten for goal 9, push notifications and the Browser tab

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:34  
- starts after: #311, #312  
- files: README.md

## Prompt

Update README.md for what has landed on main (read the code as of now; do not describe anything not on main). (1) 'Parallel tasks and git worktrees' (line ~316) still describes 'one task at a time' and 'Parallel tasks: 2 only above 2.5 GB MemAvailable': rewrite it from parallel.mjs `taskSlots`, orchestrator.mjs `parallelSettings` (parallelTasks 1-16, default 4), the emergency memory floor and the newest-task pause, the per-machine cap in Machines (nodes.max_slots), rapid mode (reflection keeps every free slot fed with file-disjoint tasks and integrators) and the 'Run on' pin. (2) A new 'Notifications' subsection under the PWA/mobile part (or a new section before 'Screenshots'): Web Push with no dependency (push.mjs, VAPID keys in data/push-vapid.json, subscriptions in data/push-subscriptions.json, both never committed), what triggers a push (approvals, chat permission prompts unanswered for 15 s, failed tasks, review checkpoints, waiting events; one per tag per minute), the Settings switch 'Notify this device', the iPhone home-screen requirement and HTTPS via Caddy. (3) 'Computer work' section: the Browser header tab with the in-place live view and the prompt box that runs an agent on the current screen (`POST /api/browser/task`, `GET /api/browser/tasks`, stop), and that screen tasks have no git lifecycle. (4) 'data/' section lists the two push files. Keep the README's terse style and existing headings order.

## Done when

`grep -n 'push-vapid.json' README.md` prints a line, `grep -n '/api/browser/task' README.md` prints a line, and `! grep -n 'over 2.5 GB' README.md` prints nothing
