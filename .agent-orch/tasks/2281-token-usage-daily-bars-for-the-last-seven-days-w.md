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
