# Task #63: CLI adapters kill leftover process-group members after normal exit (AUDIT #21)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 04:24  
- starts after: #62

## Prompt

Fix AUDIT #21 in .agent-orch/AUDIT.md (read it first). In agents.mjs `spawnJsonl` (around lines 190-235), the detached child's process group is killed only on abort/stopOn, and `finally` clears the SIGKILL follow-up timer as soon as the leader exits. After the child closes normally, call killGroup('SIGTERM') (ignore errors such as ESRCH). Keep the SIGKILL follow-up as an unref'd timer instead of clearing it in finally, so members that ignore SIGTERM also die. Don't delay the adapter's result waiting for the timer. Add a test in test/agents.test.mjs with a stub in test/fixtures/ that starts a background `sleep 300` (recording its pid to a temp file) and then exits cleanly. After the run finishes, assert that the pid is gone within a few seconds (process.kill(pid, 0) throws). Mark AUDIT #21 Fixed, and update the Status line at the top of AUDIT.md if all of #17-21 are now fixed.

## Done when

`npm test` passes and `grep -n 'Fixed' .agent-orch/AUDIT.md` shows a Fixed line under item 21

## Result — done (check passed) (2026-09-25 09:01)

AGENT-ORCH-STATUS: done — CLI runs now kill leftover process-group members; AUDIT #21 fixed
