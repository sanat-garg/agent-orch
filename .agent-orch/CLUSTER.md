# agent-orch cluster: design

_BRIEF goal 11. The contract for running orchestrator tasks on several machines. The wire format is code:
`cluster-protocol.mjs` (message types, field specs, validators, pairing/token helpers; no deps), tested by
`test/cluster-protocol.test.mjs`. When this doc and that module disagree, the module wins and this doc gets fixed._

Target: 6 agents in parallel. One 1-core ARM VPS can run about one (parallel.mjs `taskSlots`), so more machines
supply the CPU/RAM. They do not supply quota (see the caveat at the end).

## Roles

- **Controller**: this VPS, the live `agent-orch.service` (server.mjs + orchestrator.mjs). It alone owns the UI,
  the DB, the planner, reflection, routing/delegation, the queue, and every merge into a project's main branch
  (`mergeTask` under `serialGit`). It decides which node runs which task. It is also a node itself: the
  **local node** runs tasks exactly as today (worktree beside the repo, `runAgent` in-process).
- **Workers**: a Linux VPS (same spec as the controller) and the owner's MacBook whenever it is awake. Each runs a
  small daemon (`agent-orch-worker`, a future `worker.mjs` in this repo, started by systemd on Linux or a launchd
  agent on macOS) that dials the controller, reports what it has, and runs the jobs it is given with the same
  adapters (`agents.mjs` `runAgentCli`, normalised events) and the same done-when check (`runCheck`). A worker has no
  DB, no planner and no UI; it holds nothing the controller can't rebuild except in-flight work, which it pushes.
- **Node**: any machine that can run tasks (local node + workers). Identified by a stable `node` id (issued at
  pairing) and a display name.

## Transport

- The worker **dials out** over WebSocket to `wss://<controller>/api/cluster/ws` (`WS_PATH`). Caddy already proxies
  everything to :3000 and terminates TLS, so no Caddy change and **no inbound port on any worker**; it works from
  behind NAT/home Wi-Fi. server.mjs handles the upgrade on the existing `ws` server by path.
- **Pairing** (one time per node): the owner presses "Add machine" in the UI, which shows a one-time code
  (`newPairingCode`, `XXXX-XXXX`, valid `PAIRING_TTL_MS` = 10 min, single use) and the install command. On the worker,
  `agent-orch-worker pair https://<controller> XXXX-XXXX` POSTs `{code, name, os, arch}` to `CLAIM_PATH`
  (`/api/cluster/claim`, rate-limited like login; the owner's UI creates the code with a signed-in POST to `PAIR_PATH`,
  `/api/cluster/pair`). The controller answers `{node, token}` once; the token
  (`newNodeToken`, 256-bit, `aon_` prefix) is stored on the worker in `~/.agent-orch-worker/config.json` (mode 0600).
- **Auth**: every connection sends `Authorization: Bearer <token>` on the upgrade request (`bearerToken`). The
  controller compares its sha256 against the node's stored hash (`secretMatches`, constant time) and refuses the
  upgrade (401) for unknown or revoked nodes before any frame is read. The session cookie is not accepted here, and the
  node token is not accepted anywhere else.
- **Frames**: one JSON text message each, `{t, seq, ts, ...fields}`, at most `MAX_FRAME` (1 MB). `seq` counts up
  per sender per connection; `re` names the frame a reply answers. Every frame is checked with `decode(raw, {from})`;
  an invalid frame gets an `error` reply and is dropped (repeat offenders are disconnected).
- **Liveness**: both sides send `heartbeat` every `HEARTBEAT_MS` (10 s); any frame counts. After
  `HEARTBEAT_MISSES` (3) silent intervals the peer is considered gone (the controller starts the node's grace period,
  the worker closes and reconnects). WebSocket ping/pong is used as well so Caddy keeps the socket open.
- **Reconnect**: the worker retries forever with `backoffMs(attempt)` (1 s doubling to 60 s, ±20% jitter), resetting
  after a connection that lasted a minute. On macOS a sleep/wake simply looks like a dropped connection.
