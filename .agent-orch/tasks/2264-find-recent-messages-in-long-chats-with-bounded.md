# Task #2264: Find recent messages in long chats with bounded search and tests

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:29  
- files: search.mjs, test/search.test.mjs

## Prompt

Fix search.mjs so its bounded log scan searches the newest complete JSONL records rather than only the first maxBytes. Currently a recent matching message beyond the default 4 MB prefix is invisible. Modify only search.mjs and test/search.test.mjs. Preserve the byte budget, title matching, snippets, result ordering, and missing/corrupt-log behavior. Handle a partial leading record and a complete final record without a newline. Update the existing prefix-only test expectation and add a regression proving a recent match beyond the old cap is returned while out-of-window content is excluded. Keep short-log behavior unchanged. This supports the discoverable chat-workspace pattern recorded for siteboon/claudecodeui in ROADMAP.md; borrow ideas only. Run the named search tests, not the full suite.

## Done when

`npm test -- test/search.test.mjs` passes, including the recent-message regression and bounded-read checks.
