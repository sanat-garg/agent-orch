# Task #328: Retention GC: prune stale uploads and keep approval screenshots referenced in the DB

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:43  
- files: retention.mjs, test/retention.test.mjs

## Prompt

retention.mjs gcRetention (called from orchestrator.mjs retentionGc at boot and daily with {dataDir, runsDir, db}) prunes old run logs and media older than mediaDays whose 64-hex id appears in no chat log or surviving run log. Two gaps: (1) composer attachments in <DATA>/uploads/<id>/ (uploads.mjs: id = 24 hex, UPLOAD_ID_RE; each dir holds the file plus meta.json) are never pruned, so they pile up forever; (2) approval screenshots are stored as media ids in the orchestrator DB's `approvals.screenshot` column (approvals.mjs), and a screenshot referenced only there (e.g. a browser task's approval whose run log was pruned, or a run log written before the shot) is deleted after 7 days. Implement: a new option `uploadDays = 30`; after the media pass, list <DATA>/uploads/<id> dirs (UPLOAD_ID_RE names only), and delete each whose newest mtime is older than uploadDays and whose id appears in no chat log under <DATA>/logs (scan the same way as media ids: collect every 24-hex token too, in one pass over the logs, so the logs are read once); count them in a new `uploads` field and their bytes in `bytes`. For approvals: if `db` has an `approvals` table (check sqlite_master), add every non-null `screenshot` to the protected ids before the media pass. Update the header comment. Add tests to test/retention.test.mjs following the existing setup (temp dataDir, in-memory DatabaseSync, utimesSync for ages): an old unreferenced upload dir is removed, an old upload named in a chat log stays, a recent one stays, and an old media file referenced only by approvals.screenshot survives while an unreferenced one goes. Keep the result shape backwards compatible ({runs, media, uploads, bytes}).

## Done when

`npm test -- test/retention.test.mjs` passes and `grep -n 'uploadDays' retention.mjs` prints a line.
