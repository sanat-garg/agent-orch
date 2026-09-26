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

# End-to-end smoke suite — task #148 (2026-09-26)

`bin/agent-smoke.mjs --agent <id> [--model <m>]` runs ten prompts through the real CLI via `runAgentCli`
(the orchestrator's launch: same adapter args, autonomous, cwd = project, the systemd unit's minimal env
`HOME/USER/LOGNAME/SHELL/LANG/PATH`, a worker-style systemAppend), each in a fresh scratch git project with
a `node --test` suite. Every check is verified on disk or by a random token the agent can only learn through
its tools: quote line 3; list `src/**/*.mjs`; grep a string (with a near-miss decoy); fix `add()` so the
suite passes (test file hash unchanged, suite re-run by the harness); create `docs/guide/NOTE.md`; run
`npm test` (the test file appends to `.test-runs`, plus the shell tool call and pass/fail counts); read by
relative and by absolute path; quote line 2750 of a 3000-line file; resume a conversation and recall a
codeword. It stops at the first rate limit. `--verbose` prints every normalised event.

## Findings

1. **Adapter bug (fixed): write/edit tool paths lost.** Live `write_to_file` and `replace_file_content`
   events carry only `{TargetFile}` (no content). `snakeKeys` made it `target_file`, which
   `toolInputSummary` drops, so every edit/write showed `input: {}` in the UI/run log — the same class of bug
   as #134's `view_file.AbsolutePath`. `agyTool` now maps agy's path parameters (`AbsolutePath`,
   `TargetFile`, `FilePath` → `file_path`; `SearchPath`, `SearchDirectory`, `DirectoryPath` → `path`).
   Regression: `test/fixtures/agy-edit-tools.jsonl` (recorded gemini-3.1-pro-high run, temp root →
   `/workspace`) + test "recorded write/edit tools keep their TargetFile path" (fails on the old code).
2. **agy exposes a reduced toolset to the model (agy design, not our launch).** `init.tools` lists
   `grep_search`, `find_by_name`, `list_dir` etc., but asked for its callable tools both models name only
   `view_file, run_command, write_to_file, replace_file_content, manage_task, send_message, schedule,
   invoke_subagent, define_subagent, manage_subagents, generate_image, read_url_content, search_web,
   ask_question`. Same result with cwd inside the trusted workspace `/home/ubuntu/workspace`, so it's not
   workspace trust. Told not to use `run_command`, Gemini declines to search. Workaround: none needed —
   glob/grep go through `run_command` (`find`, `grep -rl`) and pass; never forbid the shell in agy prompts.
3. **Model tool-call errors recover inside the turn.** One gemini run called `run_command {"command":"npm
   test"}` and got `invalid arguments: missing property 'WaitMsBeforeAsync'`; it retried correctly and the
   check passed. Native schema validation, not the adapter (the error text is preserved in `tool_result`).
