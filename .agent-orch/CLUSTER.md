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
- **Workers**: a Linux VPS (same spec as the controller) and the owner's MacBooks whenever they are awake. Each runs a
  small daemon (`worker.mjs` in this repo, started by systemd on Linux or a launchd
  LaunchDaemon on macOS) that dials the controller, reports what it has, and runs the jobs it is given with the same
  adapters (`agents.mjs` `runAgentCli`, normalised events) and the same done-when check (`runCheck`). A worker has no
  DB, no planner and no UI (it is compute-only, see Compute-only workers); it holds nothing the controller can't rebuild
  except in-flight work, which it pushes.
- **Node**: any machine that can run tasks (local node + workers). Identified by a stable `node` id (issued at
  pairing) and a display name.

## Transport

- The worker **dials out** over WebSocket to `wss://<controller>/api/cluster/ws` (`WS_PATH`). Caddy already proxies
  everything to :3000 and terminates TLS, so no Caddy change and **no inbound port on any worker**; it works from
  behind NAT/home Wi-Fi. server.mjs handles the upgrade on the existing `ws` server by path.
- **Pairing** (one time per node): the owner presses "Add machine" in the UI, picks how many machines, and gets a code
  (`newPairingCode`, `XXXX-XXXX`) and the install command. One machine: a one-time code valid `PAIRING_TTL_MS` (10 min).
  Several (2..`MAX_PAIRING_USES`): one code that pairs that many machines within `PAIRING_MULTI_TTL_MS` (1 h), the same
  command on each ("Pair 4 Macs in one go"). On the worker, `node worker.mjs pair --controller https://<controller>
  --code XXXX-XXXX` POSTs `{code, name, os, arch}` to `CLAIM_PATH` (`/api/cluster/claim`, rate-limited like login; the
  owner's UI creates the code with a signed-in POST `{uses}` to `PAIR_PATH`, `/api/cluster/pair`, follows it with GET
  `…/pair/:code` and revokes it with DELETE). Each claim makes a node of its own and answers `{node, name, token}`
  once; the token (`newNodeToken`, 256-bit, `aon_` prefix) is stored on the worker in `~/.agent-orch-worker/config.json`
  (mode 0600). Without `--name` a Mac names itself `<model> (<LocalHostName>)` (worker.mjs `defaultName`: system_profiler,
  scutil), a Linux box its short hostname; the controller appends " 2", " 3" to a name already taken. Codes live in
  the `pairings` table (hashes, uses, the node ids that claimed them, revoked_at), so a controller restart keeps them.
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
| `hello` | W | node, protocol, version, jobs[{job, state, sha, next}], sha, features | first frame; `jobs` = work still on this machine, finished ones whose `job.done` wasn't acked included (re-attach); `sha` = its agent-orch checkout; `features` see Health |
| `welcome` | C | node, protocol, heartbeatMs, wipPushMs, graceMs, features, policy, queued | settings for this node; `policy` see Power policy; `queued` see Local cap and status view |
| `inventory` | W | node, name, os (linux/darwin), arch, cores, mem, agents[{id, installed, version, signedIn, account, models}], limits, versions{agentOrch, node, git}, cap, browser{capable, headed, error} | after `welcome` and whenever it changes; `cap` see Local cap and status view |
| `resources` | W | memAvailable, load[1,5,15], running[job ids], swapUsedPct + health telemetry: cpu[% per core], memTotal, swapTotal, swapUsed, disk{path, free, total}, net{host, ok, ms, at, error}, agents[{id, installed, version, signedIn}], uptime, procUptime, version, sha, battery{pct, charging, source}, thermal{pressure, speedLimit, level}, intake{ok, reason, text}, awake, cap, jobsMem, jobsCpu | every heartbeat (10 s), from /proc or `vm_stat`/`sysctl`/`pmset`/`notifyutil` on macOS; see Health, Power policy and Local cap |
| `heartbeat` | both | queued (C) | liveness; the controller's carries `queued` |
| `ack` / `error` / `bye` | both | re (+job) / message / reason | replies; the controller acks each `job.done` with its `job` (the worker then forgets the job); `bye` before a clean shutdown |
| `wake` | W | sleptAt, sleptMs | a time jump on the worker (a laptop's sleep), sent after the next `welcome` |
| `job.offer` | C | job, agent, model, footprint | "can you take this?" |
| `job.accept` / `job.reject` | W | job / job, reason (busy, low_memory, agent_missing, not_signed_in, draining, version, other, power, cap) | answer within 10 s or counts as reject; `power` only to a controller with feature `policy`, `cap` only with feature `cap` |
| `job.start` | C | job, title, prompt, systemAppend, agent, model, account, repo, baseSha, branch, doneWhen, resume, timeouts{taskSec, verifySec, installSec}, autonomous, tools, install[argv], capabilities["browser"], identity | run it (a browser task gets the Playwright MCP on that profile, browser.mjs) |
| `job.event` | W | job, from, events[≤200 normalised agent events] | batched every ~1 s; `from` = index of the first event so resends dedupe |
| `job.check` | W | job, command, output, pass, code | result of the done-when check, run on the worker in the task's worktree |
| `job.wip` | W | job, sha, branch | a WIP commit was pushed to `agent-orch/task-<id>` |
| `job.done` | W | job, outcome, text, usage, limits, sha, sessionId | the agent turn ended (outcomes = `runAgentCli`'s + setup_failed, lost) |
| `job.cancel` / `job.pause` / `job.resume` | C | job (+reason / +prompt) | cancel = kill + push WIP + drop worktree (reason `reassigned`/`disabled`: no push); pause = kill + keep worktree + push WIP; resume = continue the session |
| `job.attach` | C | job, from | after a reconnect: the controller still wants the job and has its events up to `from`; the worker replays from there |
| `git.credential` | C | host, token | one of two frames that may carry a secret (see Security) |
| `agent.credential` | both | agent, value (null = stop sharing) | C→W: the head's Claude worker token / Codex `auth.json`; W→C: a Codex refresh made on the worker (see Security); only with feature `creds` |
| `login.start` / `login.code` / `login.cancel` / `login.logout` | C | login, agent / login, code / login / login, agent | remote sign-in and sign-out: connections.mjs runs on the worker (tmux, or a `script` pty when tmux is missing) |
| `login.state` | W | login, state (starting, url, waiting_code, done, failed, cancelled, signed_out), url, code, account, message, prompt | relayed to the owner's Connections sheet for that node |
| `models.refresh` / `limits.refresh` | C | agent | the owner pressed refresh for that node's agent (nothing polls: BRIEF goal 7) |
| `models` / `limits` | W | agent, models[] / windows[], error | the answer, from the worker's own `discoverModels` / `fetchLimits` |
| `job.phase` | W | job, phase, at, ms, progress{tools, files, last}, outcome | a job moved to `phase` at `at`; `ms` = how long the one before took; re-sent with `progress` while the agent runs (feature `phases`) |
| `job.error` / `node.error` | W | job, kind, message, stack, stderr, at / kind, message, stack, stderr, re | a structured failure with its stack or stderr tail (feature `errors`) |
| `logs.tail` / `logs` | C / W | req, lines / req, lines[], error | the owner asked for the worker's log tail (feature `logs`) |
| `node.update` | C | sha | update agent-orch and restart, sent only while the node is idle (feature `update`) |
| `node.policy` | C | policy | the owner changed the node's power policy or max tasks (feature `policy`); older workers read it in the next `welcome` |

A task's life on a worker: `job.offer` → `job.accept` → `job.start` → `job.event`* (+ `job.wip`*) → (if ok and the
task has a done-when) `job.check` → final commit + push (`job.wip`) → `job.done` → controller merges or answers with `job.resume` (continue /
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
- Slots per node = `min(cores, floor((memAvailable - floor) / footprint))` when its max tasks is Auto (`max_slots` 0,
  API `maxSlots: null`), else the owner's number from the Machines view; headroom is checked per claim either way. A
  Mac's Auto keeps a core and its policy's RAM reserve for its owner: `min(cores − 1, (memAvailable − max(floor,
  reserve)) / footprint)` (power.mjs `autoTasks`, orchestrator `nodeCap`/`floorOf`). New Linux nodes start at 1 task,
  new Macs on Auto. Either way a worker's own local cap is a hard ceiling on top (see Local cap and status view). A
  node whose worker reports no intake (status `paused`, see Power policy) gets nothing new. The local node keeps its
  current `taskSlots` rule.
- Placement picks the placeable node with the most headroom, preferring: the node that last ran the task (warm
  worktree and session), then remote nodes over the local one (the controller also serves the UI and merges). Plan and
  reflect tasks always run on the local node: they need the DB and project context (asserted, see Compute-only workers).
- The offer is a two-phase claim: the task stays `queued` with `offered_to` set until `job.accept`; a reject or 10 s
  timeout clears it and tries the next node. `files`/`filesOverlap` and `task_deps` rules apply across nodes
  unchanged, because they are checked on the controller before placement.
- Per-agent rate limits stay controller-global (`blockedUntilFor(agent)`): a `limit` event or `rate_limited` outcome
  from any node blocks that agent (and account) everywhere, since the quota is shared.

## Failure modes

- **A job's stream** (worker.mjs): events are numbered from 0 per job; `job.check`/`job.wip`/`job.done` sit at their
  place in that sequence. The worker keeps them (up to 5000 events) after sending, and on every disconnect holds
  them until the controller answers its `hello` with `job.attach {from}` (it replays events ≥ `from` and the frames
  placed at or after it) or `job.cancel`. The controller dedupes by index and writes each run-log entry with its index
  (`i`), so nothing is lost or duplicated, across a controller restart too. A finished job stays on the worker until
  its `job.done` is acked. The agent keeps running throughout.
- **Worker disconnects mid-task** (sleep, Wi-Fi, crash): its jobs keep `running`; the task shows 'waiting for <node>'
  ('(Mac asleep)' when a darwin node went silent without a `bye`: nodes.away). The controller waits the node's grace:
  `nodes.grace_ms` (owner, PATCH `graceSec`), else `graceMs(os)`: 5 min for a Mac, 2 min for a VPS.
  - **Same node returns within grace**: `hello.jobs` lists what it still has; ours get `job.attach`, the rest
    `job.cancel {reason:'reassigned'}`. A job of ours it doesn't list (it rebooted) is lost at once.
  - **Grace expires**: the run ends `aborted` + `lost`; the task is requeued with `last_error = '[lost] node <name>
    disappeared'` and no session (no attempt spent the first time; repeated losses do) and isn't offered to that node
    for 10 min. The next run (another worker, or the controller) starts on `agent-orch/task-<id>` at the latest pushed
    WIP with a handoff prompt (orchestrator.mjs `handoffPrompt`): the original task and done-when, the branch's diff
    stat, and the previous agent's last messages and tool calls from its run log. Up to `wipPushMs` of work can be lost.
    A worker away past its grace pushes nothing (WIP skipped, the final push waits for `job.attach`), so it never
    clobbers the new run's branch.
  - **Node returns after reassignment**: `job.cancel` with reason `reassigned`; the worker discards its worktree
    without pushing.
- **Controller restart** (deploy, crash): workers keep running their agents and hold their frames. At boot the
  orchestrator leaves remote `running` work tasks (and their open run) as they are; `attachCluster` re-adopts each one
  (the next event index is read back from its run log) and waits one grace period for its node's `hello`, then the
  job continues in the same run. Without a hub they are requeued.
- **Draining** a node (PATCH `draining`): it takes no new jobs; running ones finish there. **Disabling** or removing it
  moves its jobs now: `job.cancel {reason:'disabled'}` and a reassignment as after the grace period.
- **Sleep/wake**: the worker's 5 s clock firing more than `SLEEP_JUMP_MS` (30 s) late means the machine slept; it
  drops its (dead) socket, reconnects at once and reports `wake`. The controller keeps `nodes.slept_at/slept_ms` and
  logs it.
- **Push fails** (network, auth): the worker retries with backoff and reports `error {job}`; the job's `job.done`
  waits until its final push succeeds, so the controller never merges a sha it can't fetch.
- **Worker out of memory / reboot**: the local memGuard equivalent on the worker aborts its newest job
  (`job.done {outcome:'aborted'}`); after a reboot the worker reports no jobs, so the controller reassigns at once
  instead of waiting for the grace period.
- **Clock skew**: `ts` is informational only; all deadlines (grace, offers, rate-limit resets) run on the
  controller's clock.

## Health (#229)

Workers report richly; the controller keeps what the owner needs and acts on it.

- **Features**: `hello.features` / `welcome.features` list what each side reads (`FEATURES` in cluster-protocol.mjs:
  phases, errors, logs, update, policy, plus `cap` for the reject reason `cap`). A peer sends a newer frame type only
  when the other side lists its feature, so a worker
  updated ahead of the controller's running code (or behind it) never trips the invalid-frame limit. Fields added to
  existing frames (the telemetry on `resources`, `hello.sha`) need no flag.
- **Phases**: `job.phase` frames ride the job's stream (held while away, replayed after `job.attach`, deduped by phase +
  the worker's `at`): queued → cloning (first clone) / fetching → installing (when it installs) → running → checking
  (with a done-when) → committing → pushing → done {outcome}. Each carries the previous phase's duration measured on the
  worker. While the agent runs, progress hints go out directly every ≥5 s when changed: tool calls so far, files its
  edit tools touched, the last tool line. The controller keeps them per run (`runs.phases`, `at` moved onto its clock;
  a run that ends mid-phase closes it with `cut`) and streams them to the task drawer (`orun` `{k:'phases'}`), which
  shows a timeline.
- **Telemetry**: every heartbeat the `resources` frame carries the health fields above. Agent versions and sign-ins
  come from the last inventory (never polled, BRIEF goal 7); GitHub reachability is a TCP connect at most once a
  minute; a Mac's battery/thermal state (`pmset`) at most once a minute. The controller appends each frame to
  `<DATA>/metrics/nodes/<id>.jsonl` (node-metrics.mjs; the controller's own node at the same pace), compacted: the last
  hour at full resolution, 5-minute buckets to 24 h, nothing older. `GET /api/cluster/nodes/:id/metrics?range=15m|1h|6h|24h`.
- **Errors**: agent crashes (the CLI failing, with its stderr tail), failed setups and installs, push failures and
  crashed checks are `job.error` (kept on the run, `runs.errors`, and in the task's events); daemon exceptions (a frame
  handler, uncaughtException: reported, then a clean stop and exit 1 for the service manager) are `node.error` (the
  node's `last_error`, shown on its card for a day).
- **Logs**: `GET /api/cluster/nodes/:id/logs?tail=200` sends `logs.tail {req}` and waits (15 s) for `logs {req, lines}`:
  the worker's `logs/worker.log` (and the rotated one before it), at most 2000 lines clipped to fit one frame.
- **Auto-health** (cluster.mjs `HEALTH`): a worker is drained (`nodes.drain_reason`, a notice in the event log and a
  toast) when 3 different tasks failed there within 30 min (error, setup_failed, empty_response, auth_error) and none of
  them failed on another machine too (orchestrator.mjs `checkNodeFailures`), when the disk holding its repos has under
  2 GB free, or when it lost its connection 3 times in 30 min without a bye (missed heartbeats or a dropped socket; a
  Mac's reported sleep excuses its drop). Undraining (the owner) sets `health_ack`: older evidence stops counting, and
  low disk doesn't drain it again within the hour.
- **Updates**: the controller compares `hello.sha` with its own checkout's `origin/main` (`git rev-list --count`,
  cached). More than `OUTDATED_AFTER` (20; `AGENT_ORCH_OUTDATED_COMMITS`) commits behind = outdated: the node takes no
  new work (status `updating`) and gets `node.update` once idle (its telemetry from this connection lists no job and
  the scheduler has nothing placed or offered there). The owner can ask too (`POST /api/cluster/nodes/:id/update`).
  The worker refuses while it holds a job; else it runs `git pull --ff-only` in its checkout (`AGENT_ORCH_WORKER_SRC`,
  default its own directory), `npm ci` when the lockfile changed and a trial import of the new worker.mjs (any failure
  rolls back and is reported as `node.error {kind:'update'}`), then says `bye {reason:'update'}` and exits 0 for
  systemd (`Restart=always`) or launchd (`KeepAlive`) to start the new code. Its next hello on another sha ends the
  update; a failed one isn't retried on its own for the same target, and one that doesn't come back within 10 min fails.

## Power policy (#230)

A Mac is someone's laptop: it works for the cluster when that suits its owner. Each node has a policy on the
controller (`nodes.policy`, the owner's settings over the defaults for its OS: power.mjs `policyDefaults` /
`effectivePolicy`; PATCH /api/cluster/nodes/:id `{policy: {...} | null}`, the Machines view's Power panel). The
controller sends the effective policy plus `maxTasks` (`max_slots`, null = Auto) in `welcome` and, when the owner
changes either, `node.policy`; the worker enforces it, and the scheduler keeps to it too.

| setting | default | meaning |
| --- | --- | --- |
| `minBattery` | 50 | on battery power, new jobs only above this charge (%); null = only on AC power |
| `keepAwake` | `ac` | while jobs run, `caffeinate -i -w <worker pid>`: `ac` (only on AC power), `always`, `never` |
| `thermal` | `heavy` | no new jobs at this thermal pressure or worse: `moderate`, `heavy`, `off` |
| `reserveGB` | 3 (Mac), 0 (Linux) | RAM a new job must leave free for the owner (never below `MEM.claimFloor`) |

- **Readings** (worker, power.mjs `readPower`, no root, no powermetrics): `pmset -g batt` (charge, AC or battery),
  `pmset -g therm` (CPU speed limit, thermal warnings) and the thermal pressure level (`notifyutil -g
  com.apple.system.thermalpressurelevel`: nominal, moderate, heavy, trapping, sleeping; without it pmset alone: a speed
  limit is moderate, 70% or less heavy). Read once a minute, and again (≤ 15 s old) before an offer is answered.
- **Intake** (`intake(policy, power)`): on battery at or under `minBattery`, or at the `thermal` level or worse, the
  worker takes no new jobs. It says so in every `resources` frame (`intake {ok: false, reason, text}`); the controller
  shows the node as `paused` (view status; only from a reading on the current connection) and places nothing there,
  and an offer that races it is declined with reason `power`. Running jobs go on. No reading (a VPS, a Mac mini's
  battery) never blocks.
- **Caps**: at most `maxTasks` jobs (Auto: cores − 1 on a Mac, all cores elsewhere) and none that would leave less than
  `max(MEM.claimFloor, reserveGB)` free (`low_memory`). The controller's placement uses the same numbers.
- **Keep awake** (`createKeepAwake`): `caffeinate -i -w <worker pid>` runs while the worker has a job that isn't paused
  and `keepAwake` allows it for the power source; it is stopped (process group SIGTERM) when the last job ends, on
  battery under `ac`, or at shutdown, and exits by itself if the worker dies (`-w`). `-i` only prevents idle sleep: a
  closed lid still sleeps the Mac, and the failover above (grace, then reassignment from the pushed WIP) applies.
- **Service** (bin/install-worker-macos.sh): the worker runs as the dedicated `agentorch` user, by default from a
  LaunchDaemon (`/Library/LaunchDaemons/com.agent-orch.worker.plist`, `UserName agentorch`, from boot, no login
  needed) or with `--service login` from the owner's LaunchAgent via a sudoers-allowed launcher (while the owner is
  logged in). Both use `ProcessType Standard` with `Nice 5`.

## Compute-only workers (#232)

The owner's rule (BRIEF goal 11): a worker only computes. No chat, prompts, planner, reflection, settings or management
UI runs on it, and it takes work only from the head.

- **Allow-list** (cluster-protocol.mjs `WORKER_ACCEPTS`): connection upkeep (`welcome`, `heartbeat`, `ack`, `error`,
  `bye`), jobs (`job.offer/start/cancel/pause/resume/attach`, plus `git.credential` for their pushes), remote sign-in
  driven from the head's Connections (`login.*`), `models.refresh`, `limits.refresh`, `logs.tail`, `node.update` and
  `node.policy`. The worker decodes with `decode(raw, {from: 'c', accept: WORKER_ACCEPTS})`, which refuses any other
  type before validating it: the worker logs `rejected "<type>" from the controller` and answers `error`. A type added to
  the protocol later is refused until it is put on the list, and the list may never hold a chat-, prompt-, planner- or
  settings-like type (test/compute-only.test.mjs).
- **The head sends nothing else**: the hub's `send` throws for a type off the list. Only work tasks go to workers
  (orchestrator `remoteWork`: kind `work`, not an integrator); plan tasks (the owner's chat with the planner),
  reflection and review checkpoints stay on the controller, and `assertPlacement` throws if that ever breaks: in
  `claimNext` before the claim is recorded, and in `runRemote` before any frame goes out.
- **Nothing of the head runs there**: worker.mjs loads no server.mjs, orchestrator.mjs, cluster.mjs or runtimes.mjs (what
  it shares with the orchestrator, the done-when check and `toolLine`, is in taskrun.mjs). `node server.mjs` (and
  `set-password`) refuses to start on a paired worker: when `~/.agent-orch-worker/config.json` (`AGENT_ORCH_WORKER_HOME`)
  exists and the data dir holds no head state (`auth.json`, the orchestrator DB), it says why and exits 1 before it
  creates anything (role.mjs `headRefusal`). Processes a job runs carry `AGENT_ORCH_WORKER_JOB` and are exempt, so a
  project's own tests that start server.mjs (agent-orch's suite, screenshots) still run on a worker. To make a worker a
  head, unpair it first (the installer's `--uninstall --purge`).
- **No local control surface**: the worker opens no TCP port, and its only commands are `pair`, `run`, `status` and
  `limit` (the installers add `--uninstall`); any other says that its max tasks, power policy and draining are set on
  the head. They come only from there (`welcome.policy`, `node.policy`; draining is the head's own scheduling), with no
  local override. The one exception (#234, the owner's rule) is the machine's local cap, `limit`, which can only lower
  what it lends; its one local UI is the terminal status view over a 0600 unix socket (see Local cap and status view).
- **Installers**: bin/install-worker*.sh set up only the worker service (the systemd unit or launchd plist that runs
  `worker.mjs run`): no agent-orch web service, Caddy or ttyd.

## Local cap and status view (#234)

A worker's owner decides how much of the machine the cluster may use; everything else stays on the head.

- **The cap** (cap.mjs): `node worker.mjs limit --cpu <cores or N%> --mem <GB or N%> [--max-tasks N] [--only-on-ac]`,
  `--show`, `--reset`; only the parts given change, `off` removes one. Saved as typed in `config.json` (`cap: {cpu: 4 |
  '50%', mem: 8 | '50%', maxTasks, onlyOnAc, at}`) and resolved for the machine (`{cpu: cores, mem: bytes, maxTasks,
  onlyOnAc}`, null = none). `limit` asks the running daemon to reload it over the status socket (`{op: 'reload'}`), so
  it applies at once, and the daemon reports it in `inventory.cap` and every `resources.cap`, with what its jobs use
  (`jobsMem` bytes, `jobsCpu` cores: their process trees, from /proc or `ps`).
- **The head's ceiling** (orchestrator `nodeCap`, cap.mjs `capSlots`, `localCap` = `resources.cap` over
  `inventory.cap`): slots = min(the head's own setting (max tasks or Auto), the cap's max tasks, its CPU cap at
  `CFG.cpuPerTask` cores a task (1 until measured), and its running jobs + (RAM cap − `jobsMem` − footprints placed
  since that reading) / the agent's footprint). `--only-on-ac` makes a Mac on battery report no intake (`paused`).
  The Machines card says "Pooled: 4 cores · 8 GB (set on this Mac)".
- **The worker enforces it too** (worker.mjs, worker-cap.mjs): it declines a `job.offer` that would go over it (reason
  `cap`; `busy`/`low_memory` to an older head); every agent CLI and done-when check runs through a wrapper in
  `<home>/run` that records its pid and execs it under the cap: on Linux a transient scope per job (`systemd-run --user
  --scope -p CPUQuota=… -p MemoryMax=…`, the user manager kept by lingering; checked per spawn, else nice), on macOS a
  low priority (`nice -n 10`; no per-process quota without root, and `taskpolicy -b` would confine jobs to the
  efficiency cores); and a memory watch pauses the newest job when its jobs stay over the RAM cap for 30 s: WIP pushed,
  `job.done {outcome: 'aborted'}` with its session, so the head requeues it to resume later, and it isn't taken back
  there for 10 min. `AGENT_ORCH_WORKER_LIMITER=off|nice|systemd` overrides the choice.
- **Status view** (worker-status.mjs): `node worker.mjs status` draws, every second until q or Ctrl-C (plain ANSI,
  alternate screen), what the daemon answers on `~/.agent-orch-worker/worker.sock` (0600 in a 0700 dir; `{op:
  'status'}`): machine name, connection (Connected; Reconnecting while away less than its grace; Offline after that or
  when the token is refused), the cap and how jobs are held to it, CPU/RAM bars of the jobs' use against the cap,
  one line per running job (#id, title, agent·model, phase, elapsed, last activity), `queued` (the head's count of
  ready work tasks it could take, from `welcome`/`heartbeat`; orchestrator `upNext`) and the last 5 finished
  (outcome, duration). `--once`, or a stdout that isn't a terminal, prints one snapshot; a daemon that isn't running
  shows as such from `config.json` (exit 0). A socket that answers means another daemon runs with that home, and the
  new one exits before touching anything. macOS: `--status-window` adds a Terminal login item (a LaunchAgent running
  `open -a Terminal` on a root-owned script that re-runs itself as the worker's user under one sudoers rule).

## Security

- **Tokens**: the controller stores only `hashSecret(token)` (sha256) and `hashSecret(code)` for pairing codes; a
  one-time code expires in 10 min, a multi-use one pairs at most its `uses` machines within 1 h, and the owner can
  revoke either. Every machine gets its own token. Tokens are compared in constant time. The worker keeps its token
  in a 0600 file under `~/.agent-orch-worker/`.
- **Revocation**: removing a node in the UI deletes its row (and token hash), closes its socket (code 4003), and requeues its jobs; a revoked token
  is refused at the upgrade. Re-adding needs a new pairing code.
- **Only controller-originated jobs**: workers accept `job.*` commands only from the socket they dialled (TLS to the
  configured controller URL, certificate verified); `validate(msg, {from})` rejects worker-originated commands on the
  controller and controller-only types on the worker, and a worker acts only on its allow-list (`WORKER_ACCEPTS`, see
  Compute-only workers). Workers run no listener at all: **no inbound ports**.
- **Least privilege**: the worker runs as an unprivileged user with no sudo, touching only `~/.agent-orch-worker/`
  and its agent CLIs' own config dirs. On the Mac it runs as a **dedicated macOS user** (e.g. `agentorch`, standard
  account, FileVault on) so agents can't read the owner's home, keychain or browser profiles; launchd runs it as
  that user (a LaunchDaemon with `UserName`, or the owner's LaunchAgent through a one-command sudoers rule). Agent env is stripped exactly as on the controller (API_ENV / `envFilter`), so runs stay on
  the subscription login.
- **Agent sign-ins come from the head** (agent-share.mjs; the owner's rule: nothing to sign in on a worker). Two
  frames carry them, `agent.credential {agent, value}`, sent as a worker connects and whenever they change:
  - Claude: a long-lived token the owner creates once on the head (Connections → Claude for your machines → Share
    with machines runs `claude setup-token`; the token is captured from that session, which is then killed, and kept
    in `<DATA>/agent-share.json`, 0600). The worker holds it in memory and runs Claude with `CLAUDE_CODE_OAUTH_TOKEN`
    (no credentials file, no macOS Keychain). The head's own login and its refresh token never leave the head.
  - Codex: the head's `~/.codex/auth.json` (a ChatGPT login; copying it is how Codex signs in headless machines),
    written to the worker account's `~/.codex/auth.json` (0600). Its refresh token rotates, so a refresh made on any
    machine is sent back (W→C) and the head keeps it only for the same ChatGPT account and a newer `last_refresh`,
    then re-shares it; no machine is left with a used refresh token.
  Null stops sharing (the worker drops the token, or the copy it was given). A machine can still sign in to an
  account of its own (`login.*`, for more quota); its Connections row shows which applies.
- **Other secrets never travel over the wire**: the validators refuse any frame whose keys look like secrets
  (`secretKeys`: `*token`, `*secret`, `password`, `api_key`, `cookie`, `credential(s)`, `authorization`), except the two
  `*.credential` frames, and repo URLs with embedded credentials. `git.credential {host, token}` is a GitHub token the
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
