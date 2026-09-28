# Task #326: Fix the stale cluster-protocol test: FEATURE_LIST includes browser-task

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-28 11:43  
- files: test/cluster-protocol.test.mjs, cluster-protocol.mjs

## Prompt

test/cluster-protocol.test.mjs fails on main: the test 'worker reports: job.phase, job.error, node.error, logs, node.update, and telemetry on resources' asserts FEATURE_LIST deep-equals a list ending in 'cap', but task #308 added 'browser-task' to FEATURE_LIST in cluster-protocol.mjs (line ~67, `[...new Set([...Object.values(FEATURES), 'cap', 'browser-task'])]`) without updating the test. Fix the expectation in test/cluster-protocol.test.mjs so it includes 'browser-task' (and any other assertion in that file that enumerates features or WORKER_ACCEPTS, if it is also stale). Do not change cluster-protocol.mjs unless the test reveals a real inconsistency; if it does, explain it in the journal note. Also check .agent-orch/CLUSTER.md's feature table mentions browser-task (it does at 'Screen prompts'; leave it if so). Verify with `npm test -- test/cluster-protocol.test.mjs`.

## Done when

`npm test -- test/cluster-protocol.test.mjs` passes and `grep -n "'browser-task'" test/cluster-protocol.test.mjs` prints a line.

## Result — done (check passed) (2026-09-28 11:48)

AGENT-ORCH-STATUS: done — cluster-protocol test now expects browser-task; all 11 pass
