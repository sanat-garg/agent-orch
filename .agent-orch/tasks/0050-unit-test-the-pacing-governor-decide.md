# Task #50: Unit-test the pacing governor decide()

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 04:05  
- starts after: #49

## Prompt

In /home/ubuntu/agent-orch, orchestrator.mjs has an unexported pure function `decide(limits, t, hasUrgent)` (around line 606, section 'pacing'). It turns usage-limit rows ({limit_type:'seven_day'|'five_hour', utilization 0..1, resets_at, observed_at} in epoch seconds) into {allowed, concurrency, cooldown, pushHarder, scarce, reason}. It has no tests. Export it; a named export is enough, and don't change its behaviour. Add test/pacing.test.mjs (node:test, like the other files in test/). Read the function first, then write tests that pin down the current behaviour: no data gives the default pace; weekly use near reset spends the leftover; the high-weekly tiers allow urgent only when urgent work waits, otherwise urgent+normal; background is paused at the background_stop tier; a 5h window under-used late in the window sets pushHarder; a high 5h utilisation drops concurrency to 1; readings older than 5h/7d are disregarded, and the reason says so; stale (>15 min) readings add a note. If a test exposes a real bug, fix it minimally and say so in the commit message. Don't restart the live server.

## Done when

`npm test` passes and test/pacing.test.mjs exists with at least 8 tests calling decide()
