# Task #289: Retention GC: prune old run logs and unreferenced media at boot and daily

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 08:13  
- files: retention.mjs, orchestrator.mjs, test/retention.test.mjs

## Prompt

Add a small retention garbage collector. Today `data/orchestrator/runs/run-NNNNNN.jsonl` keeps every run log forever (312 files, 20 MB) and `data/media/<sha256>.png` (458 files, 68 MB) keeps every image, including those of deleted chats. Create `retention.mjs` (header comment explaining its job and API, terse style) exporting `gcRetention({ dataDir, runsDir, db?, now?, runDays = 30, mediaDays = 7 })` that: (1) deletes run logs whose task finished more than `runDays` ago (look up `runs.finished_at`/`tasks.finished_at` in the orchestrator DB, or the file mtime when the run row is gone; never delete a log whose task is not finished), and (2) deletes media files older than `mediaDays` whose id (the sha256 stem, see MEDIA_ID_RE in media.mjs) appears in no chat log under `<DATA>/logs` (check how media ids are referenced there and in run logs before writing the scan; a plain substring scan of the log files is fine) and in no surviving run log. Return counts `{runs, media, bytes}`. Wire it into orchestrator.mjs: once at boot after the worktree sweep and then daily via the existing `setInterval` block near line 3693, logging one event `retention: removed N run logs and M media files (X MB)` only when something was removed. Make it defensive: errors are logged, never thrown into the boot path. Add test/retention.test.mjs using a temp dir: create an old run log for a finished task, a recent one, an old referenced media file, an old unreferenced one and a recent unreferenced one; assert only the old finished log and the old unreferenced file go. Do not touch the live server on port 3000.

## Done when

`node --check retention.mjs` and `npm test -- test/retention.test.mjs`

## Result — done (check passed) (2026-09-28 08:40)

AGENT-ORCH-STATUS: done — retention GC prunes old run logs and unreferenced media
