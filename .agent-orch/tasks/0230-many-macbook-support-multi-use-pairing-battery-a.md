# Task #230: Many-MacBook support: multi-use pairing, battery and sleep policy

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 12:46  
- starts after: #221  
- files: cluster.mjs, worker.mjs, bin/install-worker-macos.sh, README.md, test/cluster-macos*.test.mjs

## Prompt

Prepare for the owner adding 4 MacBooks plus a second VPS. 1) Pairing: 'Add machine' can create a multi-use pairing code (valid 1 h, up to N machines, revocable). Each machine auto-names itself from its hostname (e.g. 'MacBook Pro (Sanat-MBP-2)') and can be renamed later. The installer accepts --code for multi-use codes. 2) macOS power policy per node (settings, with defaults): accept new jobs only when on AC power, or on battery above 50% (configurable); while running a job, keep the Mac awake with `caffeinate -i -w <worker pid>` (only while jobs run, and only on AC by default); pause intake at high thermal pressure (`pmset -g therm` or powermetrics-free signals). When the lid closes or it sleeps, the failover logic from #220 applies. 3) The macOS worker service runs as the dedicated 'agentorch' user, starts at login of that user or as a LaunchDaemon (document both, recommending a LaunchDaemon so it runs without that user being logged in), and has resource caps (it takes at most cores−1 tasks and leaves 3 GB RAM for the owner by default, configurable per Mac). 4) Update bin/install-worker-macos.sh and README for these, including a 'Pair 4 Macs in one go' walkthrough. Tests: multi-use code limits and expiry, the power policy decisions (AC/battery/thermal fixtures), and caffeinate starting and stopping with jobs (stubbed).

## Done when

`npm test` passes with multi-use pairing and macOS power-policy tests, and `bash bin/install-worker-macos.sh --dry-run --code TEST` exits 0 and shows the caffeinate/LaunchDaemon setup
