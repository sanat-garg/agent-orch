# Task #2281: Token usage: daily bars for the last seven days, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:41  
- files: chat-usage.mjs, public/tokens.js, public/tokens.css, test/chat-usage.test.mjs, test/ui-tokens-daily.test.mjs

## Prompt

Goal: the token usage sheet's 'Last 7 days' view (public/tokens.js, from #2266) shows a small bar chart of tokens per day for the last seven days (chat, and on a project's main chat its tasks stacked or side by side), like opcode's usage dashboard (github.com/winfunc/opcode).

Backend: chat-usage.mjs chatUsage adds recent.hours: [{ t, chat, tasks }] where t is the start of each UTC hour (epoch ms) in since..until and chat/tasks are token totals (input+output+cached, same tokens the existing sums count) for that hour; only non-empty hours, sorted by t; tasks is 0 when there are no task refs. The server never formats times (CONTEXT.md), so the browser groups hours into the owner's local days. The route (server.mjs ~2285) spreads chatUsage's output already; don't edit server.mjs.

UI: in Last 7 days, above the totals, seven bars labelled with short local weekday names (today last), height relative to the busiest day, each with an accessible label like 'Mon: 1.2M tokens' (reuse fmtTok). All-zero week → 'No tokens in the last seven days'. Plain DOM/CSS bars, no chart library; colours from existing CSS variables; legible on phones (public/tokens.css).

Tests: extend test/chat-usage.test.mjs with a case that records in two different hours produce two hours entries with the right sums and records older than seven days are excluded; new test/ui-tokens-daily.test.mjs (copy the setup of the existing tokens UI test) checks seven bars render from stubbed data and the empty message for an all-zero week.

## Done when

`npm test -- test/chat-usage.test.mjs test/ui-tokens-daily.test.mjs` passes.

## Result — verify failed (1) (2026-10-19 16:09)

Command: npm test -- test/chat-usage.test.mjs test/ui-tokens-daily.test.mjs


> agent-orch@1.0.0 test
> node bin/test.mjs test/chat-usage.test.mjs test/ui-tokens-daily.test.mjs

npm test: 2 of 247 test files, named on the command line. `npm run test:full` runs them all.
TAP version 13
# Subtest: lifetime totals per chat and task are kept, rebuilt from the jsonl, and merged
ok 1 - lifetime totals per chat and task are kept, rebuilt from the jsonl, and merged
  ---
  duration_ms: 164.185451
  type: 'test'
  ...
# Subtest: a chat is compared with each weekly window, sized from the reading
ok 2 - a chat is compared with each weekly window, sized from the reading
  ---
  duration_ms: 88.20459
  type: 'test'
  ...
# Subtest: recent totals cover only the supplied refs' turns from now minus seven days through now
ok 3 - recent totals cover only the supplied refs' turns from now minus seven days through now
  ---
  duration_ms: 240.98636
  type: 'test'
  ...
# Subtest: recent hours hold each UTC hour's plain tokens for the chat and its tasks, only inside the seven days
ok 4 - recent hours hold each UTC hour's plain tokens for the chat and its tasks, only inside the seven days
  ---
  duration_ms: 224.582643
  type: 'test'
  ...
# Subtest: Last 7 days draws seven local-day bars, today last, chat and tasks stacked, scaled to the busiest day
not ok 5 - Last 7 days draws seven local-day bars, today last, chat and tasks stacked, scaled to the busiest day
  ---
  duration_ms: 20060.051878
  type: 'test'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2281/test/ui-tokens-daily.test.mjs:108:1'
  failureType: 'hookFailed'
  error: |-
    server did not start:
    [push] made a new VAPID key pair
    [orchestrator] disabled (CW_NO_ORCHESTRATOR=1): not requeueing or scheduling tasks
    
  code: 'ERR_TEST_FAILURE'
  stack: |-
    Timeout._onTimeout (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-2281/test/ui-tokens-daily.test.mjs:49:43)
    listOnTimeout (node:internal/timers:585:17)
    process.processTimers (node:internal/timers:521:7)
  ...
# Subtest: an all-zero week shows one empty message instead of bars
not ok 6 - an all-zero week shows one empty message instead of bars
  ---
  duration_ms: 32.072229
  type: 'test'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2281/test/ui-tokens-daily.test.mjs:127:1'
  failureType: 'hookFailed'
  error: |-
    server did not start:
    [push] made a new VAPID key pair
    [orchestrator] disabled (CW_NO_ORCHESTRATOR=1): not requeueing or scheduling tasks
    
  code: 'ERR_TEST_FAILURE'
  stack: |-
    Timeout._onTimeout (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-2281/test/ui-tokens-daily.test.mjs:49:43)
    listOnTimeout (node:internal/timers:585:17)
    process.processTimers (node:internal/timers:521:7)
  ...
1..6
# tests 6
# suites 0
# pass 4
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 31805.941183

## Result — done (check passed) (2026-10-19 16:19)

The Done-when command passes on two consecutive runs. The cause was the test fixture's 20s server-boot timeout, which a cold boot exceeds when other sessions saturate the single core. The fixture now allows 90s for boot and 60s for page waits, and the gotcha is recorded in CONTEXT.md.

AGENT-ORCH-STATUS: done — Daily token bars shipped; fixture boot waits survive load
