# Task #349: Verifier AUDIT #64: every line of a fenced Done-when block and every ;-part of a snippet must pass

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:31  
- files: taskrun.mjs, test/verify.test.mjs

## Prompt

Reliability fix in taskrun.mjs (read its header comment and .agent-orch/AUDIT.md Round 7 finding #64 first). Today extractCommand hands a fenced ``` block to `bash -c` whole, so only its LAST line decides pass or fail (verified: a block with `node -e "process.exit(1)"` then `node -e "process.exit(0)"` passes), and a single snippet holding a `;` such as `test -f /nonexistent; test -d /tmp` passes too. Fix in extractCommand/checkCommand only, no change to runCheck's spawn: (1) split a fenced block into its non-empty lines (drop lines that are only a `#` comment, strip a leading `$ `), pass each through checkCommand, return null if any is refused, and join them with ` && `; (2) in a single snippet, split on a bare `;` (outside quotes: use the existing `unquoted` helper to find positions) and join the parts with ` && ` BEFORE the grep "prints nothing" rewrite, so that rewrite still appends its own `; test $? -eq 1` and the multi-snippet join still wraps that case as `{ …; }`. Do NOT switch to `bash -e`: the grep rewrite relies on grep exiting 1 without aborting. Keep the existing refusal rules (`>`, rm, sudo, git push, curl) and the `;`/`&&` count limit applied per line/part rather than to the whole block. Add tests to test/verify.test.mjs: the two-line block above returns a command that exits non-zero under runCheck; `test -f /nonexistent; test -d /tmp` fails; a block whose lines all pass still passes; the grep prints-nothing rewrite is unchanged (`grep -q foo file` followed by 'prints nothing' still yields `; test $? -eq 1`). Verify with `npm test -- test/verify.test.mjs`. AUDIT.md is held by other tasks: do not edit it.

## Done when

`npm test -- test/verify.test.mjs` passes and `node -e "import('./taskrun.mjs').then(m=>{const c=m.extractCommand('\`\`\`\nnode -e \"process.exit(1)\"\nnode -e \"process.exit(0)\"\n\`\`\`');process.exit(c&&c.includes(' && ')?0:1)})"` exits 0