4. **Provider quota, not tools.** The first claude-sonnet-4-6 runs ended `rate_limited` ("Individual quota
   reached … Resets in 42m36s") after ~150 s of agy-internal retries; `/usage` showed `3p-5h` at 0 remaining
   until 01:02:43Z. The adapter classified it correctly. Codex was likewise limited (until 01:20).
5. **No sandbox/bwrap/env/cwd/path/resume problem.** bwrap isn't installed and our launch never passes
   agy's `--sandbox`; `run_command` runs `npm`/`node`/`git` fine under the service env. Relative and absolute
   reads, a 3000-line file, a new subdirectory and `--conversation` resume all work on both models. agy's
   log lines "You are not logged into Antigravity" at startup appear in successful runs too (token load race).
6. (Harness bug found on the first run, fixed in the script: `node --test test/` isn't valid on node 22.)

## Final results

`node bin/agent-smoke.mjs --agent antigravity --model gemini-3.1-pro-high` — exit 0:

| check | result | secs | tools used |
|---|---|---|---|
| read-line3 | pass | 18 | view_file |
| glob | pass | 19 | Bash |
| grep | pass | 19 | Bash |
| edit-fix | pass | 34 | Bash view_file replace_file_content |
| create-subdir | pass | 19 | write_to_file |
| npm-test | pass | 18 | Bash |
| read-relative | pass | 16 | view_file |
| read-absolute | pass | 17 | view_file |
| large-file | pass | 17 | view_file |
| resume | pass | 22 | - |

`node bin/agent-smoke.mjs --agent antigravity --model claude-sonnet-4-6` — exit 0:

| check | result | secs | tools used |
|---|---|---|---|
| read-line3 | pass | 22 | view_file |
| glob | pass | 19 | Bash |
| grep | pass | 18 | Bash |
| edit-fix | pass | 30 | Bash replace_file_content |
| create-subdir | pass | 19 | write_to_file |
| npm-test | pass | 18 | Bash |
| read-relative | pass | 16 | view_file |
| read-absolute | pass | 13 | view_file |
| large-file | pass | 18 | view_file |
| resume | pass | 21 | - |

`--agent claude` (default model): 10/10 pass (Read, Write, Bash). `--agent codex` (default model): 10/10 pass
(Bash, Edit) after the large-file prompt stopped forbidding the shell (codex has no separate file viewer);
that reworded check was re-run on both agy models and still passes via `view_file`. `npm test`: 198/198.

# Orchestrator verification — task #149 (2026-09-26)

`bin/orch-e2e.mjs --agent antigravity --model <m>` runs one real orchestrator task end to end: server.mjs on a spare
port with `CW_DATA_DIR` = a fresh temp dir (the systemd unit's minimal env), a scratch git project registered by
switching its chat to Orchestrator Mode (its `origin` is a local bare repo under `<tmp>/github.com/scratch/…`, so
`projectReady` holds and the task's push stays on disk: no GitHub repo is created), `perpetual` off (no Claude
reflection afterwards), then one queued work task: *add an exported `clamp(x, lo, hi)` to src/math.mjs plus tests
below/inside/above the range, keep add()'s test, make `npm test` pass*, done_when `` `npm test` passes … ``, with
`agent=antigravity` and the model set on the task. It waits for claim → agent run → check → done and exits 0 only if
the task is 'done', `npm test` passes in the project, every file tool event carries a path, there was no route note,
delegation or denial, and the live DB has no scratch project.

## Final runs (all fixes below applied)

| model | task / run | agy conversation | result | check | tools (run log) | usage records |
|---|---|---|---|---|---|---|
| gemini-3.1-pro-high | #1 / run 1, 45 s | `80f344aa-c28f-461a-bfc9-3d576b786c2c` | **done**, `AGENT-ORCH-STATUS: done — clamp function and tests added and passing`, commit 9542f76 pushed | `npm test` passed (4/4) | view_file BRIEF.md, CONTEXT.md, src/math.mjs, test/math.test.mjs; replace_file_content src/math.mjs, test/math.test.mjs (all `file_path` = absolute path); Bash `npm test` | tokens 27887 in / 2031 out / 48529 cached; `gemini-5h` 14.63→15.07 %, `3p-5h` unchanged 16.86 % |
| claude-sonnet-4-6 | #1 / run 1, 45 s | `5c681f4a-31c8-46b9-830d-899f3d6945d4` | **done**, `AGENT-ORCH-STATUS: done — clamp added, all 4 tests pass`, commit 95cc839 pushed | `npm test` passed (4/4) | Bash `cat …` (reads); replace_file_content src/math.mjs, test/math.test.mjs (`file_path` set); Bash `npm test` | tokens 20409 in / 1536 out / 78283 cached; `3p-5h` 14.44→16.86 %, `3p-weekly` 38.45→39.25 %, `gemini-5h` unchanged 14.63 % |

Each run used its own temp data dir, so both are task #1 / run 1 there. No limit was hit, so no limit record or
`blocked*` kv was written; the window readings (from the post-run `agy -p /usage`) moved only in the group of the
model that ran. Live isolation: the live service kept PID 735243 (up since 2026-09-25 20:34 UTC), the live DB's
newest task stayed #149 with no `/tmp` project and no new antigravity run, and live `data/metrics/usage.jsonl` got
no antigravity record.

## What broke on the first runs, and the fixes

1. **agy workers could not run any shell command (fixed).** New projects have `autonomous = 0`; for Claude that is
   irrelevant (always bypassPermissions) and codex keeps its workspace-write sandbox, but for agy it dropped
   `--dangerously-skip-permissions`, and headless agy then *auto-denies* every `run_command`. The first gemini run
   (conversation `512d8ea3-…`) edited the files, tried `npm test`, got soft-denied (native log: `Print mode:
   soft-denying tool confirmation "RunCommand" at step 10`) and ended `SUCCESS` with an empty response: the task
   still passed the check but recorded "(no report)". Reproduced in isolation (`9e5b3e76-…`): the denied step
   reports `DONE` with no output; only `result.denied_actions:[{action:"command",display_name:"RunCommand"}]` says
   so. Fixes: orchestrator work tasks routed to antigravity always run autonomous (planner/reflection unchanged);
   the adapter turns `denied_actions` into a text event + `res.text` ("Antigravity denied RunCommand without
   asking …"). Tests: `test/agy-worker.test.mjs` (orchestrator child process with the agy stub as
   `~/.local/bin/agy`; fails on the old code), agents.test "a tool headless agy denied is reported" (recorded
   `test/fixtures/agy-denied.jsonl`).
2. **`claude-sonnet-4-6` on antigravity silently ran Gemini (fixed).** The model is in both Claude's and agy's
   discovered lists; `agentForModel` picks the first (claude), so `resolveRoute` treated the explicit
   antigravity pairing as foreign, dropped the model and ran agy's default (route_note "model claude-sonnet-4-6 is
   not a antigravity model"; `gemini-5h` moved, `3p-*` didn't). `foreignModel` now accepts any model the explicit
   agent's own list names. Test: routing.test "an explicit agent keeps a model its own list names …".
3. **agy input tokens were recorded as 0 (fixed).** `normUsage` subtracted `cache_read_tokens` from
   `input_tokens` (codex semantics), but agy reports cache reads beside input (`total_tokens = input + output`;
   live runs read more cached than input, e.g. 19071 vs 56618), so every agy token record had `input: 0`. agy
   now records `input_tokens` as is. usage.test updated with the live numbers.

`npm test`: 201/201 pass.
