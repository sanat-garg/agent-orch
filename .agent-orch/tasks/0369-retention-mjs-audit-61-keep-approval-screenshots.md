# Task #369: retention.mjs AUDIT #61: keep approval screenshots and review shots, prune stale uploads

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:54  
- files: retention.mjs, test/retention.test.mjs

## Prompt

Reliability fix in retention.mjs (AUDIT #61 in .agent-orch/AUDIT.md; do NOT edit AUDIT.md, it is held by another task). Today gcRetention keeps a media file only when its 64-hex id appears in <DATA>/logs or a surviving run log, so a local run's approval screenshots (approvals.mjs host() → saveMedia, referenced only by the `approvals.screenshot` column and <DATA>/audit/<task>.jsonl) are deleted after mediaDays even while the approval is pending, and checkpoint/review screenshots kept in tasks.result JSON are not scanned either. Also <DATA>/uploads/<id>/ (uploads.mjs, 24-hex ids) is never pruned. Change gcRetention so that: (1) ids are also collected from <DATA>/audit/*.jsonl (scanDir), from `SELECT screenshot FROM approvals WHERE screenshot IS NOT NULL` when the db has that table (wrap in try: an old DB has none), and from tasks.result of tasks whose status is not finished plus any result containing 64-hex ids of review tasks (simplest: scan the `result` column of all tasks with the same regex, bounded); (2) after media, prune <DATA>/uploads/<id> directories (UPLOAD_ID_RE from uploads.mjs) whose meta.json `at` (or the dir mtime) is older than mediaDays and whose 24-hex id appears in no chat log under <DATA>/logs (reuse the same scan with a second regex for 24-hex ids); count them in a new `uploads` field and their bytes in `bytes`. Keep the function synchronous and never-throwing per file. Update the header comment. Tests in test/retention.test.mjs: a media file 8 days old referenced only by audit/12.jsonl survives; one referenced only by the approvals table survives; an unreferenced one goes; an uploads dir 8 days old referenced by no log is removed and one referenced by a chat log stays. Note: task #328 attempted this and failed only in worker setup (a git fetch race), not in the work; this task is the same content. Run only `npm test -- test/retention.test.mjs` while working.

## Done when

`npm test -- test/retention.test.mjs` passes and `grep -q 'uploads' retention.mjs`
