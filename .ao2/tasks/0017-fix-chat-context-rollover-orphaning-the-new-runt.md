# Task #17: Fix chat context rollover orphaning the new runtime (AUDIT #3)

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-24 23:37  
- starts after: #16

## Prompt

Fix AUDIT.md item #3 in /home/ubuntu/claude-web/server.mjs. When a chat passes CHAT_CONTEXT_LIMIT, sendUserMessage closes the old query and calls startRuntime, which registers a new runtime. The old runtime's async loop later hits its finally block (~lines 815-823) and unconditionally runs `runtimes.delete(convo.id)` (also ~line 702), which removes the NEW runtime, and it emits a spurious 'Claude session ended' error. Fix: mark closed runtimes (e.g. rt.retired = true), and only delete from the map or emit errors/busy=false when `runtimes.get(convo.id) === rt` and the runtime isn't retired. Read the whole runtime lifecycle first so you catch every place that assumes one runtime per convo. If practical, factor the guard into a small function you can unit-test, and add a node:test for it in test/. Never restart the live server. Mark #3 as **Fixed** in .ao2/AUDIT.md.

## Done when

`grep -n "runtimes.get(convo.id) === rt" server.mjs` (or an equivalent identity guard) matches in the cleanup path, `npm test` passes, and AUDIT.md marks #3 Fixed
