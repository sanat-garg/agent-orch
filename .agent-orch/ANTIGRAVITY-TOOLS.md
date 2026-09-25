# Antigravity tool diagnosis — task #134

## Evidence and scope (2026-09-25)

The reported `view_file` execution failure was **not reproduced**. A real diagnostic
read succeeded. The supported adapter fix below corrects loss of the file path in
tool events; it does not claim to fix a failed native file read. The investigation found no evidence of a broken native file reader in the
reported run. Do not infer one from the planning session's bwrap failure or the
old synthetic test fixture. A controlled native failure and recovery are now
recorded below, and the supported adapter defect has a real-event regression.

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

Affected files: `agents.mjs`, `test/agents.test.mjs`,
`test/fixtures/agy-stub.mjs`, `test/fixtures/agy-file-tools.jsonl`,
`.agent-orch/BRIEF.md`, `.agent-orch/CONTEXT.md`, and this report. No UI source changed.

## Controlled native failure and recovery

A second read-only diagnostic used a temporary cwd containing `present.txt`
and an intentionally absent `missing.txt`, with the same subscription-only
adapter and no permission changes. It requested these two `view_file` calls
only. No orchestrator task was launched (that acceptance belongs to #135).

First, explicitly selecting the historical model `claude-opus-4-6-thinking`
reproduced provider failure before any tool call: conversation
`8dc4710e-38dc-422a-aa33-9d11a19bc82b`, native log
`cli-20260925_205538.log`, `RESOURCE_EXHAUSTED (code 429): Individual quota
reached`, five retries, then the diagnostic's 55-second abort. This isolates
the model's quota from file-tool execution; it is not a file-tool failure.

A fresh diagnostic with no model override completed successfully, conversation
`56749c65-bb54-4892-bdea-d4a60b3b2779`, empty stderr:

1. `view_file({AbsolutePath:"/tmp/agy-file-diagnostic-WR2v4X/missing.txt"})`
   emitted ACTIVE then ERROR with the following native structured error:

   ```json
   {"type":"TOOL_ERROR","message":"declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) failed to read file: stat /tmp/agy-file-diagnostic-WR2v4X/missing.txt: no such file or directory"}
   ```

   Root cause: the requested file does not exist. Despite the outer
   `declaring permissions` / `invalid_args` wording, this is ENOENT from
   path validation, not missing tool registration, a malformed tool schema,
   denied filesystem access, bwrap or a runtime dependency. This deliberately
   induced failure is not presented as the owner's historical failure.
2. The next call read `present.txt` successfully: ACTIVE then DONE,
   `2 lines, 24 bytes`; the model returned `ANTIGRAVITY_READ_OK_134`.
   Normalized events retained both absolute paths, marked only the first
   result as an error, and the final turn outcome was `ok`.

The temporary directory was removed after the check. The fixture preserves
these native step/result events, replacing only the temporary root with
`/workspace` and conversation ID with `agy-file-diagnostic`.

## Regression verification and completion

The initial synthetic regression failed before the mapping fix (expected
`input.file_path`, received `input:{}`). It is now replaced by a stronger
recorded-stream regression through the existing stub CLI and `runAgentCli`,
including the actual structured native error above and successful recovery.

`node --test --test-name-pattern='recorded file tools' test/agents.test.mjs`
passes. As a negative control, an isolated temporary copy with only the
`AbsolutePath` mapping removed exited 1 on this same test: both normalized
file paths disappeared. No live source or process was changed for that check.

`node --test test/agents.test.mjs` exited 0: **24 passed, 0 failed**,
including the recorded regression and Claude/Codex adapter, environment
stripping, resume, cancellation and usage checks. `git diff --check` passes.

Done-when evidence: this report identifies observed failed calls and their
causes (the historical duplicate scheduler condition and controlled native
missing-file error), reproduces the adapter's path-loss defect on the real
failed file call, and records a passing regression for the minimal mapping
fix. Historical successful reads, independent command cancellation and
provider quota exhaustion remain explicitly distinguished. No evidence
supports a broader execution/configuration or permission change; the
investigation is complete within that boundary. This does not claim that
the owner's alleged historical file-read failure was reproduced or repaired.
