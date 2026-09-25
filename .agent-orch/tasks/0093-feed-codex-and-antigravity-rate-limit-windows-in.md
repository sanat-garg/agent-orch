# Task #93: Feed Codex and Antigravity rate-limit windows into usage history

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 10:31  
- starts after: #92

## Prompt

Get real limit windows (not just tokens) for the non-Claude agents into usage.mjs (from the previous task). Codex: its JSON/exec event stream and protocol include rate-limit snapshots (look for token_count / rate_limits events with primary/secondary used_percent, window_minutes and resets_in/resets_at; check the codex binary/docs on this machine and .agent-orch/AGENTS.md). Parse them in the codex adapter in agents.mjs and record window points ('5h'/'weekly' using window_minutes). Also parse 'try again at <time>' into limit events. Antigravity: find out whether agy exposes quota/usage (a command like `agy usage`/`agy quota`, a status JSON, or fields in result events). If it does, record window points. If not, record only tokens plus the limit hit/clear events from RESOURCE_EXHAUSTED/quota errors, and write that finding into .agent-orch/AGENTS.md. Add adapter tests with recorded event fixtures containing rate-limit snapshots.

## Done when

`npm test` passes with a codex fixture test asserting that the rate-limit snapshot becomes usage window points, and .agent-orch/AGENTS.md states what usage data agy exposes

## Result — done (check passed) (2026-09-25 13:40)

AGENT-ORCH-STATUS: done — Codex and agy usage windows now recorded; npm test passes
