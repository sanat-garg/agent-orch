# Claude Web + AO2

A self-hosted, login-protected web UI for [Claude Code](https://docs.claude.com/en/docs/claude-code),
meant for a single owner on their own server.

- **Claude Web** (`server.mjs`) runs chat sessions through Claude Code using
  `@anthropic-ai/claude-agent-sdk`. It also provides a folder browser, live server metrics, and browser
  terminals (tmux sessions shown through ttyd).
- **AO2** (`orchestrator.mjs`) is the agent orchestrator behind a chat's "Orchestrator" mode. A planner
  breaks your goals into small tasks, each with a "Done when" check. Workers run each task in a fresh
  Claude Code session, verify it against that check, and commit the result to git. A reflector queues
  follow-up work when a project's queue is empty. A governor paces the work against the 5-hour and weekly
  plan usage limits, and sleeps until a limit resets. State is kept in SQLite (`node:sqlite`), and each
  project's memory is kept in `<project>/.ao2/`.
- **GitHub sync** (`github.mjs`) uses the `gh` CLI. Each project gets a private repo, and finished work
  is committed and pushed to `origin`.

This is plain Node ESM. There is no build step and no framework.

## Requirements

- **Node.js 22+**. AO2 uses the built-in `node:sqlite`.
- **Claude Code CLI** at `~/.local/bin/claude`, signed in with a Claude subscription (`claude`, then
  `/login`). The server uses this path directly.
- **tmux**. Browser terminals and the GitHub sign-in flow run in tmux sessions.
- **ttyd**, which serves `bin/term-attach.sh` to the browser.
- **Caddy** for HTTPS in front of the app. The server listens on `127.0.0.1` only.
- **gh** (GitHub CLI) and **git** for project repos. You can sign in with `gh` from the UI, which
  runs `gh auth login --web` in a terminal, or from any shell.

## Setup

```sh
git clone https://github.com/sanat-garg/agent-orch.git ~/claude-web
cd ~/claude-web
npm install
node server.mjs set-password '<password, 8+ chars>'   # writes data/auth.json and signs everyone out
PORT=3000 node server.mjs                               # listens on 127.0.0.1:3000
```

The server creates `~/workspace` (the default project folder, and the terminals' working directory) and
the data directory on startup. Run `npm test` to start a throwaway server on a free port and check login.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. The server binds to `127.0.0.1` only. |
| `CW_DATA_DIR` | `./data` | Where all state lives, for both the server and the orchestrator. |
| `CW_DEVICE_NAME` | `Oracle VM` | The name shown for this machine in the UI. |
| `PATH` | inherited | Passed to Claude Code and agents. AO2 prepends `data/orchestrator/bin`, which holds `python`/`pip` shims pointing to `python3`/`pip3` when only those exist. |

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

`/etc/systemd/system/claude-web.service`:

```ini
[Unit]
Description=Claude Web (login + chat UI)
After=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/claude-web
Environment=PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=PORT=3000
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.mjs
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

A matching ttyd unit, bound to loopback and serving under `/shell`:

```ini
[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/workspace
Environment=PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=TERM=xterm-256color
ExecStart=/usr/bin/ttyd -W -O -a -b /shell -i 127.0.0.1 -p 7682 /home/ubuntu/claude-web/bin/term-attach.sh
Restart=always
```

For terminals to survive restarts of the web app, also run a `tmux -D` server as its own unit. Then run
`sudo systemctl daemon-reload && sudo systemctl enable --now claude-web <ttyd unit> caddy`. The metrics
panel checks service status with `systemctl is-active claude-web claude-term caddy`.

## data/

All runtime state lives in `data/` (or `CW_DATA_DIR`). Files are written with mode `0600`.

| Path | Contents |
|---|---|
| `auth.json` | scrypt salt and hash of the login password |
| `sessions.json` | active login session tokens |
| `convos.json` | the chat list (title, folder, mode, model, Claude session id) |
| `logs/<id>.jsonl` | the transcript of each chat |
| `metrics/` | raw and per-minute server metrics |
| `orchestrator/ao2.db` | the AO2 SQLite database (projects, tasks, runs, events, usage limits) |
| `orchestrator/runs/` | per-run agent logs |
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
- **Agents run with `bypassPermissions`.** AO2 workers, the planner and the reflector run with
  `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true`. They get no
  permission prompts, and no tool is refused, including edits to this app's own code. Roles are enforced
  by prompt instructions only. New chats also default to `bypassPermissions`. Run this only on a
  disposable server you're willing to hand to an autonomous agent.
- **Login.** There is a single password, stored as a scrypt hash. The session cookie `cw_session` is
  `HttpOnly; Secure; SameSite=Lax` and lasts up to 30 days. After 5 failed logins, an IP is locked out for
  15 minutes. POST requests and WebSocket upgrades must be same-origin. `set-password` signs out every
  session.
- **Loopback only.** The app listens on `127.0.0.1`, and ttyd should too. The client IP used for lockout
  comes from `X-Forwarded-For`, which is trusted because only Caddy should reach the port. Don't expose
  port 3000 or 7682 directly.
- **GitHub.** Repos that AO2 creates are private, and each gets a `.gitignore` that excludes `.env*`,
  keys and build output.
