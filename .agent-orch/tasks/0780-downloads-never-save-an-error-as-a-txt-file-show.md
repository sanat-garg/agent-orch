# Task #780: Downloads never save an error as a .txt file; show the error instead

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 23:20  
- files: files.mjs, public/files.js, test/files-download*.test.mjs, test/ui-files-download*.test.mjs

## Prompt

When GET /api/files/download fails (e.g. a 404 while the running server is older than the UI, or a 403/413 error), the Files tab's hidden <a download> (public/files.js ~line 1138-1141, fxDownloadUrl) saves the JSON error body as a .txt file, which the owner saw as 'downloading downloads a txt file'. Fix: 1) Before triggering the native download, preflight with a cheap request: add GET /api/files/download?…&check=1 (files.mjs sendDownload: validate the paths, permissions, protected files and caps, compute the filename and, where cheap, the size, and return JSON {ok:true, name, kind:'file'|'zip', size?} or the error JSON with the same status; no body is streamed). The client calls it with fetch; on ok it triggers the <a download> to the real URL (without check=1); on error it shows a toast with the message ('Download failed: <error>'; for 404 use the friendly 'The server is updating, try again in a moment' from #459's api helper) and doesn't navigate. 2) The server never sends Content-Disposition: attachment on error responses (errors are JSON with no attachment header). 3) Tests: the check endpoint returns ok with a name for a valid multi-selection and an error for a protected path; the client shows a toast and doesn't create the download link when the check fails; a valid selection triggers the download URL. Run only the touched test files.

## Done when

`node --test test/files-download*.test.mjs test/ui-files-download*.test.mjs` passes (check endpoint ok/error, no download link on error, toast shown, valid selection downloads)
