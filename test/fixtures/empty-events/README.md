# Empty-event regression fixtures (task #196)

Native CLI events for bugs where a normalised tool input came out `{}`, a tool result `""`, or a run had no final text.
test/empty-events.test.mjs replays each file through its adapter's `events` normaliser.

- `antigravity.jsonl` + `antigravity-native.json`: recorded `agy -p --output-format stream-json` run (2026-09-26). The stream
  drops run_command's exit code and edit tools' output; the native side file holds what agy saved for each step
  (brain/<id>/.system_generated/steps/<i>/output.txt and the step's call arguments from conversations/<id>.db).
- `antigravity-run136.jsonl`: run 136's manage_task/schedule/view_file calls (logged as `{}`), rebuilt from the steps agy saved.
- `copilot.jsonl`: recorded `copilot -p --output-format json` run (apply_patch's arguments are the raw patch string; shell exit codes).
- `opencode.jsonl`: recorded `opencode run --format json` run (edit's oldString/newString, bash metadata.exit).
- `claude.jsonl`: Agent SDK blocks from run logs 1/43/82/153 (Skill, TaskStop, ToolSearch tool_reference results, Read of an image).
- `codex.jsonl`: `codex exec --json` shapes for the run 139/140 web_search (query only in `action` on completion) and silent or
  failed commands; web_search built from the saved rollout's item (codex was rate limited when these were recorded).
- `kiro.jsonl`: ACP-shaped (Kiro is signed out here): a tool_call whose rawInput arrives in a later update, `locations`,
  nested content blocks, rawOutput exit codes.
