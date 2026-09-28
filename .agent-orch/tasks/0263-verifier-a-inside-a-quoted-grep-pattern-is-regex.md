# Task #263: Verifier: a | inside a quoted grep pattern is regex, not a pipe (land the task-244 taskrun fix)

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-28 04:54  
- files: taskrun.mjs, test/verify.test.mjs, .agent-orch/CONTEXT.md

## Prompt

The Done-when verifier (taskrun.mjs extractCommand/checkCommand) rewrites a lone `grep …` followed by "prints nothing" into `grep …; test $? -eq 1`, but skips the rewrite whenever the command contains `;`, `&` or `|` anywhere, including inside the quoted pattern (e.g. `grep -n 'cat <<.*|' a.sh` prints nothing). Fix: add `const unquoted = (s) => s.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\\./g, '_');` next to looksLikeCommand and test the operator check against `unquoted(cand)` instead of `cand`, keeping a real pipe (`grep a x | grep -v b`) as written. The exact diff exists on local branch agent-orch/task-244 (`git diff main..agent-orch/task-244 -- taskrun.mjs test/verify.test.mjs`); apply only those two hunks, nothing else from that branch. Add the branch's test cases to test/verify.test.mjs: single-quoted pattern with `|`, the same inside a longer Done-when joined with &&, a double-quoted pattern with `|` and `;`, and a real pipe left unchanged. Also drop the 'until taskrun.mjs blanks quoted text first' clause from the verifier gotcha in .agent-orch/CONTEXT.md.

## Done when

`node --test test/verify.test.mjs` passes and `grep -n 'unquoted' taskrun.mjs` prints a match
