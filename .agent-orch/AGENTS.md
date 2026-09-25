# Non-Claude coding agent CLIs (for the agents.mjs adapters)

Researched and installed 2026-09-25 on this linux/arm64 VM for Task #25. None of the three CLIs is logged in yet.
The owner must do a one-time **interactive** login for each one over SSH or the /shell/ terminal (steps below).
Every adapter must run the CLI with an env stripped of the "API billing" vars listed per CLI, the same way `API_ENV`
works in server.mjs. It must also refuse or kill a run that reports API-key auth.

Summary:

| Agent | Binary | Version | Headless | Resume | Stream format |
|---|---|---|---|---|---|
| OpenAI Codex CLI | `/usr/bin/codex` | codex-cli 0.157.0 | `codex exec --json` | `codex exec resume <id>` | JSONL `thread.*`/`turn.*`/`item.*` |
| Google Antigravity CLI | `~/.local/bin/agy` | 1.2.10 | `agy -p … --output-format stream-json` | `--conversation <id>` / `-c` | NDJSON `init`/`step_update`/`result` |
| Google Gemini CLI (fallback) | `/usr/bin/gemini` | 0.61.0 | `gemini -p … -o stream-json` | `-r latest\|<index>` | NDJSON `init`/`message`/`tool_use`/`tool_result`/`error`/`result` |

**Antigravity vs Gemini:** Antigravity **does** ship a headless CLI, `agy`, with a native linux_arm64 build, so
use it as the "Google" agent. The Gemini CLI is also installed and documented below as a fallback, and for Gemini
models that agy doesn't expose. Both use a Google-account subscription login.

---

## 1. OpenAI Codex CLI

### Install
- `sudo npm i -g @openai/codex` puts the binary at `/usr/bin/codex`, which links to
  `/usr/lib/node_modules/@openai/codex/bin/codex.js`. The real binary is
  `…/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex`, a Rust musl build.
- `codex --help` exits 0 (verified). `codex --version` prints `codex-cli 0.157.0`.

### Subscription login (ChatGPT plan)
- Over SSH, run **`codex login --device-auth`**. It prints a URL and a one-time code. Open the URL on any
  browser, sign in with the ChatGPT account, and enter the code. Device-code login may first need to be enabled in
  ChatGPT settings (Security → "device code authorization for Codex").
- `codex login status` prints `Not logged in` right now, or "Logged in using ChatGPT" once signed in. The
  adapter can use it as a pre-flight check. It must refuse to run on "Logged in using an API key".
- Credentials live at `~/.codex/auth.json` (`$CODEX_HOME`, default `~/.codex`). The `cli_auth_credentials_store`
  config key sets where they go (`file` | `keyring` | `auto` | `ephemeral`). This VM has no Secret Service or
  D-Bus, so leave it at `file`.
- Hard guard: add `forced_login_method = "chatgpt"` to `~/.codex/config.toml`, or pass
  `-c forced_login_method="chatgpt"` on every run. Codex then refuses API-key auth.
- Sessions or rollouts go to `~/.codex/sessions/YYYY/MM/DD/*.jsonl`. State goes to `~/.codex/*.sqlite`.

### Env vars that force paid API billing (strip them)
`OPENAI_API_KEY`, `CODEX_API_KEY` (exec honours it for CI auth), `CODEX_ACCESS_TOKEN`, `OPENAI_BASE_URL`,
`CODEX_HOME` (it could point at a different auth.json), and any `AZURE_OPENAI_*`. Suggested regex:
`/^(OPENAI_(API_KEY|BASE_URL|ORG_ID|ORGANIZATION|PROJECT_ID)|CODEX_(API_KEY|ACCESS_TOKEN|AUTH|HOME)|AZURE_OPENAI_.*)$/`.

### Headless invocation
```sh
codex exec --json \
  -C /path/to/workdir \            # working root (or spawn with cwd); add --skip-git-repo-check outside a git repo
  -m gpt-5-codex \                 # model flag (-m/--model); or -c model="..."; reasoning: -c model_reasoning_effort="high"
  -s workspace-write \             # sandbox: read-only (default) | workspace-write | danger-full-access
  -c approval_policy="never" \     # never ask; failures go back to the model
  -c forced_login_method="chatgpt" \
  -o /tmp/last-message.txt \       # optional: final agent message written to a file
  "PROMPT"  </dev/null             # or pass "-" and pipe the prompt on stdin
```
- **Full auto:** `--dangerously-bypass-approvals-and-sandbox` means no approvals and no sandbox, which is the
  equivalent of Claude's bypassPermissions. The sandbox uses bwrap/landlock. On this VM, `workspace-write` plus
  `approval_policy=never` is the safer choice. Use the bypass flag only if the sandbox breaks tools like git or npm.
