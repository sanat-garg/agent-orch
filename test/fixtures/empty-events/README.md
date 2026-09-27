# Empty-event regression fixtures (task #196)

Native CLI events for bugs where a normalised tool input came out `{}`, a tool result `""`, or a run had no final text.
test/empty-events.test.mjs replays each file through its adapter's `events` normaliser.

- `claude.jsonl`: Agent SDK blocks from run logs 1/43/82/153 (Skill, TaskStop, ToolSearch tool_reference results, Read of an image).
- `codex.jsonl`: `codex exec --json` shapes for the run 139/140 web_search (query only in `action` on completion) and silent or
  failed commands; web_search built from the saved rollout's item (codex was rate limited when these were recorded).
