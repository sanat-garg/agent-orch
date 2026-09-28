# Task #406: Show the running build number, restart time and pending build

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 13:53  
- files: version.mjs, server.mjs, public/app.js, public/index.html, public/app.css, test/version*.test.mjs

## Prompt

Show which version is running and since when. 1) Server (server.mjs, plus a small version.mjs): capture at boot the running build: build number = `git rev-list --count HEAD`, short sha, commit subject and commit time, plus the process start time (and the systemd ActiveEnterTimestamp if available). Compute on request the build on disk (the current HEAD of the live checkout: the number, sha, and how many commits newer than the running one), and reuse the restart-when-idle / auto-restart state if present (pending, waiting for idle). GET /api/version (login-protected) → {running:{build, sha, subject, committedAt, startedAt}, disk:{build, sha, ahead}, restart:{pending, reason}}. Include the running build in the existing hello/state message so the UI updates after a restart without a reload, and include workers' reported agent-orch sha/build from their inventory in GET /api/cluster/nodes. 2) UI: the Settings sheet gets an 'About' section: 'Running build 412 (a1b2c3d) · "<commit subject>"', 'Restarted <relative time> (<local date/time>) · up 2h 14m', and, when disk.ahead > 0, 'Build 419 ready (7 newer commits) · restarts when idle' (or a 'Restart now' button if the restart-when-idle feature offers one). The sidebar footer shows a subtle 'build 412' label (tap opens About). The Machines view shows each worker's build next to its name, with an 'outdated' tag if it's behind the head. Times use the browser's timezone. 3) After an auto-restart, show a toast 'Updated to build 419'. Tests: /api/version reports a build number matching `git rev-list --count HEAD` and a startedAt; ahead counts new commits in a temp repo; the UI renders the About lines from a mocked response. Run only the touched test files.

## Done when

`node --test test/version*.test.mjs` passes (build number equals the git commit count, startedAt present, ahead computed, About renders), and the Settings sheet has an About section