- **Versions**: `hello.protocol` must equal `PROTOCOL_VERSION`; otherwise the controller replies `error` +
  `bye` and shows "update the worker" on the node. Additive fields don't bump the version; validators ignore unknown
  fields.

## Messages

Direction: C = controller → worker, W = worker → controller (`DIRECTION`; `validate` enforces it). Field specs are
`SCHEMA` in cluster-protocol.mjs.

| type | dir | fields | meaning |
| --- | --- | --- | --- |
| `hello` | W | node, protocol, version, jobs[{job, state, sha}] | first frame; `jobs` = work still on this machine (re-attach) |
| `welcome` | C | node, protocol, heartbeatMs, wipPushMs, graceMs | settings for this node |
| `inventory` | W | node, name, os (linux/darwin), arch, cores, mem, agents[{id, installed, version, signedIn, account, models}], limits, versions{agentOrch, node, git} | after `welcome` and whenever it changes |
| `resources` | W | memAvailable, load[1,5,15], running[job ids], swapUsedPct | every heartbeat-ish (≥10 s), from /proc/meminfo or `vm_stat`/`sysctl` on macOS |
| `heartbeat` | both | — | liveness |
| `ack` / `error` / `bye` | both | re / message / reason | replies; `bye` before a clean shutdown (a drained Mac going to sleep) |
| `job.offer` | C | job, agent, model, footprint | "can you take this?" |
| `job.accept` / `job.reject` | W | job / job, reason (busy, low_memory, agent_missing, not_signed_in, draining, version, other) | answer within 10 s or counts as reject |
| `job.start` | C | job, title, prompt, systemAppend, agent, model, account, repo, baseSha, branch, doneWhen, resume, timeouts{taskSec, verifySec, installSec}, autonomous, tools, install[argv] | run it |
| `job.event` | W | job, from, events[≤200 normalised agent events] | batched every ~1 s; `from` = index of the first event so resends dedupe |
| `job.check` | W | job, command, output, pass, code | result of the done-when check, run on the worker in the task's worktree |
| `job.wip` | W | job, sha, branch | a WIP commit was pushed to `agent-orch/task-<id>` |
| `job.done` | W | job, outcome, text, usage, limits, sha, sessionId | the agent turn ended (outcomes = `runAgentCli`'s + setup_failed, lost) |
| `job.cancel` / `job.pause` / `job.resume` | C | job (+reason / +prompt) | cancel = kill + push WIP + drop worktree; pause = kill + keep worktree + push WIP; resume = continue the session |
| `git.credential` | C | host, token | the only frame that may carry a secret (see Security) |
| `login.start` / `login.code` / `login.cancel` | C | login, agent / login, code / login | remote sign-in: connections.mjs runs on the worker, same tmux scraping |
| `login.state` | W | login, state (starting, url, waiting_code, done, failed, cancelled), url, code, account, message | relayed to the owner's Connections sheet for that node |
| `models.refresh` / `limits.refresh` | C | agent | the owner pressed refresh for that node's agent (nothing polls: BRIEF goal 7) |
| `models` / `limits` | W | agent, models[] / windows[], error | the answer, from the worker's own `discoverModels` / `fetchLimits` |

A task's life on a worker: `job.offer` → `job.accept` → `job.start` → `job.event`* (+ `job.wip`*) → `job.done` →
(if ok and the task has a done-when) `job.check` → controller merges or answers with `job.resume` (continue /
verify-failed prompt, same as the local flow) or `job.cancel`. The controller keeps the task `running` throughout;
`tasks.node` records where it runs, and the run log is written on the controller from `job.event`.

## Code movement

- **GitHub is the transport for code**; frames never carry file contents. Every project already has a private repo on
  `origin` (github.mjs). `job.start.repo` is its clone URL (https or ssh, never with credentials inside the URL).
- **Cache clone**: `~/.agent-orch-worker/repos/<owner>__<repo>.git`, a bare clone (`--filter=blob:none`) fetched
  before each job. **Per task**: a worktree `~/.agent-orch-worker/worktrees/<repo>-task-<id>` on branch
  `agent-orch/task-<id>`, created from `baseSha` (the controller's main-branch head when it started the job), or from
  `origin/agent-orch/task-<id>` when that branch exists (a resumed or reassigned task). Same naming as worktrees.mjs.
- **Setup**: the worker runs `job.start.install` (the controller derives it from the project: `npm ci` when a
  package-lock.json exists, nothing otherwise) inside the worktree within `timeouts.installSec`. `node_modules` is not
  shared between worktrees on a worker unless the lockfile hash matches a cached install (a later optimisation). A
  failed setup ends the job with `job.done {outcome: 'setup_failed'}`, which the controller treats like a crash
  (bounded retries, maybe on another node).
- **WIP pushes**: every `wipPushMs` (10 min) while the agent runs, and at every `job.done`/pause/cancel, the worker
  commits everything (`agent-orch #<id> (wip)`, using `GIT_ID`) and pushes `agent-orch/task-<id>` to origin
  (`--force-with-lease` against its last push), then sends `job.wip {sha}`. The controller stores the last `sha` per
  task (`tasks.wip_sha`). Unchanged trees skip the commit.
- **Merge back**: on a passing `job.done`/`job.check`, the controller fetches `agent-orch/task-<id>` into the project
  repo, checks the tip equals `job.done.sha`, and runs the existing path: `mergeTask` (squash, rebase, ff-only, push)
  under `serialGit`. A rebase conflict marks the task `needs_integration` and queues an integrator task exactly as
  today; the integrator is just another job and may run on any node, starting from the pushed branch. After the
  merge, the controller deletes the remote branch and sends nothing further; the worker removes its worktree when it
  gets the `ack` for its final `job.done`, and prunes cached repos unused for 14 days.
- Controller-side worktrees are unchanged for local-node tasks.

## Scheduling

- The controller keeps a node table (cluster.mjs `nodes`: id, name, os, arch, token_hash, created_at, last_seen, status
  online/offline/draining/disabled, inventory JSON, resources JSON, max_slots, enabled, draining). The local node is
  the row `controller`, fed from /proc directly. Revoking a node deletes its row.
- `claimNext` becomes claim + place. A task is placeable on a node when: the node is connected (or local), not
  draining, its task's resolved agent is `installed && signedIn` there (for the account the route wants), the node has
  a free slot, and `memAvailable - footprint(agent)` stays above the node's floor (the local node keeps today's
  `MEM` thresholds; workers report the same numbers). `footprint(agent)` is the per-agent measured RSS from #209
  (until then a constant per agent, e.g. 1.2 GB for claude, 0.8 GB for codex).
- Slots per node = `min(cores, floor((memAvailable - floor) / footprint))`, capped by a per-node setting in the UI
  (default 1 for the Mac, so the owner's laptop stays usable). The local node keeps its current `taskSlots` rule.
- Placement picks the placeable node with the most headroom, preferring: the node that last ran the task (warm
  worktree and session), then remote nodes over the local one (the controller also serves the UI and merges). Plan and
  reflect tasks always run on the local node: they need the DB and project context.
- The offer is a two-phase claim: the task stays `queued` with `offered_to` set until `job.accept`; a reject or 10 s
  timeout clears it and tries the next node. `files`/`filesOverlap` and `task_deps` rules apply across nodes
  unchanged, because they are checked on the controller before placement.
- Per-agent rate limits stay controller-global (`blockedUntilFor(agent)`): a `limit` event or `rate_limited` outcome
  from any node blocks that agent (and account) everywhere, since the quota is shared.

## Failure modes

- **Worker disconnects mid-task** (sleep, Wi-Fi, crash): its jobs keep `running` and the node shows "away". The
  controller waits `graceMs(os)`: 5 min for a Mac (`GRACE_MS.mac`), 2 min for a VPS (`GRACE_MS.vps`).
  - **Same node returns within grace**: `hello.jobs` lists the jobs it still has; the controller re-attaches them
    (events resume from `job.event.from`, a job the controller no longer wants gets `job.cancel`). A job that
    finished while offline is re-sent as `job.done` from the worker's outbox (`~/.agent-orch-worker/outbox/`).
  - **Grace expires**: the task is requeued with `last_error = '[lost] node <name> disappeared'` (no attempt spent the
    first time) and reassigned. The new run starts from the latest pushed WIP (`origin/agent-orch/task-<id>` at
    `tasks.wip_sha`), with a handoff prompt: "a previous session on another machine was interrupted; its work up to
    <sha> is on this branch; read .agent-orch/TASK.md and `git log`, check what is done, then finish the task". The
    agent session is not resumed (it lives on the other machine). Up to 10 min of work can be lost.
  - **Node returns after reassignment**: `hello.jobs` names a job now owned by another node → `job.cancel` with
    reason `reassigned`; the worker discards its worktree without pushing (its branch must not clobber the new run's).
- **Controller restart** (deploy, "Restart when idle"): workers keep running their agents and buffer frames in the
  outbox (events capped, oldest dropped first; `job.wip`/`job.done` always kept), reconnect with backoff, and
  re-attach via `hello.jobs`. The orchestrator boots with remote `running` tasks left as they are for one grace
  period instead of requeueing them; "Restart when idle" counts remote jobs as busy.
- **Push fails** (network, auth): the worker retries with backoff and reports `error {job}`; the job's `job.done`
  waits until its final push succeeds, so the controller never merges a sha it can't fetch.
- **Worker out of memory / reboot**: the local memGuard equivalent on the worker aborts its newest job
  (`job.done {outcome:'aborted'}`); after a reboot the worker reports no jobs, so the controller reassigns at once
  instead of waiting for the grace period.
- **Clock skew**: `ts` is informational only; all deadlines (grace, offers, rate-limit resets) run on the
  controller's clock.

## Security

- **Tokens**: the controller stores only `hashSecret(token)` (sha256) and `hashSecret(code)` for pending pairing
  codes; codes are single-use and expire in 10 min. Tokens are compared in constant time. The worker keeps its token
  in a 0600 file under `~/.agent-orch-worker/`.
- **Revocation**: removing a node in the UI deletes its row (and token hash), closes its socket (code 4003), and requeues its jobs; a revoked token
  is refused at the upgrade. Re-adding needs a new pairing code.
- **Only controller-originated jobs**: workers accept `job.*` commands only from the socket they dialled (TLS to the
  configured controller URL, certificate verified); `validate(msg, {from})` rejects worker-originated commands on the
  controller and controller-only types on the worker. Workers run no listener at all: **no inbound ports**.
- **Least privilege**: the worker runs as an unprivileged user with no sudo, touching only `~/.agent-orch-worker/`
  and its agent CLIs' own config dirs. On the Mac it runs as a **dedicated macOS user** (e.g. `agentorch`, standard
  account, FileVault on) so agents can't read the owner's home, keychain or browser profiles; the launchd agent runs
  in that user's session. Agent env is stripped exactly as on the controller (API_ENV / `envFilter`), so runs stay on
  the subscription login.
- **Secrets never travel over the wire**: the validators refuse any frame whose keys look like secrets
  (`secretKeys`: `*token`, `*secret`, `password`, `api_key`, `cookie`, `credential(s)`, `authorization`), repo URLs
  with embedded credentials, and agent logins: each machine signs in its own agents locally via `login.*` (the CLI's
  OAuth tokens stay on that machine). The single exception is `git.credential {host, token}`: a GitHub token the
  owner explicitly authorises per node in the UI (a fine-grained token limited to the project repos with
  contents:write is recommended); the worker keeps it in memory or a 0600 git credential store, never in a repo URL
  or a log. Without it the worker uses its own `gh auth`/ssh key.
- Frames are size-capped (`MAX_FRAME`) and schema-checked; job fields such as `branch` must match
  `agent-orch/task-<id>` and `baseSha` a full sha, so a controller bug can't point a worker at arbitrary refs.

## Shared-subscription caveat

A subscription (Claude Max, ChatGPT) signed in on several machines is **one** account with **one** set of rate-limit
windows. Workers add CPU and RAM, not quota: 6 parallel Claude agents burn the same 5-hour/weekly windows 6× faster.
The scheduler therefore keeps limits per agent+account globally on the controller, and the UI shows the account each
node's agent is signed into. More quota only comes from different accounts or agents (e.g. codex on the owner's
ChatGPT login beside Claude), which routing and the owner's fallback lists already handle.
