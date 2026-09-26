# Empty tool inputs, outputs and replies (task #196)

Scanner: `node bin/empty-scan.mjs [--data <dir>] [--runs <dir>]` (read-only). It flags normalised events with a `{}`
tool input, a tool without a name, a tool result with no text, and an ok run with no assistant text. Chat-log events are
attributed to the agent that answered (by tool-id shape: `toolu_` Claude, `item_`/`exec-` Codex, numeric agy).

## Before (live data, 2026-09-26: 211 run logs + 1 chat log, 4147 tool calls)

359 empty events, 359 unexplained
| agent | kind | tool / detail | count | explanation | examples |
|---|---|---|---|---|---|
| antigravity | empty tool input | view_file | 31 | **unexplained** | run-000136.jsonl:2, run-000136.jsonl:4, run-000136.jsonl:13 |
| antigravity | empty tool input | manage_task | 15 | **unexplained** | run-000136.jsonl:121, run-000136.jsonl:136, run-000136.jsonl:142 |
| antigravity | empty tool input | replace_file_content | 5 | **unexplained** | run-000136.jsonl:87, run-000136.jsonl:95, run-000136.jsonl:98 |
| antigravity | empty tool input | schedule | 3 | **unexplained** | run-000136.jsonl:124, run-000136.jsonl:139, run-000136.jsonl:180 |
| antigravity | empty tool input | invoke_subagent | 1 | **unexplained** | logs/ae56746f-8313-43d5-81d1-febe98fe8d7d.jsonl:546 |
| antigravity | empty tool result | Bash | 8 | **unexplained** | run-000136.jsonl:102, run-000136.jsonl:119, run-000136.jsonl:221 |
| antigravity | empty tool result | replace_file_content | 5 | **unexplained** | run-000136.jsonl:88, run-000136.jsonl:96, run-000136.jsonl:99 |
| claude | empty tool input | Skill | 2 | **unexplained** | run-000001.jsonl:17, run-000002.jsonl:31 |
| claude | empty tool input | TaskStop | 2 | **unexplained** | run-000153.jsonl:52, run-000153.jsonl:64 |
| claude | empty tool result | Read | 94 | **unexplained** | run-000082.jsonl:47, run-000099.jsonl:47, run-000099.jsonl:49 |
| claude | empty tool result | ToolSearch | 8 | **unexplained** | run-000042.jsonl:9, run-000043.jsonl:8, run-000120.jsonl:5 |
| codex | empty tool input | WebSearch | 20 | **unexplained** | run-000139.jsonl:9, run-000140.jsonl:22, run-000169.jsonl:9 |
| codex | empty tool result | Bash | 105 | **unexplained** | run-000139.jsonl:29, run-000139.jsonl:40, run-000139.jsonl:50 |
| codex | empty tool result | WebSearch | 19 | **unexplained** | run-000139.jsonl:10, run-000140.jsonl:23, run-000169.jsonl:10 |
| copilot | empty tool input | apply_patch | 23 | **unexplained** | run-000194.jsonl:26, run-000194.jsonl:28, run-000194.jsonl:30 |
| copilot | empty tool input | read_bash | 17 | **unexplained** | run-000195.jsonl:4, run-000195.jsonl:25, run-000195.jsonl:27 |
| copilot | empty tool input | stop_bash | 1 | **unexplained** | run-000196.jsonl:99 |

## Cause and fix per group (agents.mjs)

