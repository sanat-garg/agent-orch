# Task #2266: Show the last seven days of chat token usage, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:29  
- files: chat-usage.mjs, public/tokens.js, public/tokens.css, test/chat-usage.test.mjs, test/ui-token-range.test.mjs

## Prompt

Add an All time / Last 7 days selector inside the existing Token usage sheet. In chat-usage.mjs, extend chatUsage's response with recent totals for the same supplied chat refs and optional task refs, using recorded usage within now minus seven days through now. Include input, output, cache reads, turns and model breakdowns; exclude unrelated refs. Keep existing lifetime fields unchanged. server.mjs already spreads this result, so no endpoint edits are needed. In public/tokens.js and public/tokens.css, default to All time and switch the sheet's totals, model tables and task totals together. Label the rolling interval clearly, preserve the lifetime header pill and separately labelled weekly-limit estimates, and show an empty state for no recent activity. Keep load errors visible and add no polling or CLI calls. Adapt winfunc/opcode's usage-reporting idea from ROADMAP.md; do not invent prices or quota sizes. Extend test/chat-usage.test.mjs with interval-boundary and reference-isolation coverage, and add test/ui-token-range.test.mjs for switching ranges, empty recent usage and load failure. Use existing localhost test patterns and run only the named checks.

## Done when

`npm test -- test/chat-usage.test.mjs test/ui-token-range.test.mjs test/ui-chat-tokens.test.mjs` passes.

## Result — done (check passed) (2026-10-19 14:36)

AGENT-ORCH-STATUS: done — Token usage sheet has an All time / Last 7 days switch; tests pass
