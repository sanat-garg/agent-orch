# Task #233: Worker 'now doing' status screen in the app's design theme

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-27 12:48  
- starts after: #232, #229  
- files: worker.mjs, worker-status.html, public/theme.css, public/app.css, bin/install-worker-macos.sh, test/worker-status*.test.mjs

## Prompt

Give each worker machine a read-only status screen showing what it's doing right now, matching agent-orch's design exactly. 1) worker.mjs serves a tiny page on http://127.0.0.1:7790 (localhost only, read-only, no auth needed since it's local and exposes no secrets or prompts; show task titles only, not full prompts). It's built from the SAME theme: import public/app.css's CSS variables (colours, radius, spacing, the system font stack, light/dark via prefers-color-scheme) by serving the controller's app.css subset or a shared public/theme.css extracted from app.css (refactor app.css to import it, so both stay in sync). 2) Content: a header with the machine name, the connection status to the head (a live dot: Connected / Reconnecting / Offline) and the head's hostname; a 'Now' section with one card per running job (the task title and #id, project, agent · model, the current phase with a progress timeline, elapsed time, the live last activity line, files changed so far); an 'Up next' count from the head; node health (CPU/RAM gauges, disk, and battery/power on Macs); and 'Recently finished' (the last 10 with outcome and duration). It updates live via Server-Sent Events from worker.mjs with smooth transitions (respecting prefers-reduced-motion). An idle state shows a calm 'Idle · waiting for work from <head>' screen. 3) It must look good full-screen on a Mac and as an installed web app. bin/install-worker-macos.sh adds it as a Dock web app / login item (open it in the default browser at login, or document Safari's 'Add to Dock'), and prints the URL. Include `node worker.mjs status` as a terminal version (a compact live-updating table) for VPS workers over SSH. 4) Screenshots of the idle, one-job and three-job states in light and dark via bin/shot.mjs against a worker run with a fake hub.

## Done when

`npm test` passes, public/theme.css is shared by app.css and the worker page, and GET http://127.0.0.1:7790/ on a worker under test (fake hub, one running stub job) returns the page showing that job's title and phase
