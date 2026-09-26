# Test speed measurements — task #168

Measured on 2026-09-26, Linux arm64, Node 22.23.2 / npm 10.9.8, in the isolated task worktree.

## Method

Each of the 42 `test/*.test.mjs` files was run individually with `node --test <file>`, in alphabetical order, before and after its edits. Wall time includes process startup and teardown; Python `time.monotonic()` measured each subprocess. All 42 files passed in both passes. Profiling and full-suite runs ran sequentially, without overlapping test commands. The full-suite command was the unchanged `npm test`, with its normal concurrency. Single samples include ordinary host/startup variation; unchanged files are included for comparison.

## Changes and preserved coverage

- Seven scheduler-heavy files use `createOrchestrator({ config: { pollMs: 100 } })` instead of the production 3000 ms interval. Test rows are still seeded before yielding to the scheduler.
- `test/helpers/wait.mjs` polls conditions every 20 ms with a 30-second failure deadline and throws on timeout. This replaces loops that silently exhausted their attempts.
- Scheduling, delegation and independent-limit negative checks wait for another subscription check after workers settle (two separate checks for the initially blocked scenario), rather than sleeping 3.5–8.5 seconds. No view calls occur while observing that next check.
- Drain and planner tests release a fake worker only after recording the in-flight state. Parallel tests use explicit release gates for long-running prerequisites and agent spreading, retaining overlap, cancellation/retry, and dependency assertions.
- Drain's negative observations retain a 350 ms window spanning more than three configured polling intervals. Short holds needed for other overlap assertions remain.
- Existing server tests already share a server per file through setup/teardown hooks. No additional server sharing was necessary; lifecycle and isolated scheduler scenarios keep their own processes.
- All existing assertion lines and all 229 tests are retained. No production source or application visuals changed. The focused run passed all 44 tests in the edited files.

## Per-file wall times

Sorted by baseline duration. An asterisk marks an edited test file. Seconds, including startup/teardown.

| Test file | Before (s) | After (s) | Saved (s) |
| --- | ---: | ---: | ---: |
| ui-away.test.mjs | 23.526 | 24.045 | -0.519 |
| parallel.test.mjs * | 21.762 | 10.897 | 10.865 |
| ui-fallbacks.test.mjs | 19.739 | 19.575 | 0.164 |
| server.test.mjs | 16.992 | 20.093 | -3.101 |
| limits-independent.test.mjs * | 16.256 | 3.819 | 12.437 |
| ui-shots.test.mjs | 15.285 | 15.531 | -0.246 |
| no-orchestrator.test.mjs | 14.906 | 15.055 | -0.149 |
| delegate.test.mjs * | 14.441 | 8.303 | 6.138 |
| drain.test.mjs * | 14.396 | 2.147 | 12.249 |
| routing.test.mjs * | 14.026 | 4.099 | 9.927 |
| planner-guard.test.mjs * | 11.834 | 6.515 | 5.319 |
| scheduling.test.mjs * | 11.800 | 5.742 | 6.058 |
| restart.test.mjs | 10.985 | 10.899 | 0.086 |
| repo-link.test.mjs | 8.927 | 10.060 | -1.133 |
| worktree.test.mjs | 7.233 | 7.356 | -0.123 |
| agents.test.mjs | 7.044 | 7.055 | -0.011 |
| pending-messages.test.mjs | 6.510 | 7.800 | -1.290 |
| reflect-fallbacks.test.mjs | 3.859 | 3.862 | -0.003 |
| agy-worker.test.mjs | 3.758 | 3.843 | -0.085 |
| ui-agy-usage.test.mjs | 3.215 | 3.212 | 0.003 |
| reorder.test.mjs | 2.685 | 2.713 | -0.028 |
| fallbacks-api.test.mjs | 1.561 | 1.626 | -0.065 |
| codex-limit.test.mjs | 1.056 | 1.071 | -0.015 |
| models.test.mjs | 0.928 | 0.915 | 0.013 |
| memdir.test.mjs | 0.868 | 0.861 | 0.007 |
| opencode.test.mjs | 0.845 | 0.784 | 0.061 |
| kiro.test.mjs | 0.725 | 0.713 | 0.012 |
| connections.test.mjs | 0.704 | 0.704 | 0.000 |
| copilot.test.mjs | 0.663 | 0.642 | 0.021 |
| github.test.mjs | 0.629 | 0.630 | -0.001 |
| runcheck.test.mjs | 0.496 | 0.547 | -0.051 |
| limit-reset.test.mjs | 0.448 | 0.433 | 0.015 |
| verify.test.mjs | 0.441 | 0.419 | 0.022 |
| pacing.test.mjs | 0.438 | 0.430 | 0.008 |
| protocol.test.mjs | 0.427 | 0.417 | 0.010 |
| jsonl.test.mjs | 0.419 | 0.394 | 0.025 |
| media.test.mjs | 0.417 | 0.401 | 0.016 |
| ui-static.test.mjs | 0.162 | 0.143 | 0.019 |
| usage.test.mjs | 0.150 | 0.176 | -0.026 |
| model-status.test.mjs | 0.136 | 0.137 | -0.001 |
| task-sound.test.mjs | 0.130 | 0.131 | -0.001 |
| runtimes.test.mjs | 0.124 | 0.121 | 0.003 |
| **Total, individual files** | **260.946** | **204.316** | **56.630** |
| **Edited files subtotal** | **104.515** | **41.522** | **62.993** |

## Full-suite total and repeatability

| Run | Wall time (s) | Result |
| --- | ---: | --- |
| Before: npm test | 278.470 | 229 passed; 0 failed, cancelled or skipped |
| After 1: npm test | 197.210 | 229 passed; 0 failed, cancelled or skipped |
| After 2: npm test | 199.632 | 229 passed; 0 failed, cancelled or skipped |
| After 3: npm test | 196.619 | 229 passed; 0 failed, cancelled or skipped |

Full-suite total: about 278 s before, about 198 s after (roughly 80 s, or 29%, saved per run). Three consecutive full runs after the change all passed with no flaky failures.
