# Task #370: taskrun.mjs: extractCheck tells a refused Done-when from one with no command (AUDIT #66 half two)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:54  
- files: taskrun.mjs, test/verify.test.mjs

## Prompt

Reliability in taskrun.mjs (AUDIT #66 in .agent-orch/AUDIT.md; do not edit AUDIT.md or orchestrator.mjs, both are held). extractCommand(doneWhen) returns null both when the text names no command and when a snippet was refused (a redirect, rm, sudo, git push, curl, substitution, too many && or ;), so the orchestrator merges a refused check as a plain done. Add and export `extractCheck(doneWhen)` → `{ command: string|null, refused: string[] }` where `refused` lists every command-like snippet (or fenced-block line) that checkCommand rejected, verbatim and trimmed, in order; `command` is exactly what extractCommand returns today. Refactor so extractCommand becomes `extractCheck(d).command` with identical behaviour (every existing test in test/verify.test.mjs must still pass unchanged). A snippet that merely doesn't look like a command (a file name, `loggedIn`) is not refused. Keep the header comment accurate. Add tests in test/verify.test.mjs: a Done-when whose only snippet is `npm test > out.txt` gives command null and refused ['npm test > out.txt']; a plain prose Done-when gives {command: null, refused: []}; a fenced block with one bad line lists that line; a mixed `grep -q x f` + `curl …` lists only the curl. Run only `npm test -- test/verify.test.mjs`.

## Done when

`npm test -- test/verify.test.mjs` passes and `grep -q 'export function extractCheck' taskrun.mjs`
