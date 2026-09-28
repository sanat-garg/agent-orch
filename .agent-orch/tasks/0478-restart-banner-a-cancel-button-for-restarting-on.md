# Task #478: Restart banner: a Cancel button for 'Restarting once idle'

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 18:10  
- files: restart.mjs, server.mjs, public/app.js, test/restart-cancel*.test.mjs

## Prompt

The updates banner that says 'Restarting once idle (automatic)…' (or the rolling-restart equivalent 'restarting in 30 s / waiting…') needs a 'Cancel' button. Clicking it calls a new POST /api/restart/cancel (login-protected) that cancels the pending restart (the rolling timer or idle drain; undrain so claiming resumes at once), and the banner changes to 'Update ready: vX.YY · Restart now', with the restart deferred until the owner clicks Restart now or new server code lands again (a new commit re-arms the automatic restart unless 'Apply updates' is Manual). Log the cancel as an event. Tests: cancel stops a scheduled rolling restart and resumes claiming; the banner shows the deferred state; a new commit re-arms. Run only the touched test files.

## Done when

`node --test test/restart-cancel*.test.mjs` passes (cancel stops the restart and resumes claims, banner deferred state, re-arm on a new commit)