- **stdin gotcha:** if stdin is a pipe or not a TTY, exec prints `Reading additional input from stdin...` and
  appends stdin to the prompt. Always spawn with stdin `'ignore'` or `</dev/null` unless you pipe the prompt in.
- Progress and logs go to **stderr**. JSONL events go to **stdout**.
- **Resume:** `codex exec resume <THREAD_ID> "follow-up prompt" --json`, or `codex exec resume --last …`.
  THREAD_ID is the `thread_id` from `thread.started`. `codex exec fork <id>` branches a session instead.
- Exit code: 0 on success, 1 on `turn.failed`. I saw 101 (a Rust panic) when stdin was left attached and output
  was cut off.

### `--json` output (JSONL, one object per line)
The first three lines and the last two below are real output from this VM, captured while not logged in. The item
shapes come from codex-rs `exec_events.rs`, and their field names are confirmed present in the binary.
```jsonl
{"type":"thread.started","thread_id":"01a0d699-1efd-7d72-b9f4-2616f4bf739a"}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, ...)"}
{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Scanning the repo**"}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"README.md\nsrc\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"src/a.js","kind":"update"}],"status":"completed"}}
{"type":"item.started","item":{"id":"item_3","type":"mcp_tool_call","server":"docs","tool":"search","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_4","type":"web_search","query":"..."}}
{"type":"item.updated","item":{"id":"item_5","type":"todo_list","items":[{"text":"write tests","completed":false}]}}
{"type":"item.completed","item":{"id":"item_6","type":"agent_message","text":"Done. I added the tests."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":64}}
{"type":"error","message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, ..."}
{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, ..."}}
```
- Text: `item.completed` with `item.type=="agent_message"` (`.text`). Thinking: `reasoning`.
- Tool calls: `command_execution`, `file_change`, `mcp_tool_call`, `web_search` (started, updated, completed).
- Final result: the last `agent_message`, then `turn.completed`. There's no separate result event. The session
  id is `thread.started.thread_id`.
- Usage: `turn.completed.usage`. Codex doesn't report cost. Subscription usage is counted in plan windows, not
  dollars.
- Errors: `error` events are transient (retry notices "Reconnecting... n/5"). `turn.failed.error.message` is
  fatal.

### Usage and rate limits
- With a ChatGPT plan, hitting the 5-hour or weekly window gives a `turn.failed` or `error` whose message
  contains **`You've hit your usage limit`**, for example "You've hit your usage limit. Upgrade to Plus to continue
  using Codex (…)" or "…Try again at <time>". Internal codes seen in the binary are `usage_limit_reached`,
  `usage_not_included`, `quota_exceeded`, `rate_limit`, and `workspace_{owner,member}_usage_limit_reached`.
- Transient 429s show up as `Reconnecting... n/5` error events before the turn fails.
- Adapter rule: match `/usage limit|usage_limit_reached|quota_exceeded|429|rate limit/i` in `turn.failed` or the
  final `error` and treat it like Claude's rate-limit pause. Parse "try again at" when present.

---

## 2. Google Antigravity CLI (`agy`)

### Install
- `curl -fsSL https://antigravity.google/cli/install.sh | bash` downloads a native Go binary for linux_arm64 to
  **`~/.local/bin/agy`** (about 200 MB). It self-updates in the background. It's already installed:
  `agy --version` prints `1.2.10` and `agy --help` exits 0.
- State and logs: `~/.gemini/antigravity-cli/` (settings.json, `log/cli-*.log`, crashes/).
- ~/.local/bin may not be on the systemd service's PATH, so the adapter should call the absolute path.

### Subscription login (Google account)
- Run `agy` interactively once, with no arguments, over SSH or /shell/. With no browser available, it prints a
  Google OAuth URL (`accounts.google.com/o/oauth2/auth?...redirect_uri=https://antigravity.google/oauth-callback`).
  Open it on any machine, sign in, copy the code the callback page shows, and paste it at
  `Or, paste the authorization code here and press Enter:`.
