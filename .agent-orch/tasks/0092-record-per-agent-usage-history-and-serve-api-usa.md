# Task #92: Record per-agent usage history and serve /api/usage/history

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 10:31  
- starts after: #90

## Prompt

Build the data layer for a usage-over-time view. Today server.mjs (~lines 463-583) fetches Claude's current plan windows (five_hour / seven_day / model-scoped utilization + resets_at) but keeps no history. 1) Add usage.mjs with an append-only store at <DATA>/metrics/usage.jsonl (respect CW_DATA_DIR) and three record kinds: {t, agent, kind:'window', window:'five_hour'|'seven_day'|<model>|..., pct, resetsAt} written whenever limits are fetched (dedupe: skip if unchanged within 5 min); {t, agent, kind:'tokens', input, output, cached, source:'chat'|'task', ref} written after every chat turn and orchestrator run from the normalised result usage of ANY adapter (claude/codex/antigravity via agents.mjs); and {t, agent, kind:'limit', status:'hit'|'cleared', resetsAt, window?} written when an adapter reports rate_limited and when the per-agent block clears. 2) Keep 30 days and compact older lines on startup. 3) GET /api/usage/history?range=24h|7d|30d (login-protected) returns, per agent: window series (downsampled to ≤300 points each), tokens bucketed per hour (24h) or per day (7d/30d), limit events, and the current status (latest pct/resetsAt per window, blocked or not). Tests with CW_DATA_DIR=$(mktemp -d): store round-trip, bucketing and downsampling, and the endpoint's shape and auth.

## Done when

`npm test` passes with usage.mjs store/bucketing tests and an /api/usage/history endpoint test
