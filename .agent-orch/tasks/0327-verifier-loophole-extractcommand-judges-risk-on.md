# Task #327: Verifier loophole: extractCommand judges risk on the unquoted command so a quoted grep pattern never voids the check

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:43  
- files: taskrun.mjs, test/verify.test.mjs

## Prompt

taskrun.mjs extractCommand/checkCommand build the done-when check that orchestrator.mjs runs after a task. checkCommand refuses a candidate when the RAW text matches />|\brm\s|\bsudo\b|\bgit\s+push\b|\bcurl\b/ or has more than one `;`/`&&`; when it returns null the orchestrator merges the task with ' (check unavailable)' (orchestrator.mjs ~3243), so a Done-when like `grep -q 'a -> b' README.md` or `grep -c 'rm -rf' bin/x.sh` gets NO verification at all. A helper `unquoted(s)` already blanks quoted and backslash-escaped text. Change checkCommand so the risky-operator regex and the `;`/`&&` count run on unquoted(cand) (real redirects, unquoted rm/sudo/curl/git push stay refused), keep everything else as is, and add tests to test/verify.test.mjs (it imports extractCommand via orchestrator.mjs: keep that import): (1) `grep -q 'a -> b' README.md` is returned as written; (2) `grep -n 'rm -rf' bin/x.sh` is returned; (3) `grep 'x' f > out` still returns null; (4) `rm -rf dist` still null; (5) `grep -c 'a;b' f` returns (the quoted ; does not count); (6) the existing 'prints nothing' rewrite still works for `grep 'a|b' f`. Also update the comment in taskrun.mjs. Do not tell the worker to run the whole suite.

## Done when

`npm test -- test/verify.test.mjs test/runcheck.test.mjs` passes and `grep -n 'unquoted(cand)' taskrun.mjs` prints a line.
