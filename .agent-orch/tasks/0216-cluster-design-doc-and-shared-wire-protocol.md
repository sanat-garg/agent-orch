# Task #216: Cluster design doc and shared wire protocol

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 11:58  
- files: .agent-orch/CLUSTER.md, cluster-protocol.mjs, test/cluster-protocol.test.mjs

## Prompt

Write .agent-orch/CLUSTER.md and cluster-protocol.mjs, the contract for running tasks on several machines (BRIEF goal 11). Read BRIEF/CONTEXT, orchestrator.mjs (the claim → runAgent → check → merge-back flow and the worktree logic), agents.mjs (runAgentCli, normalised events), resources.mjs and connections.mjs first. The design must cover: roles (the controller is this VPS; workers are Linux VPSs and macOS laptops); transport (the worker dials OUT via WebSocket to wss://<controller>/api/cluster/ws, through the existing Caddy which already proxies everything to :3000, with a per-node bearer token issued by a one-time pairing code; heartbeats every 10 s; reconnect with backoff); messages (hello/inventory {node id, name, os, arch, cores, mem, agents with installed/version/signedIn/account/models, limits, versions of agent-orch}; resources {MemAvailable, load, running}; job.offer/accept/reject; job.start {task, prompt, system append, agent, model, account, repo URL, base sha, branch name, done_when, timeouts}; job.event (normalised agent events, batched); job.check {output, pass}; job.wip {pushed sha}; job.done {outcome, text, usage, limits, final sha}; job.cancel/pause/resume; login.start/state/code/cancel for remote sign-in; models/limits refresh); code movement (the worker keeps a cache clone of each project's GitHub repo under ~/.agent-orch-worker/repos, and per task a worktree on branch agent-orch/task-<id> from the base sha, running npm ci / installs as the project needs; it pushes WIP commits every N minutes and at the end; the controller fetches the branch and merges with the existing rebase/merge-back and needs-integration logic); scheduling (placement by node capacity, per-agent footprint (#209) and signed-in agents; the controller's own node counts as a local node); failure modes (worker disconnects mid-task: wait a grace period (5 min for a Mac, 2 min for a VPS), then reassign from the latest WIP branch with a handoff prompt, or resume on reconnect if the same node returns; controller restart: workers keep running and re-attach); security (token hashing, node revocation, only controller-originated jobs, no inbound ports, least privilege, a dedicated macOS user for the Mac worker, and secrets never travelling over the wire except the GitHub token the owner explicitly authorises); and the shared-subscription caveat. cluster-protocol.mjs exports message type constants plus small validators (no deps), with unit tests.

## Done when

.agent-orch/CLUSTER.md exists with sections Roles, Transport, Messages, Code movement, Scheduling, Failure modes and Security, and `npm test` passes including test/cluster-protocol.test.mjs
