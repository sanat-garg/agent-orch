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

Chats and orchestrator tasks can run on six coding agent CLIs. The adapters live in `agents.mjs`, and
research notes on each CLI are in `.agent-orch/AGENTS.md`.

| Agent | Binary | Install | Subscription login (once, over SSH or `/shell/`) |
|---|---|---|---|
| Claude Code (default) | `~/.local/bin/claude` | see Requirements | `claude`, then `/login` |
| OpenAI Codex CLI | `codex` on `PATH` | `sudo npm i -g @openai/codex` | `codex login --device-auth`, then open the URL and enter the code. You may first need to enable device code authorization for Codex in ChatGPT's security settings. `codex login status` should say "Logged in using ChatGPT". |
| Google Antigravity CLI | `~/.local/bin/agy` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | run `agy` with no arguments, open the Google OAuth URL it prints, sign in, and paste the code back |
| OpenCode CLI | `opencode` on `PATH` | `sudo npm i -g opencode-ai` | None needed for the free OpenCode Zen models (the Connections row reads "Ready · free Zen models"). **Connect a provider** in the Connections modal: pick ChatGPT Plus/Pro, GitHub Copilot or SuperGrok, then its device flow (`opencode auth login --provider <id> --method <subscription method>`) |
| Kiro CLI | `~/.local/bin/kiro-cli` | `curl -fsSL https://cli.kiro.dev/install \| bash` (needs `unzip`) | Connections modal (`kiro-cli login --use-device-flow`) |
| GitHub Copilot CLI | `copilot` on `PATH` | `sudo npm i -g @github/copilot` | Connections modal; it shares the GitHub (`gh`) login, so disconnecting one signs out both |

**Connections.** The button at the foot of the sidebar (or **Connections…** at the end of the model picker)
opens the Connections modal. It runs each CLI's login in a hidden tmux pane and shows the URL and one-time
code to enter elsewhere; Antigravity asks you to paste its code back. Signing in there works for every agent above.

**Models.** Model lists come only from the CLIs themselves, never a hardcoded list. They are cached in
`data/models.json` and refreshed at boot, every 6 hours and after a sign-in change. OpenCode runs
`opencode models --verbose` once and keeps the signed-in subscription providers' models plus the free OpenCode Zen
models (zero cost, shown as `Zen · <name> (free)`), Kiro lists `kiro-cli chat --list-models --format json`
for the signed-in account, and Copilot asks the Copilot SDK's `listModels()`.

**Known limits.** Kiro isn't signed in on this server, so its authenticated headless use and stream format are
unverified. Copilot's model list currently returns only `auto`, and Copilot reports no remaining usage or reset
time, so its limit is only known when a run hits it. OpenCode limits are tracked per provider (`openai`, `github-copilot`, `xai`, and `opencode` for Zen).

**Subscription only, never API keys.** Each adapter removes its billing variables from the environment
before starting the CLI:

- Claude: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`.
- Codex: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT_ID`,
  `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `CODEX_AUTH`, `CODEX_HOME` and every `AZURE_OPENAI_*`. Every run also
  passes `-c forced_login_method="chatgpt"`, and an API-key login counts as logged out.
- Antigravity: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_GENAI_USE_VERTEXAI|ENTERPRISE|GCA`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT(_ID)`, `GOOGLE_CLOUD_LOCATION`, `AGY_ADC_AUTH` and
  `AGY_BUSINESS_PAYGO_TIER`. A run is refused if `~/.gemini/antigravity-cli/settings.json` sets
  `"modelProvider": "gemini"` (API-key mode).
- OpenCode: every `*_API_KEY` and `*_TOKEN`, `OPENAI_BASE_URL|ORG_ID|ORGANIZATION|PROJECT_ID`, every `AZURE_OPENAI_*`
  and `OPENCODE_AUTH|CONFIG|CONFIG_DIR`. It is ready with an OAuth credential for `openai`, `github-copilot` or `xai`, or with no sign-in when it lists
  free OpenCode Zen models (API-key providers never count). A run is refused if an OpenCode config or the project's
  `.env` sets an API key or custom endpoint, or if it names a paid Zen model and no Zen key was added.
- Kiro: `KIRO_API_KEY`. An API-key account from `kiro-cli whoami` counts as logged out.
- Copilot: `COPILOT_GITHUB_TOKEN`, `COPILOT_PROVIDER_*`, `GH_TOKEN`, `GITHUB_TOKEN` and the OpenAI, Anthropic, Gemini and
  Google API keys; `COPILOT_HOME` is pinned to `~/.copilot`. A run is refused if `~/.copilot/settings.json` or the
  project's `.copilot/settings.json` sets a custom (BYOK) provider.

**Chat picker.** The model menu in a chat is grouped by agent (fed by `GET /api/agents`). Pick an agent's
default model or a specific one. Groups for agents that aren't installed or logged in are disabled and show
why, including the login command. Non-Claude chats run one headless CLI turn per message and resume the
agent's own session. They have no permission prompts. Orchestrator mode always plans on Claude.

**Routing rules.** Tell the planner in chat, for example "use codex for tests" or "use gemini-3.8-flash-high
for UI work". It saves a rule with a `match` (a task kind, `work`, `reflect` or `plan`, or a keyword in the
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
recorded on the task. With an empty list, the task waits for its own model. Limits are per agent (Antigravity:
per model group), so one agent's limit never blocks another's.

## Parallel tasks and git worktrees

In a project that is a git repository, each work task runs in its own git worktree at
`<repo>/../.agent-orch-worktrees/<repo>-task-<id>` on branch `agent-orch/task-<id>`, so several tasks can edit
at once without seeing each other's changes. Projects outside git (or on a detached HEAD) run in the main tree.

- **`files`**: the planner gives each task the paths or globs it will change (`src/**/*.css`, `test/`). Tasks
  whose lists can't match the same file run in parallel, possibly on different agents. A task without `files`
  counts as touching everything and runs alone.
- **`after`**: true prerequisites only. A task starts once all of them are done, and cancelling or failing one
  cancels everything after it. Use `files`, not `after`, to keep work apart.
- **Integrator tasks**: the planner ends a split feature with a task whose `after` lists every part; it
  reconciles their results and runs the full test suite.
- **Slots**: up to `maxParallel` (5) tasks run at once while usage isn't scarce, at most `agentSlots` (3) per
  agent. A task that would otherwise wait for a busy agent spills to its first fallback with a free slot.

When a task passes its check, the orchestrator squashes its branch to one commit, rebases it onto the main
tree's branch, fast-forwards the main tree and syncs it to GitHub. Only this merge step touches the main tree, one task at
a time. `JOURNAL.md` uses a union merge, so shared appends never conflict. If the rebase conflicts, the task
becomes **needs integration**: its worktree is kept and an `Integrate #<id>` task is queued in the same
worktree. That task merges the main branch in, resolves the conflict markers, re-runs the check and lands the
work, which marks the original task done. Failed or cancelled work is committed to its branch and the worktree
removed, so a retry can pick it up.

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
