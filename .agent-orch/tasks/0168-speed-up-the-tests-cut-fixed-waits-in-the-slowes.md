# Task #168: Speed up the tests: cut fixed waits in the slowest test files

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 09:57  
- files: test/, .agent-orch/TEST-SPEED.md

## Prompt

`npm test` passes 229 tests but takes about 280 s, and every orchestrator task runs it several times. Measure per-file duration (e.g. run `node --test` per file under test/ and time each), then shorten the slowest few by replacing fixed sleeps with polling for the awaited condition, shrinking timeouts via createOrchestrator({config}) or env, and sharing a spawned server between tests in one file where independent. Do not weaken assertions, delete tests, or change non-test source files. Record before/after per-file times and the total in .agent-orch/TEST-SPEED.md. Run the full suite at least twice to confirm there is no new flakiness.

## Done when

`npm test` `grep -qi total .agent-orch/TEST-SPEED.md`
