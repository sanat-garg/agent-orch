# Task #286: finishReflection: a reflection with no task block is a warning and a quick retry, not an empty verdict

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 08:13  
- files: orchestrator.mjs, test/reflect-fallbacks.test.mjs

## Prompt

In orchestrator.mjs `finishReflection` (about line 3218) uses `extractTasks(res.text)`, which returns payload `null` both when the reply has no ```agent-orch-tasks block at all (or the JSON does not parse) and when nothing was queued. Today both cases are treated as 'reflection found nothing valuable', the kv `reflect_empty_streak:<project>` is bumped and `reflectCooldown` backs off (reflection #284 lost two hours this way after ending its turn without a block). Change it so that when `payload === null` (no block or unparsable block): log an event at level 'warn' (or 'error' if there is no warn level; check `logEvent`) reading `reflection #<id> ended without a task block; retrying in 5 min`, do NOT change the empty streak, set `next_reflect_at` to now + 300 s, still mark the task done and commit the roadmap as before, and send the convo a `notice` saying the reflection ended without a task list and will retry. An explicit block with `"tasks": []` keeps the current behaviour (streak bump, cooldown, 'found nothing valuable'). Keep the change small and in the terse style of the file. Add one test to test/reflect-fallbacks.test.mjs next to its existing reflection tests (they use `createOrchestrator` with a fake `query`): a reflection whose reply has no block leaves `reflect_empty_streak` untouched and sets `next_reflect_at` within ~300 s of now, while a reply with an empty tasks list bumps the streak. Do not restart or touch the live server on port 3000.

## Done when

`grep -q 'ended without a task block' orchestrator.mjs` and `npm test -- test/reflect-fallbacks.test.mjs`

## Result — done (check passed) (2026-09-28 08:14)

AGENT-ORCH-STATUS: done — blockless reflections now warn and retry in 5 min, tested
