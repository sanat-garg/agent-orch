# Task #40: Skip corrupt JSONL lines instead of blanking chat and task logs (AUDIT #13)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:50  
- starts after: #39

## Prompt

Fix AUDIT #13 in /home/ubuntu/agent-orch. `readLog` in server.mjs (around line 165) and `taskDetail` in orchestrator.mjs (around line 1649) do `.map((l) => JSON.parse(l))` inside one try, so one partial or corrupt line returns an empty history. Parse each line in its own try and drop bad lines, like `loadSeries` in server.mjs (around line 314: `map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)`). Consider a tiny shared helper if it stays readable, but don't add new files just for this. Add a regression test: either export a small pure helper and unit-test it (a new test/jsonl.test.mjs), or extend test/server.test.mjs to write a chat log with a corrupt middle line into the temp CW_DATA_DIR and check that the other entries still load. Name the test so it contains the phrase 'corrupt line'. Mark AUDIT #13 `**Fixed**` in .agent-orch/AUDIT.md.

## Done when

`grep -rq 'corrupt line' test` and `npm test` passes

## Result — done (check passed) (2026-09-25 03:52)

AGENT-ORCH-STATUS: done — Corrupt JSONL lines are skipped; chat and task logs still load
