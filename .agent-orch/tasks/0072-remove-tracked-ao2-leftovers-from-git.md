# Task #72: Remove tracked .ao2/ leftovers from git

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 09:03

## Prompt

The project memory dir was renamed from .ao2/ to .agent-orch/ (migrateMemDir() in orchestrator.mjs handles legacy dirs). Two stale files are still tracked: .ao2/tasks/0017-*.md and .ao2/tasks/0018-*.md. The live server already writes to .agent-orch/tasks/. Before deleting, check whether equivalent files exist under .agent-orch/tasks/. If they don't, move them there with git mv; otherwise git rm them. Then remove the empty .ao2/ directory. Do not change any source code. Run `npm test` to confirm nothing depends on them.

## Done when

`test -z "$(git ls-files .ao2)"` and `test ! -e .ao2`

## Result — done (check passed) (2026-09-25 09:07)

AGENT-ORCH-STATUS: done — Stale .ao2/ removed from git; npm test passes
