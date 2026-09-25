# Task #88: Capture screenshots from agent runs and serve them via /api/media

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 10:18

## Prompt

Backend for showing agent screenshots in chat. 1) Storage: images are saved to <DATA>/media/<sha256>.<ext> (respect CW_DATA_DIR), deduplicated by hash, png/jpeg/webp/gif only, max 10 MB each. 2) Sources: (a) image content blocks inside tool results in chat sessions (server.mjs ~line 715 currently turns them into '[image]') and in orchestrator runs (orchestrator.mjs entriesOf / the agents.mjs normalised events). Decode the base64 and store it. (b) New or modified image files under <project>/.agent-orch/shots/ during a chat turn or a task run: snapshot mtimes at the start and pick up changes at the end of each tool result, or at least at the end of the run. 3) Emit a normalised event {k:'image', id, name, w?, h?} into the chat stream/convo log and the task run log (JSONL), in order next to the tool call that produced it. 4) Add GET /api/media/:id (login-protected; id must match /^[a-f0-9]{64}\.(png|jpe?g|webp|gif)$/, no path traversal) with correct Content-Type and long cache headers. 5) Keep .agent-orch/shots/ out of git by adding it to the project .gitignore rules github.mjs writes. Tests: a unit test for the tool-result image extraction, and a server test that the media endpoint serves a seeded file, rejects '../' and bad ids, and returns 401 without a session. Use CW_DATA_DIR=$(mktemp -d) and never touch the live server.

## Done when

`npm test` passes with the new media-extraction and /api/media tests

## Result — done (check passed) (2026-09-25 10:24)

AGENT-ORCH-STATUS: done — Screenshots are stored and served at /api/media; tests pass
