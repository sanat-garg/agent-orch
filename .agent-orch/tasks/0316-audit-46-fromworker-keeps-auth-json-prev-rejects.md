# Task #316: AUDIT #46: fromWorker keeps auth.json.prev, rejects a future last_refresh and checks the token's account

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:34  
- files: agent-share.mjs, test/agent-share.test.mjs, .agent-orch/AUDIT.md

## Prompt

Fix AUDIT.md finding #46 in agent-share.mjs `fromWorker(nodeId, msg)` (around line 80). Today a worker's Codex `auth.json` is adopted when it parses as a ChatGPT login with the head's `account_id` and a later `last_refresh`; nothing else is checked and the old file is overwritten. Change: (1) reject when `theirs.lastRefresh` is more than 5 minutes in the future (`{ignored: 'last_refresh is in the future'}`); (2) decode the JWT payload (base64url middle segment, no signature check) of `tokens.id_token` or `tokens.access_token` and require its `chatgpt_account_id` (or the account id under `https://api.openai.com/auth`, whichever `parseCodexAuth` or the real file uses: read a real auth.json's shape from the existing tests/fixtures) to equal the head's `account_id`; a token that does not decode or names another account is `{ignored: 'token does not belong to this account'}`; (3) before `writePrivate(codexFile, msg.value)`, copy the current file to `codexFile + '.prev'` (owner-only mode) so a bad adoption can be undone by hand. Update the header comment. Extend the 'Codex: ... a worker's refresh is adopted only when...' test in test/agent-share.test.mjs: a future `last_refresh` is ignored, a mismatched JWT account is ignored, a good refresh is adopted and leaves `auth.json.prev` holding the previous text. Mark #46 **Fixed** in .agent-orch/AUDIT.md with a one-line note.

## Done when

`node --test test/agent-share.test.mjs` passes and `grep -n 'auth.json.prev' agent-share.mjs` prints a line

## Result — done (check passed) (2026-09-28 12:34)

AGENT-ORCH-STATUS: done — fromWorker blocks future/mismatched-JWT refreshes and keeps auth.json.prev
