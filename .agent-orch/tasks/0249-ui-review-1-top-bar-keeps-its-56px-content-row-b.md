# Task #249: UI-REVIEW #1: top bar keeps its 56px content row below the iPhone safe-area inset

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 01:13  
- files: public/app.css, test/ui-static.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

Apply the finding UI-REVIEW #1 from .agent-orch/UI-REVIEW.md. The finished change exists on local branch `claude/topbar-safe-area` (commit 5009ccc): `git cherry-pick 5009ccc` in your worktree; the only conflict is the end of test/ui-static.test.mjs (keep both main's newer tests and the new one). The change: in public/app.css both `.topbar` rules (base and the `@media (max-width: 800px)` one) get `height: calc(56px + env(safe-area-inset-top, 0px))` while keeping `padding-top: env(safe-area-inset-top)`; the new test in test/ui-static.test.mjs asserts it for both rules; UI-REVIEW.md row 1 is marked fixed. Run `node --test test/ui-static.test.mjs test/ui-away.test.mjs` then `npm test`.

## Done when

`grep -c 'calc(56px + env(safe-area-inset-top' public/app.css` prints 2 and `node --test test/ui-static.test.mjs` passes

## Result — done (check passed) (2026-09-28 03:11)

AGENT-ORCH-STATUS: done — Top bar height includes safe-area inset; static tests pass
