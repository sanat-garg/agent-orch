# Task #371: taskrun.mjs: checkUnavailable accepts a 127 only for a missing first program (AUDIT #65 half two)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:54  
- files: taskrun.mjs, test/verify.test.mjs

## Prompt

Reliability in taskrun.mjs (AUDIT #65 in .agent-orch/AUDIT.md; do not edit AUDIT.md or orchestrator.mjs, both are held). The orchestrator treats any exit 127 with 'command not found' in the output as 'check unavailable' and merges the task unverified, even when the missing program is a script inside an npm script (`sh: jestx: command not found`), which means the project's own tests were never run. Add and export `checkUnavailable(command, output, code, env = process.env)` → boolean, true only when: code === 127; the output has a `<name>: command not found` (bash) or `<name>: not found` (sh) line; `<name>` equals the command's own first word after stripping a leading `cd <dir> &&` and env assignments (reuse the CD_PREFIX/ENV_PREFIX helpers; for `a && b` chains any part's first word counts, for `! cmd` the word after !); and that word is not found on env.PATH (check each PATH dir with fs.accessSync X_OK; a word containing / is checked as a path). A missing runner named inside a script (`npm test` → `jestx`) or a missing program that IS on PATH (an alias problem) returns false. Do not change extractCommand or runCheck. Tests in test/verify.test.mjs: `node_modules && npm test` with 'bash: node_modules: command not found' and a PATH lacking it → true; `npm test` with 'sh: jestx: command not found' → false; `CI=1 pytest` with 'bash: pytest: command not found' and a PATH without pytest → true; exit 1 → false; a temp PATH dir holding an executable `pytest` → false. Run only `npm test -- test/verify.test.mjs`.

## Done when

`npm test -- test/verify.test.mjs` passes and `grep -q 'export function checkUnavailable' taskrun.mjs`
