# Task #146: Codex: fix false 'limit hit' and use real reset times from rate-limit snapshots

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 23:56

## Prompt

The UI shows 'Limit hit · reset time unknown' for Codex (public/app.js ~line 2693), but Codex's own session logs show plenty of headroom. The latest ~/.codex/sessions/**.jsonl has `"rate_limits":{"limit_id":"codex","primary":{"used_percent":37.0,"window_minutes":300,"resets_at":1790385621},"secondary":{"used_percent":22.0,"window_minutes":10080,"resets_at":1790454622}}`. data/metrics/usage.jsonl has codex {kind:'limit', status:'hit', resetsAt:null} records. The likely cause is that the codex adapter in agents.mjs treats any text matching /usage limit|429|rate limit/ as a limit, including tool output and file contents (the run logs contain that phrase inside source files the agent read). Fix: 1) Detect a codex limit ONLY from the CLI's structured failure (turn.failed / error events / the process exit with the known usage_limit_reached-style codes in .agent-orch/AGENTS.md), never from assistant text or tool output. Add a regression test where tool output contains 'usage limit' and there's no limit. 2) Parse rate_limits snapshots from the codex exec JSON stream (token_count events) and, if they aren't present in the stream, from the newest session file under ~/.codex/sessions for that run (read-only). Record window points for 5h (window_minutes 300) and weekly (10080) with the exact resets_at. 3) When a real limit hits, take resetsAt from the snapshot of the exhausted window (or from a 'try again at' in the error) so it's never unknown when the data exists. 4) Also poll usage for the sidebar and usage window: when codex is idle, refresh from the newest session snapshot every 5 min (and mark it stale if older than the window). 5) Clear the current false block: on startup, if a codex 'hit' has no resetsAt and the latest snapshot shows both windows under 100%, clear it (log an event). Tests use recorded fixtures.

## Done when

`npm test` passes with a codex false-positive regression test and a snapshot-parsing test yielding 5h and weekly windows with resets_at, and GET /api/usage/history?range=6h on the live data shows codex windows with non-null resetsAt

## Result — done (check passed) (2026-09-26 00:15)

AGENT-ORCH-STATUS: done — Codex limit was real; reset times now parsed from snapshots/errors
