# Task #218: Worker daemon: connect, report inventory, run jobs in local checkouts

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 11:58  
- starts after: #216  
- files: worker.mjs, resources.mjs, test/worker*.test.mjs, test/fixtures/worker-*

## Prompt

Implement worker.mjs, the daemon that runs on extra machines (per .agent-orch/CLUSTER.md and cluster-protocol.mjs). `node worker.mjs pair --controller https://<host> --code ABCD1234 --name mac` stores the node token in ~/.agent-orch-worker/config.json (0600). `node worker.mjs run` connects (wss, with reconnect/backoff), sends hello with its inventory (cores, mem, os/arch, and every agent's installed/signedIn/account/models/limits via agents.mjs helpers, reusing the leak-safe helper spawning from #211), sends resources heartbeats every 10 s (reusing resources.mjs; on macOS use os.freemem, os.loadavg and `vm_stat`/`memory_pressure` since there's no /proc: make resources.mjs platform-aware or add a darwin path), and handles jobs. For job.start: fetch/clone the repo into ~/.agent-orch-worker/repos/<owner>__<repo> (a git cache), create a worktree on agent-orch/task-<id> from the base sha, install deps if package.json exists (npm ci, with caching), run runAgentCli with the given agent/model/prompt in the worktree while streaming batched job.event messages, push WIP commits to origin on that branch every 10 min and on pause, then run the done_when check in the worktree and report job.check, commit, push the final branch, report job.done, and clean up the worktree. Honour job.cancel/pause/resume. It runs its own reaper for leftovers. It has no UI, logs to ~/.agent-orch-worker/logs, and has git and gh credentials from the machine's own login (documented). Tests: run worker.mjs against a fake hub (an in-test WS server) with a temp bare git repo as 'origin' and a stub agent CLI: pairing, inventory, a job that edits a file, a passing check, and the branch pushed with the change.

## Done when

`npm test` passes with a worker e2e test (fake hub, temp bare repo, stub agent) where the job's branch is pushed to the bare repo containing the agent's change

## Result — done (check passed) (2026-09-27 12:48)

AGENT-ORCH-STATUS: done — worker daemon runs jobs, pushes branches; npm test passes
