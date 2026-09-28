# agent-orch

A self-hosted, login-protected web UI for [Claude Code](https://docs.claude.com/en/docs/claude-code),
meant for a single owner on their own server.

- **The server** (`server.mjs`) runs chat sessions through Claude Code using
  `@anthropic-ai/claude-agent-sdk`. It also provides a folder browser, live server metrics, and browser
  terminals (tmux sessions shown through ttyd).
- **The orchestrator** (`orchestrator.mjs`) is the agent orchestrator behind a chat's "Orchestrator" mode. A planner
  breaks your goals into small tasks, each with a "Done when" check. Workers run each task in a fresh
  Claude Code session, verify it against that check, and commit the result to git. A reflector queues
  follow-up work when a project's queue is empty. A governor paces the work against the 5-hour and weekly
  plan usage limits, and sleeps until a limit resets. State is kept in SQLite (`node:sqlite`), and each
  project's memory is kept in `<project>/.agent-orch/`.
- **GitHub sync** (`github.mjs`) uses the `gh` CLI. Each project gets a private repo, and finished work
  is committed and pushed to `origin`.

This is plain Node ESM. There is no build step and no framework.

## Requirements

- **Node.js 22+**. The orchestrator uses the built-in `node:sqlite`.
- **Claude Code CLI** at `~/.local/bin/claude`, signed in with a Claude subscription (`claude`, then
  `/login`). The server uses this path directly.
- **tmux**. Browser terminals and the GitHub sign-in flow run in tmux sessions.
- **ttyd**, which serves `bin/term-attach.sh` to the browser.
- **Caddy** for HTTPS in front of the app. The server listens on `127.0.0.1` only.
- **gh** (GitHub CLI) and **git** for project repos. You can sign in with `gh` from the UI, which
  runs `gh auth login --web` in a terminal, or from any shell.

## Setup

```sh
git clone https://github.com/sanat-garg/agent-orch.git ~/agent-orch
cd ~/agent-orch
npm install
node server.mjs set-password '<password, 8+ chars>'   # writes data/auth.json and signs everyone out
PORT=3000 node server.mjs                               # listens on 127.0.0.1:3000
```

The server creates `~/workspace` (the default project folder, and the terminals' working directory) and
the data directory on startup. Run `npm test` to run the smoke suite (`node --test`), which starts throwaway servers
on free ports with a temporary `CW_DATA_DIR`.

This checkout is the live app. To try a change by hand, start a second instance with its own data dir, e.g.
`PORT=3999 CW_DATA_DIR=$(mktemp -d) node server.mjs`. Without `CW_DATA_DIR` it would share the live `data/`; the
orchestrator's lock file stops it from scheduling tasks there, but it would still rewrite chats and sessions.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. The server binds to `127.0.0.1` only. |
| `CW_DATA_DIR` | `./data` | Where all state lives, for both the server and the orchestrator. |
| `CW_DEVICE_NAME` | `Oracle VM` | The name shown for this machine in the UI. |
| `CW_WS_KEEPALIVE_MS` | `30000` | How often open WebSockets are pinged and their login session re-checked (expired or revoked sessions are closed). |
| `CW_NO_ORCHESTRATOR` | unset | `1` boots without the orchestrator: the DB is opened and migrated and the UI can read tasks, but no task is claimed, requeued or scheduled, the background git push retry is off, and the data-dir lock is not taken. For preflights against a copy of real data. |
| `AGENT_ORCH_BROWSER_HOME` | home directory | The folder that holds `.agent-orch-browser/` for the live browser view: its profiles and take-over flags. Tests point it at a temp dir. |
| `AGENT_ORCH_WORKER_BROWSER` | `install` | On a worker: `install` finds a Chromium/Chrome at start and installs Playwright's Chromium when there is none, `check` only looks, `off` skips it (the worker then gets no browser tasks). Under `node --test` the default is `check`. |
| `PATH` | inherited | Passed to Claude Code and agents. The orchestrator prepends `data/orchestrator/bin`, which holds `python`/`pip` shims pointing to `python3`/`pip3` when only those exist. |

The server also passes its whole environment on to Claude Code, **except** the variables listed under
Security, which it removes.

### Terminals: ttyd + Caddy

The UI loads terminals from `/shell/?arg=<name>`. Caddy asks the app whether the request is logged in
(`forward_auth` to `/auth/check`) before proxying to ttyd. ttyd runs `bin/term-attach.sh <name>`, which
attaches to the tmux session with that name, or creates it (in `~/workspace`). Session names must match
`[A-Za-z0-9_-]{1,32}`.

```caddyfile
your.host.example {
	encode gzip
	handle /shell/* {
		forward_auth 127.0.0.1:3000 {
			uri /auth/check
		}
		reverse_proxy 127.0.0.1:7682
	}
	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
```

The session cookie is set with `Secure`, so the app has to be served over HTTPS. Caddy handles this
automatically.

### Running as systemd services

`/etc/systemd/system/agent-orch.service`:

```ini
[Unit]
Description=agent-orch (login + chat UI)
After=network-online.target
# Keep retrying after a crash loop; the default start limit (5 starts in 10 s) would leave the unit failed.
StartLimitIntervalSec=0

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/agent-orch
Environment=PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=PORT=3000
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.mjs
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/agent-orch-shell.service`, a matching ttyd unit bound to loopback and serving under `/shell`:

```ini
[Unit]
# Keep retrying after a crash loop; the default start limit (5 starts in 10 s) would leave the unit failed.
StartLimitIntervalSec=0

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/workspace
Environment=PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=TERM=xterm-256color
ExecStart=/usr/bin/ttyd -W -O -a -b /shell -i 127.0.0.1 -p 7682 /home/ubuntu/agent-orch/bin/term-attach.sh
Restart=always
```

For terminals to survive restarts of the web app, also run a `tmux -D` server as its own unit, `agent-orch-tmux.service`. Then run
`sudo systemctl daemon-reload && sudo systemctl enable --now agent-orch agent-orch-shell agent-orch-tmux caddy`. The metrics
panel checks service status with `systemctl is-active agent-orch agent-orch-shell caddy`.

The app restarts itself through `Restart=always`: "Restart when idle" (`POST /api/restart-when-idle`) drains tasks and chat turns, then exits 0
once the code at HEAD passes a preflight (`node --check` on every root and `bin/` `*.mjs`, then a throwaway boot of `server.mjs` on a spare port);
a failed preflight keeps the old code running, logs `[restart] preflight failed` and skips that HEAD.
With the `autoRestart` setting on (off by default; `PUT /api/orch/parallel {autoRestart: true}`), it does the same by itself once merged commits since boot touch server code (root `*.mjs`, `bin/`, `package*.json`).

### Moving an old `claude-web` install

Installs that predate the rename live in `/home/ubuntu/claude-web` and run the units `claude-web`, `claude-shell` and
`claude-tmux`. To move one, run `bin/rename-install.sh` once as `ubuntu` (it needs sudo). The script stops the app and moves the directory to
`/home/ubuntu/agent-orch`. It rewrites the units as `agent-orch*`, then updates the old path in the orchestrator DB
(project path and name, run log paths) and in `data/convos.json`. It also renames `~/.claude/projects/-home-ubuntu-claude-web` so chats
can still resume. Finally it starts the new units and prints their status. It is safe to re-run. Start with `--dry-run` to print every
action without doing it. Because it restarts the app, don't run it from inside an agent-orch chat or terminal.

## Coding agents

Chats and orchestrator tasks can run on two coding agent CLIs. The adapters live in `agents.mjs`, and
research notes on each CLI are in `.agent-orch/AGENTS.md`.

| Agent | Binary | Install | Subscription login (once, over SSH or `/shell/`) |
|---|---|---|---|
| Claude Code (default) | `~/.local/bin/claude` | see Requirements | `claude`, then `/login` |
| OpenAI Codex CLI | `codex` on `PATH` | `sudo npm i -g @openai/codex` | `codex login --device-auth`, then open the URL and enter the code. You may first need to enable device code authorization for Codex in ChatGPT's security settings. `codex login status` should say "Logged in using ChatGPT". |

**Connections.** The button at the foot of the sidebar (or **Connections…** at the end of the model picker)
opens the Connections modal. It runs each CLI's login in a hidden tmux pane and shows the URL and one-time
code to enter elsewhere (Claude asks you to paste its code back). Signing in there works for every agent above.

**Models.** Model lists come only from the CLIs themselves, never a hardcoded list. They are cached in
`data/models.json`. Each discovery starts a CLI, so a list is only re-read once it is a day old (checked hourly,
one agent at a time) or after that agent's sign-in changes.

**Plan limits.** Nothing polls them. The sidebar usage card shows the last saved reading; its refresh button
checks the one agent it is showing (`POST /api/limits/<agent>/refresh`, or the Claude usage probe), at most once a
minute per agent. Orchestrated Claude runs still report their limits as they go, and a limit hit by any run is
recorded when it happens.

**Stats.** The chart button at the foot of the sidebar opens Stats: what you and the orchestrator did, for all
time or the last 30 days, 7 days or 24 hours, for every project or just one. *Overview* leads with tasks shipped and
generated insights (how much agent time ran while you were away, how full each 5-hour window got before it reset, what
the done-when checks caught, ask-to-ship time), a who-worked-when heatmap and records. *You* covers your rhythm, how you
steer and what you ask for; *Agents* compares every model (time, runs, outcomes, tokens per shipped task, cache hits)
and shows plan-window use, limit hits and hand-offs; *Projects* shows code growth, who wrote the code and hotspots.
`GET /api/stats` (stats.mjs) returns the raw records from the task DB, chat logs, usage log, server metrics and git
history; the browser does the slicing, in your timezone.

**Subscription only, never API keys.** Each adapter removes its billing variables from the environment
before starting the CLI:

- Claude: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`.
- Codex: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT_ID`,
  `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `CODEX_AUTH`, `CODEX_HOME` and every `AZURE_OPENAI_*`. Every run also
  passes `-c forced_login_method="chatgpt"`, and an API-key login counts as logged out.

**Chat picker.** The model menu in a chat is grouped by agent (fed by `GET /api/agents`). Pick an agent's
default model or a specific one. Groups for agents that aren't installed or logged in are disabled and show
why, including the login command. Non-Claude chats run one headless CLI turn per message and resume the
agent's own session. They have no permission prompts. Orchestrator mode always plans on Claude.

**Routing rules.** Tell the planner in chat, for example "use codex for tests" or "use opus
for planning". It saves a rule with a `match` (a task kind, `work`, `reflect` or `plan`, or a keyword in the
task title), an agent and/or model, and a scope: this project (default) or all projects. A new rule with the
same match and scope replaces the old one. For each task the orchestrator picks, in order:

1. the task's own agent/model, if the planner set one;
2. the first matching project route;
3. the first matching global route;
4. Claude on the project's model.

The planner itself always runs on Claude (a `plan` route only changes its model). Rules are listed in the
orchestrator bar under **Settings → Routing rules**, each with a **Delete** button. You can also ask the
planner to remove one.

**Fallback.** If the picked agent isn't installed or isn't logged in, the task runs on Claude instead and the
reason is logged. The Routing rules list marks such a rule "not logged in, falls back to Claude" (or "not
installed"). Login status is checked at most once a minute, so after signing in it can take a minute to be
picked up. Each task shows the agent and model its latest run used.

**Delegation.** There is no benchmark scoring or automatic ranking. You enter ordered fallback lists by hand:
one per chat (Auto Delegate in the model picker), used by the tasks that chat plans, and one per project for
reflection tasks (**Settings → Reflection fallbacks** in the orchestrator bar). Each task keeps a copy of its list.
When a queued task's model is at its usage limit, it moves to the first model in that list whose agent is
signed in, still lists that model, isn't blocked and has no usage window at 90% or more. Each move is
recorded on the task. With an empty list, the task waits for its own model. Limits are per agent, so one agent's
limit never blocks another's.

## Skills, MCP servers, subagents and personas

**Settings → Skills & tools** (the sidebar gear) has one tab for each:

- **Skills** are instructions, plus any files they need, that an agent loads when a task calls for them. They are
  saved where the CLIs look for them: `~/.claude/skills/<name>/SKILL.md` for Claude Code and `~/.codex/skills/<name>/`
  for Codex. Chats, tasks and the Terminal all use them. Skills you installed by hand show up there too. You can write
  one, or import a folder from GitHub (for example `https://github.com/anthropics/skills/tree/main/skills/pdf`). An
  import is a shallow, sparse clone of just that folder, so private repos work with your git credentials.
- **MCP servers** give agents extra tools. They are saved in `data/extensions/mcp.json` and started for every chat
  turn and task run on this server. They reach the CLIs through `0600` files, never command-line arguments:
  Claude gets `--mcp-config data/extensions/claude-mcp.json` and Codex gets `-p agent-orch`
  (`~/.codex/agent-orch.config.toml`). The page shows saved env values and headers as `••••••`.
- **Subagents** are specialists Claude Code can hand part of a task to: `~/.claude/agents/<name>.md` (Claude only).
- **Personas** set how a chat's agents work and talk. Pick one per chat with the persona button in the composer.
  It is added to that chat's system prompt and to its project's planner and task runs, and applies from the next message.

**Worker machines** run tasks with the same skills, subagents and enabled MCP servers as this server, plus the
task's persona. You manage them only here. When you change one, every connected worker is told. Each task also names
the set it needs, so a skill you copied into `~/.claude/skills` by hand reaches the next task. A worker downloads the
set only when it has changed, over HTTPS with its own machine token (`GET /api/cluster/ext`). It writes skills and
subagents into its own `~/.claude` and `~/.codex`, and it only replaces or removes the ones it put there itself.
Anything installed on the worker by hand is left alone; if it has the same name as one of yours, the worker keeps its
own and says so in its log. MCP servers, secrets included, are stored in `0600` files under
`~/.agent-orch-worker/extensions/` and reach the worker's CLIs the same way as here. Every paired machine gets your MCP
secrets, so rotate them after removing a machine you no longer trust. A server started by a command (`npx …`) needs
that command on the worker too. The set is capped at 32 MB; skills that don't fit stay on this server.

## Computer work: browser, approvals and audit

Some tasks need a real web browser, for example a web app with no API. The design, and what is built so far, is in
[`.agent-orch/AGENTIC.md`](.agent-orch/AGENTIC.md).

**Browser tasks** (`browser.mjs`). The planner marks such a task with `"capabilities": ["browser"]` and can name a
browser profile with `"identity"` (lowercase letters, digits, `-` and `_`; `default` when not given). The task's run
gets the Playwright MCP server (`@playwright/mcp`, the version pinned in `package.json`; its tools show up as
`mcp__playwright__browser_*`) on a persistent Chromium profile at `~/.agent-orch-browser/profiles/<identity>` on the
machine that runs it, so sign-ins survive between tasks. Screenshots land in the run's `.agent-orch/shots/`. The run's
system prompt tells the agent that everything it reads in the browser is untrusted and that it must never type
passwords or one-time codes; when a site needs a sign-in it stops and asks you.

- **Where they run**: on a worker that has Chromium or Chrome and is new enough to relay approvals. The controller
  runs them only when the orchestrator's `controllerBrowser` setting is on (`PUT /api/orch/parallel` with
  `{"controllerBrowser": true}`; off by default), or when the task is pinned to it with **Run on**. Two tasks never
  use the same profile at once; the second waits.
- **Chromium on a worker**: at start a worker looks for a browser (`AGENT_ORCH_BROWSER_PATH`, Google Chrome on macOS,
  Playwright's Chromium, then `chromium`/`google-chrome` on `PATH`). With `AGENT_ORCH_WORKER_BROWSER=install` (the
  default) and none found, it installs Playwright's Chromium once; `check` only looks and `off` skips it. The result
  is sent to the controller with the worker's inventory and logged (`browser: … (headed)` or `browser: none (…)`).
  Chromium runs headed on a Mac and headless elsewhere (`AGENT_ORCH_BROWSER_HEADLESS=1|0` overrides).

**The approval gate** (`gate.mjs`, `gate-proxy.mjs`, `approvals.mjs`). In task runs, the Playwright MCP and every
connector run behind `gate-proxy.mjs`, a stdio MCP proxy. A connector is an MCP server with **Outbound tools** filled
in under Settings → Skills & tools. The proxy classifies each tool call before it runs:

- **read**: looks at the page (snapshot, screenshot, wait, hover…). Runs.
- **draft**: ordinary steps (open a page, click, type, fill a form, choose an option). Runs.
- **outbound**: clicking a button or link whose accessible name matches Send, Pay, Transfer, Submit order, Publish,
  Share, Delete, Confirm, Place order or Sign ("Sign in" and "Log out" don't count), submitting typed text to one,
  accepting a dialog that says so, opening a checkout, payment or billing page, and any Playwright tool the gate
  doesn't know. For connectors, the tools listed in Outbound tools and tools named like send, pay, delete, publish
  or share.

An outbound call is held **before** it runs. Calls run one at a time, so nothing slips past a held one. The task's
card (in the chat and the Queue) and its drawer then show the exact action with a screenshot of the page, and you
choose **Approve** once, **Always** (the same action is allowed without asking for the rest of this task) or
**Deny** with a reason, which reaches the agent as a tool error; the call is never made. An approval nobody answers
is denied after 24 hours. Time spent held doesn't count toward the task's timeout. On a worker the proxy asks through
files in the run's gate dir and the worker relays the request to the controller, so the flow is the same everywhere.

Every call, whatever its class, is logged to `data/audit/<task>.jsonl` (hash-chained, secrets redacted), with
screenshots saved as media. The task drawer's **Actions** section shows that log. **Settings → Ask me before** adds
your own names, one per line, to the default list (a plain phrase matches whole words; `/regex/` is also accepted).
`GET`/`PUT /api/orch/gate` reads and sets `{patterns, ttlHours}`, where `ttlHours` (up to 336) replaces the 24-hour
expiry.

**Live browser view** (`browser-live.mjs`, `browser-view.mjs`, `public/browser.js`). The globe in the sidebar opens
the **Browser** sheet: every machine that can run a browser, its profiles, the sites each is signed in to (cookie
domains only) and **Clear**. **Open** streams the profile's Chromium into the page, and your mouse, touch, keys and
paste go back to it, with a URL bar, Back and Reload. Use it to:

- **Sign in once** on a profile (2FA and CAPTCHAs included) before any task needs it. Tasks on that identity reuse the
  cookies.
- **Watch a run**: the viewer and the task's MCP share one Chromium per profile, and a running browser task's drawer
  shows a small live thumbnail.
- **Take over**: while you control it, the task's browser actions wait; **Hand back** (or closing the view) lets
  them continue.

The profile's own machine runs the browser: the controller directly, a worker through the cluster connection.

**Workers get the same extensions** (`extensions.mjs`). When your skills, subagents or MCP servers change, the
controller sends every worker an `ext.sync` frame with the set's hash, and each job names the hash it needs (plus the
task's persona). The worker's `applyBundle` downloads and applies the set only when that hash differs from its own
(see [Skills, MCP servers, subagents and personas](#skills-mcp-servers-subagents-and-personas)). Nothing has to be
copied to a worker by hand for a browser or connector task. The Playwright MCP itself comes with each checkout.

## Parallel tasks and git worktrees

In a project that is a git repository, each work task runs in its own git worktree at
`<repo>/../.agent-orch-worktrees/<repo>-task-<id>` on branch `agent-orch/task-<id>`, so several tasks can edit
at once without seeing each other's changes. Projects outside git (or on a detached HEAD) run in the main tree.

- **One task at a time**: by default exactly one work task runs across all projects (plan tasks and chat turns
  run beside it). Orchestrator settings → **Parallel tasks: 2** allows a second one only while `/proc/meminfo`
  shows over 2.5 GB `MemAvailable` and under 25% swap in use, re-checked before every claim; the second task
  runs on another agent from the fallback list. The planner plans sequential chains.
- **Memory guard**: nothing is claimed while `MemAvailable` is under 800 MB. If it stays under 300 MB for 30 s,
  the newest running task is paused (`Paused #N: server memory low`) and resumes its session later.
- **`files`** (optional): paths or globs the task will change. When two tasks may run, overlapping lists
  (or a task without `files`) keep them apart.
- **`after`**: true prerequisites only. A task starts once all of them are done, and cancelling or failing one
  cancels everything after it.
- **Cheap worktrees**: `node_modules` is a symlink to the main checkout's, and a worktree is removed right after
  its merge.

When a task passes its check, the orchestrator squashes its branch to one commit, rebases it onto the main
tree's branch, fast-forwards the main tree and syncs it to GitHub. Only this merge step touches the main tree, one task at
a time. `JOURNAL.md` uses a union merge, so shared appends never conflict. If the rebase conflicts, the task
becomes **needs integration**: its worktree is kept and an `Integrate #<id>` task is queued in the same
worktree. That task merges the main branch in, resolves the conflict markers, re-runs the check and lands the
work, which marks the original task done. Failed or cancelled work is committed to its branch and the worktree
removed, so a retry can pick it up.

## Adding machines

Open **Server details** (the stats card at the bottom of the sidebar) → **Machines** → **Add machine**. Pick how many
machines to add. One gets a one-time pairing code, valid 10 minutes. Two to ten get one code for all of them, valid
1 hour: run the same line on each machine, up to that many. The wizard shows one line per OS with the code built in;
click it to copy, then run it on the new machine:

```sh
# Linux VPS (systemd), as a normal sudo user
curl -fsSL https://<your-host>/install/worker-linux.sh | bash -s -- --controller https://<your-host> --code ABCD-1234 --agents claude,codex
# macOS (launchd), from your own logged-in admin account
curl -fsSL https://<your-host>/install/worker-macos.sh | sudo bash -s -- --controller https://<your-host> --code ABCD-1234 --agents claude,codex
```

The wizard shows "Waiting for the machine to connect…", then each machine's name once it claims the code, then
"Connected" when its worker dials in. A multi-use code lists every machine that paired with it. **Revoke code** stops
it early; the machines that already paired stay. Codes are stored as hashes, so a server restart doesn't void one.
After that, sign the agents in on each machine (Connections has a switcher for them).

Each machine pairs as a node of its own, with its own token. It names itself: a Mac after its model and local host
name, like "MacBook Pro (Sanat-MBP-2)", a Linux box after its hostname. Two machines with the same name get " 2"
appended. **Rename** changes it on its card; `--name` sets one at install time.

The scripts are `bin/install-worker.sh` and `bin/install-worker-macos.sh` (the server serves them without a login at
`/install/…`; the pairing code is the only secret). They:

- install Node 22 if missing (nvm when present, else the official arm64/x64 tarball in `~/.local/node`);
- install `gh` if needed (apt on Linux), run `gh auth login` if GitHub isn't signed in, then `gh auth setup-git`;
- clone or update github.com/sanat-garg/agent-orch into `~/agent-orch-worker` and run `npm ci`;
- with `--agents claude,codex`, install missing agent CLIs (`curl -fsSL https://claude.ai/install.sh | bash`,
  `npm i -g @openai/codex`);
- pair with `node worker.mjs pair --controller … --code …` (a one-time or a multi-use code);
- install the service. Linux: `/etc/systemd/system/agent-orch-worker.service` with `Restart=always` and
  `MemoryHigh=85%`, which throttles the worker before the machine runs short. macOS: see below.

Both scripts are idempotent: re-running updates the checkout and the service and keeps the existing pairing unless
you pass a new `--code`. Re-running with a code pairs the machine again as a new node, which uses up one more use of a
multi-use code; remove the old entry in Machines. `--dry-run` prints every step without changing anything.
`--uninstall` removes the service and the checkout. Add `--purge` to delete `~/.agent-orch-worker` too. Then remove
the machine in the UI.

### macOS: a dedicated user, a LaunchDaemon, and a power policy

**The worker runs as a dedicated user.** Agents run on their own with full permissions. Under your account they
could read your documents, keychain, browser profiles and SSH keys. So the macOS script creates a hidden standard user,
`agentorch` (`--user` to rename it), with `sysadminctl`, and installs and pairs everything as that user. Sign the
agents in as that user too: from the head's Connections window, or on the Mac with `sudo -u agentorch -H claude`.
`--no-dedicated-user` installs under your own account (run it without sudo), but this isn't advised.

**How it starts** (`--service`):

- `daemon` (the default, recommended): a LaunchDaemon, `/Library/LaunchDaemons/com.agent-orch.worker.plist`, with
  `UserName agentorch`. launchd starts the worker at boot, whether or not anyone is logged in, and restarts it if it
  stops (`KeepAlive`). Its log is `/Users/agentorch/Library/Logs/agent-orch-worker.log`. Check it with
  `sudo launchctl print system/com.agent-orch.worker`.
- `login`: it starts when you log in and stops when you log out. Your own LaunchAgent
  (`~/Library/LaunchAgents/com.agent-orch.worker.plist`) starts it as `agentorch` through a root-owned launcher,
  `/usr/local/bin/agent-orch-worker-run`. A sudoers rule (`/etc/sudoers.d/agent-orch-worker`) lets you run that one
  command as `agentorch` and nothing else. (A LaunchAgent inside the hidden `agentorch` account itself would only run
  while someone is logged in as `agentorch`, which is why this mode hooks into your login instead.)

Either mode removes the other's files, so a Mac never runs two workers. Both run the worker at `Nice 5` as a standard
process: it can use every core, but your apps win when they compete.

**Power policy.** Each Mac follows a policy set on the head: its card in Machines → **Power**. The worker enforces
it, and the head places nothing on a Mac that says it takes no work.

| Setting | Default | Choices |
| --- | --- | --- |
| New tasks on battery | above 50% (on AC power: always) | never (AC power only), above 25/50/75%, at any charge |
| Keep awake while tasks run | on AC power | on AC power, always, never |
| Pause new tasks when hot | at heavy thermal pressure | heavy, from moderate, never |
| RAM kept free for you | 3 GB | 1–8 GB |
| Max tasks (on the card) | Auto: cores − 1 | Auto, 1–4 |

- A Mac that takes no new tasks shows **Paused** with the reason, such as "On battery at 42%: takes new tasks above
  50%". Tasks already running go on either way.
- While tasks run, the worker holds the Mac awake with `caffeinate -i -w <worker pid>`: only while it has tasks, and by
  default only on AC power. It stops with the last task, when the Mac goes on battery, or when the worker exits.
- Heat is read without root or powermetrics: `pmset -g therm` (the CPU speed limit) and the system's thermal pressure
  level (`notifyutil -g com.apple.system.thermalpressurelevel`). Battery and power source come from `pmset -g batt`.
- Auto sizing leaves one core and the reserved RAM to you: a task starts only if the Mac keeps its RAM reserve (3 GB)
  after it, and at most cores − 1 tasks run. A new Mac starts on Auto; a new Linux node starts at 1 task.
- `caffeinate -i` only stops idle sleep. **Closing the lid or choosing Sleep still sleeps the Mac.** The head then shows
  it as "Mac asleep", waits its grace period (5 minutes by default), and moves its tasks to another machine from their
  last pushed work. When the Mac wakes, it reconnects and drops the tasks that moved.

### Pair 4 Macs in one go

1. On the head: Server details → Machines → **Add machine** → **Add: 4 machines**. The wizard shows one code, valid
   for an hour, and the macOS line. Copy the line.
2. On each Mac, from an admin account: open Terminal, paste the line and enter your password when sudo asks. The
   first time, sign in to GitHub when the script asks (it clones and pushes as `agentorch`). The Mac installs
   everything, pairs, and starts its LaunchDaemon.
3. Back in the wizard, each Mac appears by name as it pairs, then shows **Connected**. You can close the wizard between
   Macs; reopening it shows the same code while uses are left.
4. After the fourth Mac, the code stops working. If you paired fewer, press **Revoke code**; otherwise it expires
   after the hour.
5. Sign the agents in on each Mac: Connections → pick the Mac at the top → sign in to Claude Code and Codex. The same
   subscription on several Macs shares one set of rate limits.
6. Check each Mac's card: rename it if needed, and set its **Power** policy. For example, choose "Never: AC power only"
   for a Mac you carry around.

A second VPS works the same way: the Linux line with the same code adds it too, if the code has a use left.

## Worker machines

Extra machines (a second VPS, a Mac) run `worker.mjs`, which dials out to this server over WSS (no inbound port) and
runs orchestrator tasks in its own checkouts. Design: `.agent-orch/CLUSTER.md`. On the worker (Node 22+, git, this
repo checked out, `npm ci`):

```sh
node worker.mjs pair --controller https://<your-host> --code ABCD-1234   # code from "Add machine"; --name to pick its name
node worker.mjs run                                                      # the daemon
node worker.mjs status [--once]                                          # the live status view (q quits)
node worker.mjs limit --cpu 4 --mem 8 [--max-tasks 2] [--only-on-ac]     # cap what it lends; --show, --reset
```

- Pairing stores the node token in `~/.agent-orch-worker/config.json` (mode 0600). Everything else lives there
  too: `repos/` (bare cache clones), `worktrees/` (one per job, removed when it finishes), `deps/` (`node_modules`
  cached by lockfile hash), `logs/worker.log` and `logs/jobs/<id>.jsonl`, `extensions/` (this server's MCP servers and
  a list of the skills and subagents it synced, see above). `AGENT_ORCH_WORKER_HOME` moves it.
- **Credentials come from the machine's own login**: sign Claude Code and Codex in locally, and set up git so it can
  fetch and push the project repos (`gh auth login` then `gh auth setup-git`, or an SSH key). The only secrets sent
  to the worker are your MCP servers' env values and headers (with the skills, see Skills, MCP servers, subagents and
  personas) and a GitHub token you explicitly authorise per node (`git.credential`, kept in memory only).
- Run it as a dedicated unprivileged user under systemd (`Restart=always`) or, on macOS, a LaunchDaemon with
  `UserName` (see Adding machines). On stop it pauses running jobs and pushes their work first. It reconnects with
  backoff forever and runs its own reaper for leftover agent processes (`AGENT_ORCH_REAPER=off` disables it).
- **It is compute-only**: no chat, planner, reflection or web UI, and no TCP port. It acts only on the head's job,
  sign-in, refresh, log, update, policy and extension-sync messages, and rejects (and logs) anything else. Its only
  commands are `pair`, `run`, `status` and `limit`. `node server.mjs` refuses to start on a paired worker; to make the machine a
  head instead, unpair it first (the installer's `--uninstall --purge`).
- **Status view**: `node worker.mjs status` is a live terminal view (refreshed every second, q or Ctrl-C quits;
  `--once` prints one snapshot): the connection to the head (Connected, Reconnecting, Offline), the cap in effect, the
  CPU and RAM its jobs use against it, one line per running job (phase, time, last activity), how many tasks are up
  next on the head for it, and the last five finished. It reads the daemon over a unix socket in its home
  (`worker.sock`, mode 0600). On a Mac run it as the worker's user (`sudo -u agentorch -H node …/worker.mjs status`);
  the installer's `--status-window` opens it in Terminal at every login.
- **Its one local setting is a cap on what it lends**: `node worker.mjs limit --cpu <cores or N%> --mem <GB or N%>
  [--max-tasks N] [--only-on-ac]` (only the parts given change; `off` removes one; `--show`, `--reset`). It is saved in
  `config.json`, the running worker applies it at once, and the head treats it as a hard ceiling: that machine's slots
  are at most its max tasks, its CPU cap at one core a task, and its running jobs plus what fits in the rest of its RAM
  cap. The worker also declines offers over it, runs each job in a systemd scope with `CPUQuota`/`MemoryMax` on Linux
  (the installer enables lingering for that) or at a low priority, and pauses its newest job when its jobs stay over
  the RAM cap for 30 s (the task resumes later). Machines shows it as "Pooled: 4 cores · 8 GB (set on this Mac)".
- **It follows the power policy and caps the head sets for it** (Machines → Machine settings: Parallel tasks, Staying awake): on a Mac, no new tasks
  on low battery or when hot, and `caffeinate` only while tasks run (see Adding machines).
- **It reports to this server**: each job's steps (shown as a timeline in the task drawer), health telemetry every
  10 s (kept for 24 h in `<DATA>/metrics/nodes/`, `GET /api/cluster/nodes/:id/metrics?range=1h`) and its errors; `GET
  /api/cluster/nodes/:id/logs?tail=200` fetches its log. A worker with under 2 GB of disk free, one that keeps losing
  its connection, or one where tasks keep failing that no other machine fails is drained automatically, with a notice.
- **It updates itself**: once it is more than 20 commits behind this server's `origin/main` (`AGENT_ORCH_OUTDATED_COMMITS`),
  it takes no new tasks, and when idle it runs `git pull --ff-only` in its checkout (plus `npm ci` when the lockfile
  changed) and restarts through its service. Keep that checkout free of local changes. Server details → Machines also
  has an Update button.

## Screenshots

`bin/shot.mjs` screenshots a page with Playwright's Chromium (`playwright-core` is pinned to the version
whose Chromium build is cached in `~/.cache/ms-playwright`; run `npx playwright-core install chromium` if it
is missing):

```sh
node ~/agent-orch/bin/shot.mjs <url> [out.png] [--full] [--width=1280] [--height=800] [--mobile] [--wait=ms] [--cookie=name=value]
```

Without `out.png` it saves to `.agent-orch/shots/<timestamp>-<slug>.png` in the current directory and prints
the path. Every image an agent saves under a project's `.agent-orch/shots/` shows up in that chat or task,
and the worker and chat prompts tell agents to take before/after shots whenever a change is visual.

To shoot agent-orch's own logged-in pages, start a test server with a temp data dir and mint a session
in it (never point this at the live `data/`):

```sh
export CW_DATA_DIR=$(mktemp -d) TOKEN=$(openssl rand -hex 32)
echo "{\"$TOKEN\":{\"exp\":9999999999999,\"remember\":true}}" > $CW_DATA_DIR/sessions.json
PORT=3999 node server.mjs &
CW_SHOT_COOKIE=$TOKEN node bin/shot.mjs http://127.0.0.1:3999/
```

`CW_SHOT_COOKIE` takes `name=value`, or a bare token meaning `cw_session=<token>`.

## data/

All runtime state lives in `data/` (or `CW_DATA_DIR`). The JSON state files (`auth.json`, `sessions.json`,
`convos.json`) are written with mode `0600`; keep `data/` itself at `0700`.

| Path | Contents |
|---|---|
| `auth.json` | scrypt salt and hash of the login password |
| `sessions.json` | active login session tokens |
| `convos.json` | the chat list (title, folder, mode, agent, model, agent session id) |
| `logs/<id>.jsonl` | the transcript of each chat |
| `metrics/` | `raw.jsonl` and `minutes.jsonl` server metrics |
| `orchestrator/agent-orch.db` | the orchestrator SQLite database (migrated from `ao2.db` on start) (projects, tasks, runs, events, usage limits) |
| `orchestrator/runs/` | per-run agent logs |
| `orchestrator/lock` | PID of the process that runs the orchestrator; a second instance on the same dir won't schedule tasks |
| `orchestrator/bin/` | `python`/`pip` shims |
| `extensions/` | MCP servers (`mcp.json`, with their secrets), the `--mcp-config` file Claude runs read, and personas (`personas.json`) |

`data/` is in `.gitignore` and must never be committed. It contains the password hash, live session
tokens and private chat content. An earlier history of this repo tracked `data/auth.json`, which is why
the repo was restarted with fresh history.

## Security notes

- **Subscription-only auth.** Chat and agents must bill the Claude subscription, never API credits.
  Before starting Claude Code, `server.mjs` removes every variable matching `API_ENV`
  (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`) from the environment it passes on. If a chat
  session still reports an API-key auth source (`apiKeySource`), the session is stopped with an error.
  Don't weaken this.
- **Agents run with `bypassPermissions`.** Orchestrator workers, the planner and the reflector run with
  `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true`. They get no
  permission prompts, and no tool is refused, including edits to this app's own code. Roles are enforced
  by prompt instructions only. New chats also default to `bypassPermissions`. Run this only on a
  disposable server you're willing to hand to an autonomous agent.
- **Login.** There is a single password, stored as a scrypt hash. Over HTTPS the session cookie is
  `__Host-cw_session` (`HttpOnly; Secure; SameSite=Lax`, so no other host can set or shadow it); plain-http
  local use gets a non-Secure `cw_session`. It lasts up to 30 days. Every response forbids framing. After 5 failed logins, an IP is locked out for
  15 minutes. POST requests and WebSocket upgrades must be same-origin. `set-password` signs out every
  session.
- **Loopback only.** The app listens on `127.0.0.1`, and ttyd should too. The client IP used for lockout
  comes from `X-Forwarded-For`, which is trusted because only Caddy should reach the port. Don't expose
  port 3000 or 7682 directly.
- **GitHub.** Repos that the orchestrator creates are private, and each gets a `.gitignore` that excludes `.env*`,
  keys and build output.
- **Web Push.** Notifications to the home-screen app are signed with a VAPID key pair that `push.mjs` makes on first
  start with node:crypto and keeps in `data/push-vapid.json` (mode 0600); subscribed devices are in
  `data/push-subscriptions.json`. Both live under `data/`, which is never tracked. Payloads are end-to-end encrypted
  (aes128gcm, RFC 8291), so the push service only sees ciphertext. Deleting the key file makes a new pair and
  every device has to subscribe again.
