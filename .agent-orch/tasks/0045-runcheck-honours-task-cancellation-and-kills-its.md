# Task #45: runCheck honours task cancellation and kills its process group (AUDIT #11)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:55  
- starts after: #44

## Prompt

Fix AUDIT #11 in .agent-orch/AUDIT.md. In orchestrator.mjs, `runCheck(command, cwd, env, timeoutSec)` (~line 554) spawns `bash -c` detached but takes no abort signal, and only kills the process group on timeout. Add an optional `signal` parameter. On abort, kill `-child.pid` with SIGKILL (ignore errors) and resolve as failed with '(aborted)'. Also kill the group, ignoring ESRCH, in the 'close' handler, so background processes the check started (e.g. `node server.mjs & sleep 2 && ...`) don't outlive it. Remove the abort listener when finished. Pass the task's abort signal at the call site (~line 1456), and make sure an aborted check doesn't mark the task as verify-failed in a way that differs from how cancellation is normally handled; follow the existing abort handling there. Export runCheck if it isn't exported yet, and add tests in test/ (e.g. test/runcheck.test.mjs). (a) Aborting a `sleep 30` check resolves within about 1 s. (b) After a check like `sleep 30 & echo ok` returns, the background sleep's PID is gone: have the command write `$!` to a temp file, then check with process.kill(pid, 0). Mark AUDIT #11 Fixed with a one-line note. Never touch the running server.

## Done when

`npm test` passes and `grep -A10 '### 11\.' .agent-orch/AUDIT.md | grep -q Fixed`

## Result — done (check passed) (2026-09-25 03:57)

AGENT-ORCH-STATUS: done — runCheck now honours task cancellation and kills its process group