| group | native event had | cause | fix |
|---|---|---|---|
| agy view_file / replace_file_content input | `AbsolutePath`, `TargetFile` | runs before #148 (no path mapping) | already fixed by #148; now also `nativeInput` aliases |
| agy manage_task / schedule / invoke_subagent input | `Action`, `TaskId`, `DurationSeconds`, `TimerCondition`… | `toolInputSummary` kept only 11 known keys, dropped the rest | a tool with none of the known keys keeps all its fields; stream params missing → args from the saved step (conversations/<id>.db) |
| agy Bash result | `output.txt`: "The command exited with code N. Stdout: …" | stream has no output for silent/async commands and no exit code (`false` looked like success) | read the step's output.txt (else DB) read-only: exit code → isError, output text |
| agy replace_file_content result | diff in output.txt | stream sends no output for edits | same saved-step output |
| claude Skill / TaskStop input | `{skill}`, `{task_id}` | unknown keys dropped | keep-all fallback |
| claude Read result | image block | only text blocks became text | `(image)` (image event still follows) |
| claude ToolSearch result | `tool_reference` blocks | only text blocks became text | "Loaded tool X" (also in server.mjs chat path) |
| codex WebSearch input+result | `query` empty; query/url in `action`, `results` | announced at item.started before the query existed; result ignored | announce on completion when started has no args; query from action (search/open_page/find_in_page); result from results or action |
| codex Bash result | aggregated_output "" (silent command) or exit_code ≠ 0 | empty text passed through | `(no output)` / `(exit code N, no output)`; also stdout/stderr/formatted_output |
| copilot apply_patch input | raw patch string | string args dropped | `{file_path: patched files, content: patch}` |
| copilot read_bash / stop_bash input | `{shellId, delay}` | unknown keys dropped | keep-all fallback |
| (found live) copilot/opencode `false` result | `shellExecution.exitCode` / `metadata.exit` 1 | exit code ignored → isError false | exit code ≠ 0 → isError |
| (found live) opencode edit input | `oldString`/`newString` | camelCase keys dropped | snake_case + aliases |
| kiro (unverified, signed out) | ACP rawInput later / `locations` / nested content | announced before rawInput; nested content blocks ignored | wait for args, locations → file_path, nested content text |

Shared helpers: `nativeInput` (JSON-string args, `parameters`/`arguments`/`input` wrappers, snake_case, aliases for
AbsolutePath/TargetFile/CommandLine/cmd/filePath/paths/…), `toolInputSummary` keep-all fallback, `outputText` (strings,
content arrays incl. ACP nesting, stdout/stderr, aggregated/formatted output), `toolResult` (never empty text).

Empty final reply (`runAgentCli` → `finishEmpty`): an ok run with no final text takes the last assistant text; with none
but tool calls it gets "(No final reply from <agent>; summary synthesized by agent-orch) Used N tool calls: …" (also emitted
as a text event, `res.synthesized`); a run with neither is `outcome: 'error'`, `errorCode: 'empty_response'`.

Regression fixtures: test/fixtures/empty-events/ (one per agent, see its README), test/empty-events.test.mjs (invariant:
a native call with arguments never yields an empty input; every tool gets exactly one announcement and a non-empty result).

## After (new smoke runs, 2026-09-26 19:30–19:55 UTC, with the fixes)

`node bin/agent-smoke.mjs --agent <a> --model <m> --log <dir>` then `node bin/empty-scan.mjs --runs <dir>` (the scan
checks every empty input against the native events the smoke saved next to it):

| agent (model) | smoke | tool calls | tool results | empty events | unexplained |
|---|---|---|---|---|---|
| claude (haiku) | 8/10, then 2/2 on rerun* | 43 | 49 | 0 | 0 |
| codex (gpt-5.5) | 10/10 | 16 | 16 | 0 | 0 |
| antigravity (gemini-3.8-flash-low) | 10/10 | 15 | 15 | 0 | 0 |
| opencode (opencode/big-pickle) | 10/10 | 23 | 23 | 0 | 0 |
| copilot (auto) | 10/10 | 18 | 18 | 0 | 0 |
| kiro | not run: signed out on this VM (covered by the ACP-shaped fixture only) | | | | |

\* grep and npm-test failed only because /tmp hit its per-user quota mid-run (every Bash call returned EDQUOT); both
passed on rerun. Claude shows more results than calls because sub-agent tool results are logged while sub-agent calls
are not (pre-existing, not an empty event). Live agy now marks a failing `npm test` run_command as an error (exit code
from output.txt) and shows edit diffs where the stream had nothing.
