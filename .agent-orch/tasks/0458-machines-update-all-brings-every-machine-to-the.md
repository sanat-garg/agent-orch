# Task #458: Machines: 'Update all' brings every machine to the latest version

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 14:57  
- files: cluster.mjs, worker.mjs, server.mjs, public/app.js, public/app.css, test/cluster-update-all*.test.mjs

## Prompt

Add an 'Update all' button to the Machines view (next to the cluster summary; also available per machine as 'Update' on outdated machines). Build on the existing pieces: workers report their agent-orch sha/version in inventory (#229/#406/#407 v-format), the node.update message (#229: git pull + restart when idle), rolling restart on the head (#426), WIP push/pause and re-adoption (#220). 1) The button shows how many machines are behind ('Update all · 2 behind v3.60'), and is disabled with 'All up to date' when none are. Clicking it opens a small confirm sheet: the list of machines with current → target version, a checkbox 'Also update Claude Code and Codex CLIs' (default off), and 'Update now'. 2) Update now (POST /api/cluster/update {nodes?, clis?}): machines update ONE AT A TIME (rolling) so capacity never drops to zero. Each worker gets node.update {mode:'now', clis}: it stops taking new jobs, pauses its running jobs with a WIP push (resumable), `git fetch` + `git reset --hard` to the head's main via the head git endpoint (#345) or pull, npm ci if package-lock changed, optionally updates the CLIs (`claude update` / `npm i -g @openai/codex@latest`, using the install commands in .agent-orch/AGENTS.md), then restarts its service (launchd/systemd) and on reconnect reports the new version; the head resumes its paused jobs there (or reassigns after the grace period). The head itself updates last via the rolling restart if it's behind its own main. 3) Progress is live in the Machines view per machine: 'Updating… pulling → installing → restarting → v3.60 ✓' or a clear error with 'Retry' (e.g. a dirty checkout or a failed npm ci), and a toast when all are done. Offline machines are skipped with 'will update when back online' (they update automatically on reconnect). 4) Tests with fake workers: only outdated nodes are targeted; updates run one at a time; a worker's running jobs are paused and resumed after its update; a failing worker reports an error and the rest continue; the CLI flag is passed through. Run only the touched test files.

## Done when

`node --test test/cluster-update-all*.test.mjs` passes (outdated-only targeting, one at a time, jobs paused and resumed, failure isolated, CLI flag passed), and the Machines view renders an Update all button
