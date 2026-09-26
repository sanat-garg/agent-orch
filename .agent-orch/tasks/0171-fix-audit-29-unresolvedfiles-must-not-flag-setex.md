# Task #171: Fix AUDIT #29: unresolvedFiles must not flag setext ======= headings

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 10:31  
- files: worktrees.mjs, test/worktree.test.mjs

## Prompt

Read .agent-orch/AUDIT.md finding #29 (Round 4) first. Bug: worktrees.mjs `unresolvedFiles` confirms a 'leftover conflict marker' with `/^(<{7}|>{7})( |$)|^={7}$/m`, so a Markdown setext heading underlined with exactly seven `=` (e.g. `Install\n=======`) added on the main branch is reported as unresolved on every integration attempt, and the integrator can never pass. Fix: count a file as unresolved only if it is still unmerged in the index (`ls-files -u`) or its content has a `<<<<<<< ` line followed later by a `>>>>>>> ` line (a real conflict block); a lone `=======` line must never count. Keep `startIntegration` behaviour otherwise. Add regression tests to test/worktree.test.mjs: (a) the AUDIT repro (task worktree commits a.txt; main commits README.md containing `x\n\nInstall\n=======\n\nrun it\n`; `startIntegration` returns [] and `unresolvedFiles` returns []); (b) a real conflict still returns the file until its markers are removed. Do NOT edit .agent-orch/AUDIT.md. Never restart the live server on port 3000.

## Done when

`node --test test/worktree.test.mjs` passes, including a new test where a README with a setext ======= heading is not reported as unresolved.

## Result — done (check passed) (2026-09-26 10:38)

AGENT-ORCH-STATUS: done — Setext ======= headings are no longer flagged as unresolved conflicts
