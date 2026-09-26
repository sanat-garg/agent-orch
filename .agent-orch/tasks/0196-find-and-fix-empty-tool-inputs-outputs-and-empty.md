# Task #196: Find and fix empty tool inputs/outputs and empty responses from CLI agents

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 14:32  
- files: agents.mjs, .agent-orch/EMPTY-EVENTS.md, test/agents-empty*.test.mjs, test/fixtures/empty-*

## Prompt

The owner sees agents' commands or results come back as "" or {} when they shouldn't (e.g. earlier the agy view_file input was normalised to {} although the native call had AbsolutePath). Systematically: 1) Scan every run log (data/orchestrator/runs/*.jsonl, read-only) and chat logs (data/logs/*.jsonl) for normalised events with an empty or {} tool input, an empty tool_result text where the native event had output, an empty final text, or tool names without arguments. Group them by agent and event type, and record the counts in .agent-orch/EMPTY-EVENTS.md. 2) For each group, compare against the native CLI event (codex exec JSON, agy stream-json plus its conversation SQLite read-only, opencode, kiro, copilot SDK events, Claude SDK messages) and fix the normaliser in agents.mjs: map every field name variant (AbsolutePath/path/file_path, CommandLine/command, nested parameters/arguments objects and JSON-encoded argument strings), keep tool output from all the places it can live (output, content arrays, stdout/stderr, aggregated deltas), and never emit {} when the native args are non-empty. 3) If an agent itself returns an empty final response while the work was done, fall back to the last non-empty assistant text or a short synthesized summary of the tools used (marked as such), and treat a genuinely empty run as an error with a clear message, not success. 4) Add a regression fixture per bug (recorded real events, with no secrets), and add a normaliser invariant test: for every fixture, a native event with arguments never produces empty input. Re-run the scan after the fixes against new smoke runs (`node bin/agent-smoke.mjs` for each signed-in agent) and show zero unexplained empties.

## Done when

`npm test` passes with the per-agent empty-event regression fixtures, and .agent-orch/EMPTY-EVENTS.md shows the before/after counts, with zero unexplained empties in the new smoke runs

## Result — done (check passed) (2026-09-26 20:27)

AGENT-ORCH-STATUS: done — empty events fixed; fixtures pass; smoke runs show zero unexplained empties
