# Task #469: Integrate #382: Full-screen Machines window with the queue built in

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-09-28 17:02  
- files: public/app.js, public/app.css, public/index.html, test/ui-machines-full*.test.mjs

## Prompt

Task #382 ("Full-screen Machines window with the queue built in") finished in its own git worktree, but its branch `agent-orch/task-382` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md, public/app.js, public/index.html, test/ui-mini-rotate.test.mjs, test/ui-static.test.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #382's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #382's instructions were:

Make the Machines / server usage window a full-screen view (desktop: fills the viewport over the app with a close button and Esc; phones: a full-height sheet), laid out as: at the top, the cluster summary line and the cluster diagram (machines around the head, with animations as today); a right column on desktop, stacking below on phones, with the QUEUE: the running lanes per machine (the task title, agent·model, phase, elapsed) and the queued tasks in scheduler order (with 'waiting for #N' / hot-file notes, reusing taskCard and the Queue modal's list code, drag-to-reorder included), with a count header 'Running 5 · Queued 12 · 11 free slots'. The per-node detail from the oracle-vm unification opens as a side panel within this full-screen view rather than a separate modal. Live updates via the existing WebSocket. Keep the theme consistent, and make it usable at 390px (the queue as a tab next to 'Machines' on phones). Add a 'Machines' entry that opens it (the sidebar card click opens it focused on that machine). Screenshots on desktop and phone via bin/shot.mjs with seeded nodes and tasks. Test: the full-screen view renders the diagram and the queue list with seeded data; tapping a queued card opens its drawer; phone layout tabs switch. Run only the touched test files.

## Done when

`node --test test/ui-machines-full*.test.mjs` passes (diagram + queue rendered together, card opens drawer, phone tabs)

## Result — done (check passed) (2026-09-28 17:11)

AGENT-ORCH-STATUS: done — Merge resolved; the full-screen Machines view and main's changes both kept, tests pass
