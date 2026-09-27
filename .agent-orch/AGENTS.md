# Non-Claude coding agent CLIs (for the agents.mjs adapters)

Researched 2026-09-25 on this linux/arm64 VM for Task #25. The owner does a one-time **interactive** login over SSH,
the /shell/ terminal or the Connections modal (steps below). Every adapter must run the CLI with an env stripped of
the "API billing" vars listed per CLI, the same way `API_ENV` works in server.mjs. It must also refuse or kill a run
that reports API-key auth.

The adapters are Claude Code and the OpenAI Codex CLI. Antigravity, OpenCode, Kiro and GitHub Copilot were removed
on 2026-09-27 (CLIs uninstalled, adapters, tests and UI deleted); the Gemini CLI below is researched but has no adapter.

| Agent | Binary | Version | Headless | Resume | Stream format |
|---|---|---|---|---|---|
| OpenAI Codex CLI | `/usr/bin/codex` | codex-cli 0.157.0 | `codex exec --json` | `codex exec resume <id>` | JSONL `thread.*`/`turn.*`/`item.*` |
| Google Gemini CLI (no adapter) | `/usr/bin/gemini` | 0.61.0 | `gemini -p … -o stream-json` | `-r latest\|<index>` | NDJSON `init`/`message`/`tool_use`/`tool_result`/`error`/`result` |

**Install on worker machines** (bin/install-worker*.sh `--agents`): Claude Code `curl -fsSL https://claude.ai/install.sh | bash`
(native build in `~/.local/bin`); Codex `npm i -g @openai/codex` (see §1).

**Model discovery (Task #98, verified 2026-09-25).** The model picker and routing only use lists the CLIs report
(agents.mjs `listModels`/`discoverModels`, cached by models.mjs in `<DATA>/models.json`). Each discovery starts a
CLI, so a list is re-read only once it is a day old (checked hourly, one agent at a time) or after that agent's
sign-in changes. Nothing is hardcoded; a signed-out agent or a failed discovery gives an empty list and a reason.

| Agent | Command | Output |
|---|---|---|
| Claude Code | SDK `query({prompt: <stream that never yields>}).supportedModels()`, then abort (no message sent, nothing billed) | `ModelInfo[]` `{value, resolvedModel, displayName, description}`; the `value: "default"` row marks which alias is the default |
| Codex | `codex debug models` (`--bundled` skips the account refresh) | JSON `{models: […]}` with `slug`, `display_name`, `description`, `priority` and `visibility` (`list` or `hide`) |

**Plan limits and health (Task #195, verified 2026-09-26).** `bin/agent-health.mjs [--json] [--cached]` prints, per agent,
version, sign-in, models, limit windows + source and last fetch; exit 1 if a signed-in agent has 0 models or a window
without a reset although its source reports resets. Limit readings (agents.mjs `fetchLimits`, cached by usage.mjs
`createLimitStore` in `<DATA>/limits.json`) are never polled: only the sidebar usage card's refresh checks one agent.

| Agent | Source | Windows |
|---|---|---|
| Claude Code | SDK `usage_EXPERIMENTAL_…()` on an idle query (on refresh only; orchestrated runs report their limits as they go) | `five_hour`, `seven_day`, `seven_day_opus/_sonnet`, model-scoped, with `resets_at` |
| Codex | newest `~/.codex/sessions/**/rollout-*.jsonl` `token_count.rate_limits` (only as fresh as the last codex run) | `5h`, `weekly`, with `resets_at` |

**Reasoning effort (verified 2026-09-27: Agent SDK 0.3.281, codex-cli 0.157.0).** Only Claude and Codex take an effort;
an agent adapter without `efforts` keeps its default and `runAgentCli` drops `effort` for it. Each adapter declares its
levels (agents.mjs `efforts`), and every discovered model may narrow them (`models[].efforts`); `clampEffort(agent, level,
model)` picks the level itself, else the nearest lower one it accepts, else its lowest.

| Agent | Levels | How it is passed |
|---|---|---|
| Claude Code | `low`, `medium`, `high`, `xhigh`, `max` (SDK `EffortLevel`; per model: `ModelInfo.supportedEffortLevels`) | `query({options: {effort}})`; a live chat session: `q.applyFlagSettings({effortLevel})` (null = model default) |
| Codex | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` (per model: `debug models` → `supported_reasoning_levels[].effort`; e.g. gpt-5.5 stops at `xhigh`, `ultra` only on some) | `-c model_reasoning_effort=<level>`, also on `exec resume` (no `minimal` in 0.157) |

Where the level comes from: the chat's `effort` (`PUT /api/convos/:id/effort {effort: level | null}`, validated against the
chat's agent; null = default). It is **live**, never snapshotted into tasks: every time a task's run starts (new session,
resume, retry, handoff, a worker's `job.start`) the orchestrator reads its project chat's CURRENT effort and clamps it to
the route's agent/model (`taskEffort`). A task's own `tasks.effort` (set only from the task drawer: task action `effort`)
wins when set. A running session keeps its level until its next session boundary; `runs.effort` records what each run used.
Chat turns (Claude's live session, other agents' per-turn runs, the orchestrator planner) use the chat's current effort.

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

## 2. Google Gemini CLI (researched, no adapter)

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
- Env vars to strip: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL`,
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
