# Task #12: Audit server, orchestrator and UI for bugs into .ao2/AUDIT.md

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-24 23:31

## Prompt

Review server.mjs, orchestrator.mjs, github.mjs and public/app.js for real bugs and gaps: crashes and unhandled rejections, auth/session flaws, path traversal in static serving, WebSocket auth, race conditions in the orchestrator scheduler/DB, leaks of runaway child processes, and UI error states. Do NOT fix anything in this task. Write .ao2/AUDIT.md as a ranked list. For each item give: severity (high/med/low), file:line, a one-line description, a concrete repro or reasoning, and a suggested fix sized for one 15-45 minute task. Cap it at the 15 most valuable items. Only include issues you verified by reading the code.

## Done when

.ao2/AUDIT.md exists with 5-15 ranked items, each with a severity and a file:line reference

## Result — done (2026-09-24 23:36)

AO2-STATUS: done — AUDIT.md lists 15 ranked, verified bugs with fixes