- Credentials go to the OS keyring (Linux Secret Service over D-Bus). This VM has neither D-Bus nor
  gnome-keyring, and the binary logs "Keyring SaveToken timed out …, falling back to file storage", so the token
  ends up in a file under `~/.gemini/antigravity-cli/`. Check the exact file name after the first login.
- **Gotcha:** if not logged in, `agy -p` does **not** fail fast. It prints the auth URL to stderr and blocks
  for about 60 s ("Waiting for authentication (timeout 60s)..."). Verified on this VM. Pre-check with
  `agy models`, which prints `Error: Please sign in to view available models.` right away when signed out.
  Otherwise spawn with stdin ignored and a timeout, and treat that stderr text as "not logged in".

### Env vars that force paid API billing (strip them)
`GEMINI_API_KEY` (together with `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json`, this
switches agy to API-key mode), `GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_GENAI_USE_VERTEXAI`,
`GOOGLE_GENAI_USE_ENTERPRISE`, `GOOGLE_APPLICATION_CREDENTIALS`, `AGY_ADC_AUTH` (ADC / cloud-project auth),
`AGY_BUSINESS_PAYGO_TIER`, and `GOOGLE_CLOUD_PROJECT`. The adapter should also check that settings.json has no
`modelProvider: "gemini"`. Suggested regex:
`/^(GEMINI_API_KEY|GOOGLE_(API_KEY|GEMINI_BASE_URL|GENAI_USE_VERTEXAI|GENAI_USE_ENTERPRISE|GENAI_USE_GCA|APPLICATION_CREDENTIALS|CLOUD_PROJECT(_ID)?|CLOUD_LOCATION)|AGY_(ADC_AUTH|BUSINESS_PAYGO_TIER))$/`.
The same regex works for the Gemini CLI.

### Headless invocation
```sh
cd /path/to/workdir &&            # no --cd flag: the working dir is the process cwd; extra dirs: --add-dir DIR (repeatable)
~/.local/bin/agy -p "PROMPT" \
  --output-format stream-json \   # text (default) | json (one final object) | stream-json (NDJSON)
  --model gemini-3.8-flash-high \ # model slug; list with `agy models` (needs login). Unknown model → exit 1, status ERROR
  --effort high \                 # low|medium|high
  --dangerously-skip-permissions \# full auto: approve every tool request (headless otherwise applies policy)
  --print-timeout 0 \             # 0 = wait for the turn to finish (docs say the default is 5m; --help says 0s)
  </dev/null
```
- Other flags: `--sandbox` (terminal restrictions), `--mode plan|accept-edits`, `--json-schema <schema|file>`,
  `--agent`, `--project`, and `--input-format stream-json` (multi-turn over stdin, one
  `{"event":"user","message":{"content":"…"}}` per line; it needs `--output-format stream-json`).
- **Resume:** `--conversation <conversation_id>` (the id from `init` or `result`), or `-c`/`--continue` for the
  most recent one.
- The response goes to stdout. Diagnostics (auth prompts, errors, progress) go to stderr.
- Exit codes: 0 on success, 1 on error (bad JSON, unknown model, auth failure), 2 for an unsupported slash
  command in stream mode.

### `stream-json` output (NDJSON). Sample from the official docs (antigravity.google/docs/cli/headless)
```jsonl
{"event":"init","conversation_id":"3f0c…","init":{"cwd":"/path","tools":["run_command","view_file"],"permission_mode":"request-review","model":"gemini-3.8-flash-high"}}
{"event":"step_update","step_update":{"conversation_id":"3f0c…","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Sure, "}}
{"event":"step_update","step_update":{"conversation_id":"3f0c…","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello"},"output":"hello\n"},"duration_seconds":1.5,"usage":{"input_tokens":100,"output_tokens":50,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":150}}}
{"event":"result","result":{"conversation_id":"3f0c…","status":"SUCCESS","response":"hello","duration_seconds":6.88,"num_turns":1,"usage":{"input_tokens":10418,"output_tokens":589,"thinking_tokens":551,"cache_read_tokens":8113,"total_tokens":11007}}}
{"event":"result","result":{"conversation_id":"3f0c…","status":"ERROR","error":"<message>","duration_seconds":0.4,"num_turns":0}}
```
- Text: `step_update` with `step_type=="agent_response"` and `text_delta`. Tool calls: `step_type=="tool"`, with
  `tool_name` and `tool_info` (parameters and output). `user_input` and `checkpoint` steps also appear.
