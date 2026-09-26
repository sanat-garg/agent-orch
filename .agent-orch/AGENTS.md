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
| OpenCode | `/usr/bin/opencode` | 1.18.32 | `opencode run --format json` | `-s <id>` / `-c` | JSONL `step_start`/`text`/`tool_use`/`step_finish`/`error` |
| Kiro CLI | `~/.local/bin/kiro-cli` | 2.24.1 | `kiro-cli chat --no-interactive --output-format stream-json` | `--resume-id <id>` | JSONL (V2/V3; live payload unverified) |
| GitHub Copilot CLI | `/usr/bin/copilot` | 1.0.88 | `copilot -p … --output-format json` | `--resume=<id>` / `--continue` | JSONL `assistant.*`/`tool.*`/`result` |

**Antigravity vs Gemini:** Antigravity **does** ship a headless CLI, `agy`, with a native linux_arm64 build, so
use it as the "Google" agent. The Gemini CLI is also installed and documented below as a fallback, and for Gemini
models that agy doesn't expose. Both use a Google-account subscription login.

**Model discovery (Task #98, verified 2026-09-25).** The model picker and routing only use lists the CLIs report
(agents.mjs `listModels`/`discoverModels`, cached by models.mjs in `<DATA>/models.json`, refreshed at boot, every 6 h
and after a sign-in change). Nothing is hardcoded; a signed-out agent or a failed discovery gives an empty list and
a reason.

| Agent | Command | Output |
|---|---|---|
| Claude Code | SDK `query({prompt: <stream that never yields>}).supportedModels()`, then abort (no message sent, nothing billed) | `ModelInfo[]` `{value, resolvedModel, displayName, description}`; the `value: "default"` row marks which alias is the default |
| Codex | `codex debug models` (`--bundled` skips the account refresh) | JSON `{models: […]}` with `slug`, `display_name`, `description`, `priority` and `visibility` (`list` or `hide`) |
| Antigravity | `agy models` | stdout lines `<id>\t<display name>`, "Fetching available models..." on stderr; signed out → exit 1 "Please sign in to view available models." |

**Plan limits and health (Task #195, verified 2026-09-26).** `bin/agent-health.mjs [--json] [--cached]` prints, per agent,
version, sign-in, models, limit windows + source and last fetch; exit 1 if a signed-in agent has 0 models or a window
without a reset although its source reports resets. Limit readings (agents.mjs `fetchLimits`, cached by usage.mjs
`createLimitStore` in `<DATA>/limits.json`, refreshed at boot, every 6 h, after a sign-in change and from Connections →
Refresh):

| Agent | Source | Windows |
|---|---|---|
| Claude Code | SDK `usage_EXPERIMENTAL_…()` on an idle query (also polled every 3 min) | `five_hour`, `seven_day`, `seven_day_opus/_sonnet`, model-scoped, with `resets_at` |
| Codex | newest `~/.codex/sessions/**/rollout-*.jsonl` `token_count.rate_limits` (only as fresh as the last codex run) | `5h`, `weekly`, with `resets_at` |
| Antigravity | `agy -p /usage --output-format stream-json` (local, no tokens) | `gemini-5h/-weekly`, `3p-5h/-weekly`, with `reset_time` |
| Copilot | SDK `rpc.account.getCurrentAuth()` → `authInfo.copilotUser.quota_snapshots` | `premium` (premium_interactions, pct = 100 − percent_remaining), reset `quota_reset_date_utc`; unlimited quotas skipped. `rpc.account.getQuota().resetDate` is the snapshot time, **not** the reset: don't use it |
| OpenCode | **not exposed by CLI** (`opencode stats` = local token/cost totals only; free Zen has no published quota) | — |
| Kiro | **not exposed by CLI** (credits only in the interactive chat's `/usage`; no headless command or stream event) | — |

Copilot listing only `auto` is a legitimate state for this account (task #187: the SDK's `listModels()` and the
session model RPC return nothing else). It is shown as **Auto (Copilot picks the model)**, not as an error.

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
  final `error` (never tool output, assistant text or `Reconnecting…` retry notices) and treat it like Claude's
  rate-limit pause. Parse "try again at" when present. Real 2026-09-25 message: "You’ve hit your usage limit. … or try
  again at Sep 26th, 2026 1:20 AM." (local time, ordinal day); the rollout records it as a `task_complete` error with
  `codex_error_info: "usage_limit_exceeded"`, after a `limit_id:"premium"` token_count whose primary/secondary are null.
- **Plan windows (verified 2026-09-25, codex-cli 0.157.0, Plus plan):** `exec --json` does **not** stream rate
  limits. The thread's rollout `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl` gets one
  `{"type":"event_msg","payload":{"type":"token_count","info":{…},"rate_limits":{"limit_id":"codex","primary":{"used_percent":0.0,"window_minutes":300,"resets_at":1790361203},"secondary":{"used_percent":17.0,"window_minutes":10080,"resets_at":1790454622},"credits":{…},"plan_type":"plus","rate_limit_reached_type":null}}}`
  line per turn (`resets_at` epoch s; older builds used `resets_in_seconds`). The adapter (`codexRolloutWindows`)
  reads the latest snapshot after each run into `res.windows` as `5h`/`weekly` (from `window_minutes`) and also
  accepts a streamed `token_count` event if a later CLI starts emitting one.

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
- The stream is lossy (checked 2026-09-26): run_command has no exit code and no `output` when silent, edit tools
  (write_to_file, replace_file_content) have no output and only their path parameter. agy saves the full step:
  `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/steps/<step_index>/output.txt` ("The command exited
  with code N.\nStdout:…") and `conversations/<conversation>.db` table `steps` (idx = step_index; `step_payload` is a
  protobuf whose field 5.4.3 is the call's JSON args and 140.2.1 its output). `agyStepNative` reads both read-only.
- Final result: `event=="result"`, with `status` one of SUCCESS | ERROR | CANCELED | INTERRUPTED | INVALID |
  WAITING | RUNNING, plus `response` and `usage`. `--output-format json` prints only that result envelope.

### Usage and rate limits
- The docs don't describe the quota error format. It surfaces as `result.status=="ERROR"` with the message in
  `result.error`, a diagnostic on stderr, and exit 1. The binary contains gRPC `RESOURCE_EXHAUSTED`. Adapter rule:
  match `/RESOURCE_EXHAUSTED|quota|rate limit|429|exhausted/i` in `result.error` or stderr. Capture a real
  sample the first time it happens.
- **Usage data agy exposes (verified 2026-09-25, agy 1.2.11):** there is no `agy usage`/`agy quota` subcommand,
  but the read-only slash commands work in print mode: `agy -p /usage` (alias `/quota`) prints one tab-separated
  line per bucket (`Gemini Models	Five Hour Limit Remaining	100%	2026-09-25T18:34:11Z`), and with
  `--output-format stream-json` a `{"event":"command_result","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","window":"weekly","remaining_fraction":0.9987,"reset_time":"…Z"},{"id":"gemini-5h","window":"5h",…}]},{"name":"Claude and GPT models","buckets":[{"id":"3p-weekly",…},{"id":"3p-5h",…}]}]}}}`
  event plus a `result` with 0 tokens (no model call). Each model group (Gemini; Claude/GPT-OSS) has its own 5h
  and weekly limit, consumed in proportion to token cost. `agy -p /credits` prints `Remaining credits	0`. Stream
  events of normal runs carry only token `usage`, no quota. The adapter runs `/usage` after every ok or
  rate-limited run (`agyUsage`) and records all four bucket ids through `usageLog.windows` in usage.mjs, with percent used = `(1 - remaining_fraction) * 100` and `resetsAt` parsed as epoch seconds.
- Rechecked read-only `/usage --output-format stream-json` on 2026-09-26: `gemini-5h` 0%, reset 1790405582; `gemini-weekly` 2.64%, reset 1790463533; `3p-5h` 16.86%, reset 1790402563; `3p-weekly` 39.25%, reset 1790971363. These are independent windows, not per-model quotas. `gemini-*` counts as Gemini; all other ids count as third-party (currently claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium). Display names are Gemini / Third-party · 5-hour / Weekly; raw ids remain storage keys only.

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

---

## 4. OpenCode (`opencode`)

### Install and subscription login
- Verified 2026-09-26 on linux/arm64: `sudo npm i -g opencode-ai` installed **1.18.32** at `/usr/bin/opencode`; `opencode --help` and `opencode run --help` exit 0. [CLI reference](https://opencode.ai/docs/cli/).
- OpenCode has no account of its own; it signs into model providers. `opencode auth login` (no args) shows a searchable clack menu of every Models.dev provider (fixture: `test/fixtures/panes/opencode-providers.txt`); `--provider <id> --method '<label>'` skips both menus. The positional `opencode auth login openai` is read as a well-known URL and fails. Methods verified in 1.18.32 (menus captured 2026-09-26, labels confirmed in the binary):
  - `openai`: `ChatGPT Pro/Plus (browser)` (localhost callback), **`ChatGPT Pro/Plus (headless)`** (device: `Go to: https://auth.openai.com/codex/device`, `Enter code: XXXX-XXXXX`), `Manually enter API Key`.
  - `github-copilot`: one method, **`Login with GitHub Copilot`**; it then asks `Select GitHub deployment type` (GitHub.com / Enterprise) before `Go to: https://github.com/login/device` + `Enter code:`. Token stored with `refresh == access`, `expires: 0`, no email.
  - `xai`: **`SuperGrok Subscription`** (device: `Go to: https://accounts.x.ai/oauth2/device?user_code=…`, `…enter code: XXXX-XXXX`), or an API key.
  - API key only: `opencode` (Zen), `anthropic`, `google` and most others. `gitlab` (`GitLab OAuth`) and Poe need a localhost browser callback; DigitalOcean/Snowflake are cloud billing. None are offered.
  - Every OAuth flow ends with `Login successful` (exit 0) or `Failed to authorize` (exit 1). `opencode auth logout <provider>` prints `Logout successful`.
- The Connections modal offers only the three bold methods (connections.mjs `SPECS.opencode.providers`, agents.mjs `OPENCODE_OAUTH`): Connect shows a provider picker, then that provider's flow; each signed-in provider has its own Disconnect. Status reads `auth.json` for `type: "oauth"` records of those providers; the ChatGPT email comes from the access JWT's `https://api.openai.com/profile` claim. Models: one `opencode models --verbose` run (cwd `$HOME`, billing env stripped), filtered to signed-in providers plus free Zen models.
- `opencode auth list` is the status check: on this VM it reports **0 credentials** (exit 0). The docs locate provider OAuth/key records at `~/.local/share/opencode/auth.json`; sessions live in `~/.local/share/opencode/opencode.db` (observed). `auth list` reports provider names, not a reliable account email or billing mode. agent-orch reads `auth.json` directly (credential **type** only, never logging secrets) instead of parsing `auth list`.
- OpenCode also loads provider keys from environment and project `.env` files. Strip at least `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT_ID`, `AZURE_OPENAI_*`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, `COPILOT_GITHUB_TOKEN`, and provider-specific `*_API_KEY`/`*_TOKEN` when using a chosen OAuth provider. Inspect project `opencode.json` and `.env` for `provider.*.options.apiKey` / `baseURL`; environment stripping alone cannot guarantee subscription billing. `opencodeBillingConfig` (agents.mjs) checks the global `$XDG_CONFIG_HOME|$HOME/.config/opencode/{config,opencode}.json[c]`, every `opencode.json[c]` from cwd up to the git root, and the cwd `.env`; `envFilter` strips all `OPENCODE_CONFIG*` (incl. `OPENCODE_CONFIG_CONTENT`). Do not route to paid OpenCode Zen/Go (separate billing) unless explicitly configured by the owner.
- **Free Zen tier (no sign-in):** with no credentials at all, `opencode models` (neutral cwd) lists the free OpenCode Zen models, e.g. on 2026-09-26: `opencode/big-pickle`, `…/ling-3.0-flash-fin-free`, `…/mimo-v2.6-flash-free`, `…/muse-spark-1.3-contributor-free`, `…/nemotron-3-ultra-free`, `…/nemotron-3.5-lightning-free`, `…/space-bunny-free`. `opencode models --verbose` prints each id line followed by a pretty JSON block with `name` and `cost` (`input`/`output`/`cache.read`/`cache.write`, all `0` for these). agent-orch treats a Zen model as free only when every cost is 0 (fallback without a cost reading: `-free` ids and `big-pickle`), labels it `Zen · <name> (free)`, and lists/runs paid Zen models only when `auth.json` holds an `opencode` API key (`opencodeZenKey`); `runOpencode` refuses a paid Zen model otherwise. OpenCode counts as ready whenever its discovered catalog has a model (OAuth provider or free Zen); Zen limits use scope `opencode:opencode`.

### Headless, sessions, models
```sh
opencode run --dir /path/to/workdir --format json \
  --model openai/<id-from-models> --auto 'PROMPT' </dev/null
opencode run --dir /path/to/workdir --format json \
  --session ses_... --auto 'follow-up' </dev/null
```
- `--dir` or process cwd chooses the workspace; `--model` takes `provider/model`, `--variant` selects provider-specific reasoning. `--auto` approves permissions not explicitly denied (current `run --help` calls it dangerous). Explicit deny rules in config still apply. `--continue` resumes the latest session; `--session` resumes an exact ID; `--fork` branches it. `opencode session list --format json` discovers saved IDs.
- `opencode models openai` lists configured OpenAI model IDs as `provider/model`; `opencode models github-copilot` does likewise after that provider is connected. `--refresh` refreshes Models.dev's catalog. This is **catalog/config discovery**, so filter by the connected OAuth provider and verify plan access; it is not a quota or entitlement endpoint. Both provider-specific commands currently fail `Provider not found` because this VM has no OpenCode credentials.

### Stream and limits
- `--format json` writes newline-delimited objects to stdout, with `type`, `timestamp` (epoch ms), `sessionID`, and often `part`. [OpenCode's own JSON-stream issue](https://github.com/anomalyco/opencode/issues/26855) shows real success rows (shortened here):
```jsonl
{"type":"step_start","sessionID":"ses_…","part":{"type":"step-start"}}
{"type":"text","sessionID":"ses_…","part":{"type":"text","text":"Hello"}}
{"type":"tool_use","sessionID":"ses_…","part":{"type":"tool","tool":"bash","state":{"status":"running","input":{"command":"pwd"}}}}
{"type":"tool_use","sessionID":"ses_…","part":{"type":"tool","tool":"bash","state":{"status":"completed","output":"/tmp\n"}}}
{"type":"step_finish","sessionID":"ses_…","part":{"type":"step-finish","reason":"stop","tokens":{"input":209,"output":209,"reasoning":0,"cache":{"read":18944,"write":0}},"cost":0}}
```
- The `tool_use` examples above are **schema sketches**, not captured output on this account; the `step_start`/`text`/`step_finish` shapes are shortened from the linked upstream sample. Tool call and result are updates to one tool part (`state.status`), not necessarily separate event types. The final text is the last text part; completion is process exit and normally `step_finish`. An upstream [bug report](https://github.com/anomalyco/opencode/issues/26855) documents that `step_finish` can be absent even after a successful run; do not require it for success or assume usage is complete. `opencode stats --models` reads local historical tokens/cost, not live plan windows. Signed-out test here emitted `{"type":"error","sessionID":"ses_…","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_…"}}}` and exited 1.
- No live provider 429/quota sample or reset time was available. Check `type:"error"` and process exit, then classify provider-specific `429`, `rate_limit`, `quota`, and “usage limit” messages; preserve any `retry-after`/reset text, otherwise reset is unknown. OpenCode routes to different subscriptions, so limits must be keyed by **provider**, not one global OpenCode bucket. A real limit hit is needed to validate the parser before routing tasks.

---

## 5. AWS Kiro CLI (`kiro-cli`)

### Install and account login
- Verified 2026-09-26: the [official installer](https://kiro.dev/docs/cli/) `curl -fsSL https://cli.kiro.dev/install | bash` installed native linux/arm64 **2.24.1** at `~/.local/bin/kiro-cli`; `kiro-cli --help` exits 0. The installer requires `unzip` (installed on this VM). Use the absolute path if the service PATH omits `~/.local/bin`.
- [Authentication docs](https://kiro.dev/docs/cli/authentication/) support AWS Builder ID, GitHub, Google and IAM Identity Center. On SSH use `kiro-cli login --use-device-flow` (optionally `--social github` or `--social google`), then open its URL elsewhere and enter the one-time code. This is suitable for the existing tmux-driven Connections pane; a plain `kiro-cli login` may try and fail to open a local browser. A Builder ID is **one option**, not a requirement. No account was authenticated in this unattended task.
- `kiro-cli whoami --format json` is the status/identity check; here it returned `{"account":null}` (exit 0). Browser session credentials take precedence over `KIRO_API_KEY`. The exact secret file/keyring path after successful login could not be verified without signing in. Kiro settings/sessions use `~/.kiro/` (`KIRO_HOME` overrides); do not mistake `~/.kiro/settings/cli.json` for the credential store. Strip `KIRO_API_KEY` from child environments to force browser subscription auth, and reject `whoami.account == null` or an API-key account. The [docs](https://kiro.dev/docs/cli/authentication/) say API-key consumption still draws subscription credits, but the owner's constraint is browser login.

### Headless, sessions, models
```sh
cd /path/to/workdir
~/.local/bin/kiro-cli chat --no-interactive --agent-engine v2 \
  --output-format stream-json --trust-all-tools \
  --model <id-from-list-models> 'PROMPT' </dev/null
~/.local/bin/kiro-cli chat --no-interactive --agent-engine v2 \
  --output-format stream-json --trust-all-tools \
  --resume-id <session-id> 'follow-up' </dev/null
```
- Cwd selects the project. `--trust-tools=fs_read,fs_write` can limit approvals; `--trust-all-tools` permits autonomous work. V2 is the current default and V2/V3 are required for `stream-json` ([headless guide](https://kiro.dev/docs/cli/headless/)). `--resume` is latest in this directory, `--resume-id` is exact, `chat --list-sessions --format json` lists IDs. `chat --list-models --format json` is account-specific discovery, and `--model` selects an ID. Here model listing tried to open a browser and failed because `whoami` is null; never treat a signed-out list as empty entitlements.
- The headless guide says **API key is required** while the authentication guide says an active browser session takes precedence and can be used by the CLI. This conflict remains untested until subscription login. Signed-out `chat --no-interactive --output-format stream-json 'Say hi'` printed browser-auth diagnostics and exited 1, with no JSONL. Do not claim subscription headless viability yet.

### Stream and limits
- Official [headless docs](https://kiro.dev/docs/cli/headless/) promise one JSON object per stdout line for V2/V3, including a terminal interruption record in V3, but publish **no event schema**. Without a login, this VM yielded no text/tool/result/usage/error JSON events. Therefore exact sample keys for those events cannot be supplied honestly. Capture one read-only and one tool-using authenticated run before writing an adapter; do not assume Claude's `stream-json` schema. Stderr may contain ANSI progress and auth errors even with JSON output. Treat nonzero exit and absent terminal record as failure; inspect raw JSONL once available.
- `/usage` in an interactive chat shows credits ([command reference](https://kiro.dev/docs/cli/reference/slash-commands/)); no documented non-interactive quota JSON command or reset field was found. [Billing docs](https://kiro.dev/docs/billing/) say credits renew at the start of the next billing cycle. Watch stderr/JSON errors for exhausted credits, 429 and throttling, but a real error string/reset timestamp was unavailable. Keep reset unknown rather than infer a date from installation or generic monthly cadence.

---

## 6. GitHub Copilot CLI (`copilot`)

### Install and subscription login
- Verified 2026-09-26: `sudo npm i -g @github/copilot` installed **1.0.88** at `/usr/bin/copilot`; `copilot --help` exits 0. [Official reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).
- `copilot login --device-code` displays a browser URL and one-time code; its CLI help says remote/headless Linux defaults to device flow. This command fits a tmux Connections pane. `copilot login` stores an OAuth token in the system credential store, or plaintext under `~/.copilot/` if unavailable ([auth docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)). `COPILOT_HOME` overrides the directory. `/user show` and `/user list` in interactive CLI identify the account; there is **no `copilot auth status`** (it exits 1, invalid command). `gh auth status` checks the fallback GitHub CLI token, not a Copilot license by itself.
- On this machine `gh auth status` shows the owner's `sanat-garg` account, and `copilot -p 'Say hi' --output-format json` succeeded using that fallback, returning `Hi!` and a `result` with exitCode 0. No separate Copilot credential was required. [GitHub's auth docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli) explicitly say the `gh` token is the lowest-priority fallback. The working subscription/account was verified by a real run, though plan tier was not exposed.
- Strip `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_PROVIDER_API_KEY_COMMAND`, `COPILOT_PROVIDER_BEARER_TOKEN`, and custom-provider endpoint vars/settings. The first three override stored/`gh` OAuth credentials; they are not inherently paid API billing, but can silently change identity. The provider vars activate BYOK/custom-provider routing. Inspect `~/.copilot/settings.json` for a custom provider and use `--model` from the authenticated Copilot list. `COPILOT_HOME` should be fixed to the intended auth home, not inherited from a task environment.

### Headless, sessions, models
```sh
copilot -C /path/to/workdir -p 'PROMPT' --output-format json \
  --model <id-from-model-picker> --allow-all --no-ask-user </dev/null
copilot -C /path/to/workdir -p 'follow-up' --output-format json \
  --resume=<session-id> --allow-all --no-ask-user </dev/null
```
- `-p` exits after the response; piped stdin is ignored when `-p` is supplied. `-C` sets cwd. `--allow-all` grants tools, paths and URLs; `--allow-all-tools` only grants tools. `--allow-tool='read,write,shell(npm:*)'` grants a subset. `--no-ask-user` removes the clarifying-question tool. `--continue` resumes latest; `--resume=<id>` resumes exact; bare `--resume` needs a TTY picker and errors with multiple sessions in prompt mode ([reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)). The final `result.sessionId` is the resume ID (observed).
- `--model` selects one model or `auto`. The authenticated interactive `/model` or `/models` picker is GitHub's documented current entitlement discovery; this CLI version has **no documented non-interactive machine-readable model-list command**. The official `@github/copilot-sdk` `listModels()` does provide account-backed discovery over the CLI runtime. On this VM with CLI 1.0.88 it currently returns only `auto`; the session model-list RPC returned no selectable rows. The adapter uses that SDK response without adding names from the public catalog. The JSON stream's `session.tools_updated.data.model` and `assistant.message.data.model` show the selected/resolved model (our run used `gpt-5.6-luna`), but do not enumerate choices.

### JSONL, usage and limits
- `--output-format json` streams JSONL on stdout. These shortened examples are from **successful runs on this VM**; every real event also carries `id`, `timestamp` and `parentId`. Copilot emits delta and completed tool rows; `assistant.message` is the complete final text. `result` is the terminal envelope:
```jsonl
{"type":"session.tools_updated","data":{"model":"gpt-5.6-luna"}}
{"type":"assistant.tool_call_delta","data":{"toolCallId":"call_…","toolName":"bash","inputDelta":"{\"command\":\"pwd\"}"}}
{"type":"tool.execution_start","data":{"toolCallId":"call_…","toolName":"bash","arguments":{"command":"pwd"}}}
{"type":"tool.execution_complete","data":{"toolCallId":"call_…","success":true,"result":{"content":"/tmp\n"},"shellExecution":{"exitCode":0}}}
{"type":"assistant.message_delta","data":{"deltaContent":"Hi"}}
{"type":"assistant.message","data":{"model":"gpt-5.6-luna","content":"Hi!","phase":"final_answer"}}
{"type":"session.usage_checkpoint","data":{"totalPremiumRequests":1,"totalNanoAiu":277497000}}
{"type":"result","sessionId":"711a…","exitCode":0,"usage":{"premiumRequests":1,"totalApiDurationMs":2317,"sessionDurationMs":8599}}
```
- The `tool_call_delta` was combined here for readability; real input arrived in many small deltas. `session.usage_checkpoint` may be enormous and includes internal cache state; extract only the counters needed. `result.usage.premiumRequests` is per run; `session.usage_checkpoint.totalPremiumRequests` is session cumulative. `/usage` shows session token and credit statistics, **not** remaining account allowance or its reset time. No real quota/error event occurred. Preserve `type:error`/failure payloads and nonzero `result.exitCode`; classify explicit 429/rate-limit/credit-exhausted messages only after a sample is seen. Do not treat a `tool.execution_complete` failure as provider quota.
- GitHub billing may use AI credits or legacy premium requests depending on plan. A [legacy-plan reference](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/copilot-requests) says legacy counters reset at 00:00 UTC on the first of each month; this is **not** evidence of this account's reset. The CLI prints no allowance, but the SDK does: `rpc.account.getCurrentAuth().authInfo.copilotUser` carries `quota_snapshots` and `quota_reset_date_utc` (verified 2026-09-26: premium_interactions 200, 82.4% remaining, reset 2026-10-01T00:00Z; see Plan limits and health above).
