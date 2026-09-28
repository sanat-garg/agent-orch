# Task #483: Files backend: upload files and folders

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 18:10  
- files: files.mjs, server.mjs, test/files-upload*.test.mjs

## Prompt

Add an upload endpoint for the Files tab (files.mjs + server.mjs, login-protected, the same path and write rules as #403/#437: writes are allowed only under the project, home and /tmp, and protected files are never overwritten). Contract (the UI task codes against it): POST /api/files/upload?dir=<abs|rel>&path=<relative path inside the upload, e.g. 'folder/sub/a.txt'>&overwrite=0|1 with the raw file body (streamed to disk, never buffered whole; max 2 GB per file), creating intermediate folders for folder uploads. The response is {saved: path} or 409 {error:'exists', path} when overwrite=0 and the file exists. Keep filenames safe (reject '..', absolute paths and NUL). Tests: upload into a subfolder, a nested folder path creates dirs, the 409 on an existing file without overwrite, and a write outside the allowed roots is refused. Run only the touched test files.

## Done when

`node --test test/files-upload*.test.mjs` passes (subfolder upload, nested path mkdir, 409 without overwrite, disallowed root refused)

## Result — done (check passed) (2026-09-28 18:11)

AGENT-ORCH-STATUS: done — Streamed, login-protected Files upload endpoint works; its tests pass
