# Antigravity tool diagnosis — task #134

## Evidence and scope (2026-09-25)

The reported `view_file` execution failure was **not reproduced**. A real diagnostic
read succeeded. The supported adapter fix below corrects loss of the file path in
tool events; it does not claim to fix a failed native file read. The requested
execution-failure reproduction remains unverified; do not infer it from the
planning session's bwrap failure or from the old synthetic test fixture.

Read `.agent-orch/AGENTS.md`, BRIEF and CONTEXT. Launch path: orchestrator.mjs
`runAgent` → agents.mjs `runAgentCli` / `runAntigravity` →
`/home/ubuntu/.local/bin/agy -p <prompt> --output-format stream-json --print-timeout 0`,
with project cwd, selected `--model`, autonomous `--dangerously-skip-permissions`,
and optional `--conversation`. API-billing environment stripping remains in place.
The adapter normalizes events; native agy registers and executes the tools.

The read-only orchestrator DB query found one historical Antigravity run:
`data/orchestrator/runs/run-000136.jsonl`, task 130, model
`claude-opus-4-6-thinking`, conversation
`a1f73e86-1d55-4087-895a-000a05e6a530`, ending `aborted`.
Cross-checked the native session's SQLite `steps` table at
`~/.gemini/antigravity-cli/conversations/<conversation>.db` using mode=ro,
and `~/.gemini/antigravity-cli/log/cli-20260925_200235.log`.
No credentials are copied into this report or fixtures.

## Observed calls and independent failures

- Step 2: `view_file({AbsolutePath:"/home/ubuntu/agent-orch/.agent-orch/BRIEF.md",…})`.
  Native stored output includes the numbered file contents, status 3, no
  `error_details`; run log says `51 lines, 3734 bytes`, `isError:false`.
  Other stored file reads likewise succeeded, including CONTEXT, app.js,
  server.mjs and tests. The normalized input was incorrectly `{}`.
- Step 99: `schedule({DurationSeconds:60, Prompt:"Check on npm test completion",
  TimerCondition:"a1f73e86-1d55-4087-895a-000a05e6a530/task-75",…})` failed with
  `Encountered error in step execution: another active schedule task
  "a1f73e86-1d55-4087-895a-000a05e6a530/task-89" has a conflicting early
  termination condition "a1f73e86-1d55-4087-895a-000a05e6a530/task-75"`.
  Root cause: a duplicate timer condition already owned by task-89, confirmed
  by subsequent `command_status` output. This is independent of file tools;
  no scheduling-policy change is made.
- Step 161: `run_command` launched a temporary-data server on port 3999,
  piping `node server.mjs` output to `head -20`. Its recorded error was
  `{"type":"TOOL_ERROR","message":"context canceled"}`. Other attempts
  produced HTTP status `000`, and later a port-3998 probe returned 200.
  The precise cancellation cause is not established. Do not attribute it to
  missing dependencies, filesystem permissions or bwrap without evidence.
- Native log at 20:15:58–20:17:34 records seven provider retries:
  `RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade
  your subscription to increase your limits. Resets in 4h46m44s.` (first retry).
  This is provider quota exhaustion after successful file and command tools,
  not a tool-registration failure. No provider/configuration changes are made.

## Reproduction and minimal fix

A fresh read-only `runAgentCli` invocation in this checkout (usageProbe:false,
45-second AbortSignal timeout, no model override) requested exactly one
`view_file` of `/home/ubuntu/agent-orch/package.json`. Conversation
`14b0d48e-cf8e-4dbb-a0d5-bbc5c4671358` emitted init cwd
`/home/ubuntu/agent-orch`, registered `view_file`, permission mode
`always-proceed`, then ACTIVE/DONE with parameters `{AbsolutePath:…}` and
output `20 lines, 487 bytes`. Outcome was `ok`, stderr empty, and the response
correctly identified package name `agent-orch`.

This rules out a current registration/schema, cwd/path resolution, filesystem
permission or missing runtime dependency problem for this read. It does not
prove every tool or every model works. The successful historical reads also
contradict a blanket file-tool failure in the reported run.

Replaying that parameter shape through `AGENTS.antigravity.events` reproduced
the supported defect: `snakeKeys` creates `absolute_path`, which the shared
`toolInputSummary` allowlist drops. The existing fixture uses `FilePath`, so
it missed the native spelling. `agents.mjs` now maps `view_file.AbsolutePath`
to the existing `file_path` event field before summarizing. No CLI flags,
permissions, dependency installation, native execution or other adapter changed.

Affected files: `agents.mjs`, `test/agents.test.mjs`, `.agent-orch/BRIEF.md`,
`.agent-orch/CONTEXT.md`, and this report. No UI source changed.

## Regression verification

`node --test --test-name-pattern='view_file retains' test/agents.test.mjs`
failed before the adapter fix: expected `input.file_path`, received `input:{}`.
The focused test replays the observed ACTIVE/DONE shape and additionally checks
that a synthetic missing-file ERROR retains its original error and `isError:true`.
The synthetic control is not evidence of a historical failed file read.

After the fix, `node --test test/agents.test.mjs` exited 0: **24 passed,
0 failed**, including the new regression and Claude/Codex adapter, environment
stripping, resume, cancellation and usage checks.

Remaining limitation: there is no demonstrated native file-execution failure
whose root cause can support an execution/configuration fix. The evidence
supports the diagnostic mapping fix only. Task #135's live orchestrated
acceptance is deliberately not undertaken here.
