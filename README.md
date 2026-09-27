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

Worker machines get a task's persona, but not yet the skills, subagents or MCP servers.

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

Open **Server details** (the stats card at the bottom of the sidebar) → **Machines** → **Add machine**. It creates a
one-time pairing code (valid 10 minutes) and shows one line per OS with the code built in; click it to copy, then run
it on the new machine:

```sh
# Linux VPS (systemd), as a normal sudo user
curl -fsSL https://<your-host>/install/worker-linux.sh | bash -s -- --controller https://<your-host> --code ABCD-1234 --agents claude,codex
# macOS (launchd), from your own logged-in account
curl -fsSL https://<your-host>/install/worker-macos.sh | sudo bash -s -- --controller https://<your-host> --code ABCD-1234 --agents claude,codex
```

The wizard shows "Waiting for the machine to connect…", then the machine's name once it claims the code, then
"Connected" when its worker dials in. After that, sign the agents in on that machine.

The scripts are `bin/install-worker.sh` and `bin/install-worker-macos.sh` (the server serves them without a login at
`/install/…`; the pairing code is the only secret). They:

- install Node 22 if missing (nvm when present, else the official arm64/x64 tarball in `~/.local/node`);
- install `gh` if needed (apt on Linux), run `gh auth login` if GitHub isn't signed in, then `gh auth setup-git`;
- clone or update github.com/sanat-garg/agent-orch into `~/agent-orch-worker` and run `npm ci`;
- with `--agents claude,codex`, install missing agent CLIs (`curl -fsSL https://claude.ai/install.sh | bash`,
  `npm i -g @openai/codex`);
- pair with `node worker.mjs pair --controller … --code … --name …` (`--name` defaults to the hostname);
- install the service. Linux: `/etc/systemd/system/agent-orch-worker.service` with `Restart=always` and
  `MemoryHigh=85%`, which throttles the worker before the machine runs short. macOS: a LaunchAgent,
  `~/Library/LaunchAgents/com.agent-orch.worker.plist`, with `KeepAlive`. It runs only while you're logged in.

**On a Mac, use a dedicated user (the default under sudo).** Agents run on their own with full permissions. Under
your account they could read your documents, keychain, browser profiles and SSH keys. So the macOS script creates a
hidden standard user, `agentorch` (`--user` to rename it), with `sysadminctl`, and installs and pairs everything as
that user. Your own LaunchAgent starts the worker through a root-owned launcher,
`/usr/local/bin/agent-orch-worker-run`. A sudoers rule (`/etc/sudoers.d/agent-orch-worker`) lets you run that one
command as `agentorch` and nothing else. `--no-dedicated-user` installs under your own account (run it without sudo),
but this isn't advised. Sign the agents in as that user too, for example `sudo -u agentorch -H claude`.

Both scripts are idempotent: re-running updates the checkout and the service and keeps the existing pairing unless
you pass a new `--code`. `--dry-run` prints every step without changing anything. `--uninstall` removes the service
and the checkout. Add `--purge` to delete `~/.agent-orch-worker` too. Then remove the machine in the UI.

## Worker machines

Extra machines (a second VPS, a Mac) run `worker.mjs`, which dials out to this server over WSS (no inbound port) and
runs orchestrator tasks in its own checkouts. Design: `.agent-orch/CLUSTER.md`. On the worker (Node 22+, git, this
repo checked out, `npm ci`):

```sh
node worker.mjs pair --controller https://<your-host> --code ABCD-1234 --name mac   # code from "Add machine"
node worker.mjs run                                                                  # the daemon
```

- Pairing stores the node token in `~/.agent-orch-worker/config.json` (mode 0600). Everything else lives there
  too: `repos/` (bare cache clones), `worktrees/` (one per job, removed when it finishes), `deps/` (`node_modules`
  cached by lockfile hash), `logs/worker.log` and `logs/jobs/<id>.jsonl`. `AGENT_ORCH_WORKER_HOME` moves it.
- **Credentials come from the machine's own login**: sign Claude Code and Codex in locally, and set up git so it can
  fetch and push the project repos (`gh auth login` then `gh auth setup-git`, or an SSH key). Nothing else is sent to
  the worker, except a GitHub token the owner explicitly authorises per node (`git.credential`, kept in memory only).
- Run it as a dedicated unprivileged user under systemd (`Restart=always`) or a launchd agent on macOS. On stop it
  pauses running jobs and pushes their work first. It reconnects with backoff forever and runs its own reaper for
  leftover agent processes (`AGENT_ORCH_REAPER=off` disables it).

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
