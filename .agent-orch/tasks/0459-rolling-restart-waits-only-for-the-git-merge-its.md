# Task #459: Rolling restart waits only for the git merge itself, not a whole integrator run

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 15:00  
- files: orchestrator.mjs, restart.mjs, server.mjs, public/app.js, test/rolling-restart*.test.mjs, test/ui-api-404*.test.mjs

## Prompt

The rolling restart (#426/#446) stalls behind integrator tasks. The live log on 2026-09-28: '14:54:27 [restart] rolling: 1 server file(s) changed since boot (files.mjs); restarting in 30 s' then '14:54:57 [restart] rolling: waiting (integrator #448 is merging)', still waiting at 14:59 while #448's AGENT session ran for 11+ minutes. So new features stayed 404 in the UI (e.g. #444's /api/cluster/nodes/:id/assignable → 'Couldn't load the ready tasks: Request failed (404)'). In orchestrator.mjs, restartBlocker() (~line 2700) treats any running integrator as 'merging', and prepareRestart skips pausing integrators. Fix: 1) Track the actual git critical section (the merge/rebase/fast-forward/push of main in merge-back and integrator landing; there's likely a gitChains map or a per-project merge lock) and make restartBlocker return a reason ONLY while such a critical section is in flight. It should last seconds, and the wait is capped at 60 s. 2) Integrator agent sessions are paused like other head work before a restart (session and worktree kept, via the kv restart_paused list) and resumed after boot, re-running their check and landing afterwards. 3) If a critical section somehow exceeds 60 s, log it and restart anyway after it finishes, never waiting indefinitely. 4) Client side: when the UI gets a 404 from an endpoint that the served app.js expects (i.e. the server is older than the client), show 'The server is updating, try again in a moment' instead of a raw 'Request failed (404)', and retry once the WebSocket hello reports a newer build. Implement this in the shared api() helper in public/app.js for 404s on /api/ routes. 5) Tests: a restart with a long-running integrator agent session proceeds within 60 s (the integrator is paused and resumed); a restart waits for an in-flight git merge and then proceeds; the client shows the friendly message for a 404 on /api/ and retries after the hello. Run only the touched test files.

## Done when

`node --test test/rolling-restart*.test.mjs test/ui-api-404*.test.mjs` passes (restart not blocked by an integrator session, waits only for the git critical section, friendly 404 with retry)
