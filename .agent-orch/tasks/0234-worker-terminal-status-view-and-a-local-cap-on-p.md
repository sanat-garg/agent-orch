# Task #234: Worker terminal status view and a local cap on pooled CPU/RAM

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 12:53  
- starts after: #232, #229  
- files: worker.mjs, cluster.mjs, orchestrator.mjs, bin/install-worker-macos.sh, bin/install-worker.sh, test/worker-cap*.test.mjs, test/worker-status*.test.mjs

## Prompt

Two worker-side features (BRIEF goal 11; this replaces the cancelled web status page #233, so don't build any web page or listening port for status). 1) `node worker.mjs status`: a live-updating terminal view (plain ANSI, no deps, refreshing every 1 s, exit on q/Ctrl-C) for Macs and VPSs alike. It shows the machine name, the connection to the head (Connected/Reconnecting/Offline), the contribution cap in effect, CPU/RAM used by agent-orch jobs vs the cap (text bars), one line per running job (#id title truncated, agent·model, phase, elapsed, last activity), the count of jobs up next from the head, and the last 5 finished (outcome, duration). It reads state from the running worker daemon over a local unix socket (~/.agent-orch-worker/worker.sock, 0600), not a TCP port. Add `--once` for a single snapshot. The macOS installer prints how to open it, and optionally adds a Terminal login item running it. 2) The local contribution cap: `node worker.mjs limit --cpu <cores or %> --mem <GB or %> [--max-tasks N] [--only-on-ac]` and `node worker.mjs limit --show/--reset`. It's saved in ~/.agent-orch-worker/config.json and applied live (the daemon reloads it via the socket and reports it in inventory/heartbeats). The head MUST treat it as a hard ceiling: node slots = min(the head's own setting, local max-tasks, what fits in (local mem cap − the memory used by running jobs) / the agent's p90 footprint, and (local cpu cap / 1 core per task, or the measured per-agent CPU)). The worker also enforces it itself: it rejects job.offer when accepting would exceed the cap, and runs agent processes under the cap where the OS allows it (Linux: a systemd-run --scope with CPUQuota/MemoryMax per job, or cgroup v2; macOS: `taskpolicy -b` or a nice level for background, plus a memory watch that pauses the newest job if the cap is exceeded for 30 s). This is the ONE local setting allowed, and it amends #232's 'no local command changes behaviour' rule. The head's Machines view shows 'Pooled: 4 cores · 8 GB (set on this Mac)'. Tests: the cap parsing, the head slot computation honouring the local cap, the worker rejecting an offer over the cap, and the status socket snapshot.

## Done when

`npm test` passes with local-cap and status-socket tests, and `node worker.mjs status --once` against a test worker prints the connection state, cap and running job line
