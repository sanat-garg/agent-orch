# Task #33: Verifier runs every command-like backticked snippet in Done when (AUDIT #16)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:42  
- starts after: #32

## Prompt

AUDIT #16 in .agent-orch/AUDIT.md: extractCommand(doneWhen) in orchestrator.mjs (~line 508) runs only the first backticked snippet. So 'Done when: `grep …` prints nothing and `npm test` passes' becomes a bare grep, and npm test never runs. Change it so that when there is no triple-backtick block, it collects every single-backtick snippet that looks like a command (starts with one of the RUNNERS prefixes, or with '!', 'test ', '[ ', 'grep', 'node', 'npm', 'bash', 'sh ', 'curl', 'python'), ignores snippets that are just file names or identifiers (e.g. `server.mjs`, `loggedIn`), and joins them with ' && '. Keep the current behaviour for triple-backtick blocks and for the no-backticks fallback. Export extractCommand (or add it to an existing test export) and add node:test unit cases in test/protocol.test.mjs (or a new test/verify.test.mjs): the two-command case joins with &&, a file-name-only snippet is ignored, and a single command is unchanged. Update the planner guidance in PLANNER_SYSTEM (and the reflection prompt if it has its own done_when rules) to say that absence checks use `! grep`. Mark AUDIT #16 **Fixed** with a one-line note.

## Done when

`npm test 2>&1 | grep -qi 'extractCommand' && npm test`