- Final result: `event=="result"`, with `status` one of SUCCESS | ERROR | CANCELED | INTERRUPTED | INVALID |
  WAITING | RUNNING, plus `response` and `usage`. `--output-format json` prints only that result envelope.

### Usage and rate limits
- The docs don't describe the quota error format. It surfaces as `result.status=="ERROR"` with the message in
  `result.error`, a diagnostic on stderr, and exit 1. The binary contains gRPC `RESOURCE_EXHAUSTED`. Adapter rule:
  match `/RESOURCE_EXHAUSTED|quota|rate limit|429|exhausted/i` in `result.error` or stderr. Capture a real
  sample the first time it happens.

---

## 3. Google Gemini CLI (fallback)

### Install
- `sudo npm i -g @google/gemini-cli` puts the binary at `/usr/bin/gemini`, which links to
  `/usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js`. `gemini --version` prints `0.61.0`, and
  `gemini --help` exits 0.

### Subscription login (Google account, "Login with Google" / oauth-personal)
- Run `NO_BROWSER=true gemini` interactively once and pick "Login with Google". It prints an OAuth URL. Open it
  elsewhere, sign in, and paste the code back. This sets `security.auth.selectedType: "oauth-personal"` in
  `~/.gemini/settings.json`.
- Credentials: `~/.gemini/oauth_creds.json`. Account info: `~/.gemini/google_accounts.json`.
- If not logged in, headless exits right away with code 41 and prints "Please set an Auth method in your
  ~/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY,
  GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA". Verified on this VM.
- Env vars to strip: the same regex as agy above (`GEMINI_API_KEY`, `GOOGLE_API_KEY`,
  `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, …). Also make sure
  settings.json `selectedType` is `oauth-personal` and not `gemini-api-key` or `vertex-ai`.

### Headless invocation
```sh
cd /path/to/workdir &&                       # workspace = cwd; more dirs: --include-directories a,b
gemini -p "PROMPT" -o stream-json \          # text | json | stream-json
  -m gemini-2.5-pro \                        # model flag
  --approval-mode yolo \                     # or -y; others: default | auto_edit | plan (read-only)
  --skip-trust                               # trust the workspace for this session (no prompt)
  </dev/null                                 # stdin is appended to -p if piped
```
- Sandbox: `-s/--sandbox` (needs docker or podman, which aren't installed here, so leave it off).
- **Resume:** `-r latest` or `-r <index>` (from `--list-sessions`, per project). You can also pre-assign an id
  with `--session-id <uuid>` on the first run. Resuming by id isn't supported, only by index or "latest". To
  resume a specific session, the adapter needs `--session-file` or its own index lookup.

### `stream-json` output (NDJSON; shapes taken from the installed bundle)
```jsonl
{"type":"init","timestamp":"2026-09-25T03:30:00.000Z","session_id":"6c1d…","model":"gemini-2.5-pro"}
{"type":"message","timestamp":"…","role":"user","content":"PROMPT"}
{"type":"message","timestamp":"…","role":"assistant","content":"Sure, ","delta":true}
{"type":"tool_use","timestamp":"…","tool_name":"run_shell_command","tool_id":"call_1","parameters":{"command":"ls"}}
{"type":"tool_result","timestamp":"…","tool_id":"call_1","status":"success","output":"README.md\n"}
{"type":"error","timestamp":"…","severity":"warning","message":"…"}
{"type":"result","timestamp":"…","status":"success","stats":{"total_tokens":1234,"input_tokens":1100,"output_tokens":134,"cached":800,"input":300,"duration_ms":5120,"tool_calls":1,"models":{"gemini-2.5-pro":{"total_tokens":1234,"input_tokens":1100,"output_tokens":134,"cached":800,"input":300}}}}
{"type":"result","timestamp":"…","status":"error","error":{"type":"TerminalQuotaError","message":"You have exhausted your daily quota on this model. …"},"stats":{…}}
```
- A failed tool gives `tool_result` with `status:"error"` and `error:{type,message}`.

### Usage and rate limits
- Quota errors are the classes `TerminalQuotaError` (daily or plan quota, "You have exhausted your daily quota on
  this model" / "exhausted your capacity") and `RetryableQuotaError` (per-minute 429, retried internally). A
  terminal quota error ends the run with `result.status:"error"`, where `error.type` is the class name. On free
  or personal tiers, the CLI may also fall back to a Flash model on quota, and `init.model` doesn't show that.
