# Browser tasks through Claude in Chrome (`claude --chrome`)

Task #496. How browser tasks can drive the owner's real Google Chrome through Anthropic's **Claude in Chrome**
extension instead of our Playwright/CDP stack (browser.mjs, browser-live.mjs), and the setup agent-orch supports.
Facts below were read out of the Claude Code CLI 2.1.283 binary on Sanat's MacBook Pro (`strings claude.exe`) and
the Agent SDK 0.3.281 typings. Re-check them when the CLI changes.

## How `claude --chrome` reaches the extension

- **Extension**: Claude in Chrome, id `fcoeoabgfenejglbffodgkkbkcdhcgfn` (https://claude.ai/chrome). The CLI treats
  it as installed when `<browser dir>/<profile>/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn` exists in any profile
  named `Default` or `Profile N`. On macOS it checks Chrome (`~/Library/Application Support/Google/Chrome`), Brave,
  Arc, Chromium, Edge, Vivaldi and Opera. It has no notion of "which profile": whichever Chrome profile has the
  extension and is open and signed in to claude.ai gets the commands.
- **Native messaging host**: at startup with `--chrome` the CLI (re)writes
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json`
  (`"type": "stdio"`, `allowed_origins: ["chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/"]`), pointing at a
  small launcher that runs `claude --chrome-native-host`. Chrome starts that host when the extension connects.
- **Bridge**: the native host listens on a Unix socket in `/tmp/claude-mcp-browser-bridge-<username>/<pid>.sock`.
  The CLI adds a dynamic stdio MCP server named `claude-in-chrome` (`claude --claude-in-chrome-mcp`) that connects
  to the sockets in that directory. **The directory is keyed by the macOS user name, so Chrome and `claude` must run
  as the same user**, and Chrome must actually be running in that user's desktop session.
  (The CLI also knows an account-level relay, `mcp__remote-devices__claude-in-chrome__*`, and a local bridge
  `ws://localhost:8765` for development; neither is a documented way to reach another user's Chrome, so we don't
  rely on them.)
- **Sign-in**: the integration is disabled unless the Claude OAuth token has a scope accepted by
  `/api/oauth/validate` (`user:profile`, `user:office` or `user:ccr_inference`). *"env-var and setup-token sessions
  default to user:inference only"*: a worker running on the head's shared `CLAUDE_CODE_OAUTH_TOKEN` (agent-share.mjs)
  **cannot** use Chrome. The runner must use an interactive `claude login` of the owner's own account.
- **Permissions inside the extension**: when the session is in bypassPermissions mode (ours always is, agents.mjs)
  the CLI sets `CLAUDE_CHROME_PERMISSION_MODE=skip_all_permission_checks`, so the extension's own per-site prompts
  are skipped. Our gate hook (below) is then the only thing between the agent and a "Send" button.

## Tools it exposes

MCP server `claude-in-chrome`, tools `mcp__claude-in-chrome__<name>`: `tabs_context_mcp`, `tabs_create_mcp`,
`tabs_close_mcp`, `navigate` (`{url, tabId}`, `url` may be `back`/`forward`), `computer` (`{action, coordinate?, ref?,
text?, tabId}`; actions include `left_click`, `right_click`, `double_click`, `triple_click`, `left_click_drag`, `type`,
`key`, `scroll`, `screenshot`, `zoom`, `wait`, `hover`), `read_page`, `find`, `get_page_text`, `form_input`,
`javascript_tool`, `read_console_messages`, `read_network_requests`, `gif_creator`, `upload_image`, `resize_window`,
`update_plan`, `shortcuts_list`, `shortcuts_execute`. The CLI's system prompt tells the model to call
`tabs_context_mcp` first and to use its own tab (tab group) rather than the owner's tabs. The tools may be deferred
(loaded through ToolSearch). `computer` `screenshot` returns an image block.

## Enabling it from the Agent SDK

There is no dedicated query option; pass the CLI flag through `extraArgs` (a flag with no value is `null`):
`query({ prompt, options: { extraArgs: { chrome: null }, … } })` → `claude --chrome`. chrome.mjs exports this as
`CHROME_OPTIONS`; agents.mjs `runClaude({ chrome: true })` merges it with `mcp-config`. `--no-chrome` forces it off.
With `--chrome` the CLI enables it regardless of the user's `claudeInChromeDefaultEnabled` setting, but still needs
the scope above and the extension. If the bridge isn't connected, the init message lists `claude-in-chrome` as
`failed`: runClaude ends the run with `mcp_connect_failed` instead of letting the agent work blind.

## Headless and no-GUI limits

- It drives a real, visible Chrome window in a GUI session. There is no headless mode; Chrome with the extension has
  to be running (the CLI can open it, but only in the session of the user it runs as).
- **A macOS user without a GUI login cannot use it.** Our Mac workers run as the hidden `agentorch` user from a
  LaunchDaemon: no Aqua session, no WindowServer connection, no Chrome, and a bridge directory
  (`…-agentorch`) that the owner's Chrome never writes to. Running `claude` as agentorch against the owner's Chrome
  doesn't work either: a different user name means a different socket dir, and the extension's host runs as the owner. Linux VPS workers have no Chrome session at all.

## Supported setup: the Chrome runner (opt-in)

A second, lightweight worker process that runs **as the owner, in the owner's own logged-in desktop session**, and
takes only browser tasks:

    curl -fsSL https://<head>/install/worker-macos.sh | sudo bash -s -- --controller https://<head> --code <CODE> --chrome-runner

- `--chrome-runner` (bin/install-worker-macos.sh, bash 3.2-safe) does the usual install and additionally, as the
  owner: a checkout at `~/agent-orch-worker`, a separate pairing in `~/.agent-orch-chrome-runner`
  (`AGENT_ORCH_WORKER_HOME`), named "Chrome on <computer name>", and a LaunchAgent
  `~/Library/LaunchAgents/com.agent-orch.worker.chrome-runner.plist` (`LimitLoadToSessionType Aqua`, KeepAlive) with
  `AGENT_ORCH_CHROME_RUNNER=1` and `AGENT_ORCH_WORKER_BROWSER=off`. It runs only while the owner is logged in.
  It pairs as its own machine, so the code must be a multi-use one (or re-run with `--chrome-runner --code <new>`;
  an existing runner pairing is kept). `--uninstall` removes the LaunchAgent (`--purge` its pairing too).
- The owner does once, in their own account: install Google Chrome, install the Claude extension and sign it in to
  claude.ai, `claude login` (the native installer's `~/.local/bin/claude`, which agents.mjs runs), and run
  `claude --chrome` once so the CLI registers the native host. The installer ends by saying what is still missing.
- In runner mode the worker (worker.mjs `CHROME_RUNNER`) ignores the head's shared Claude token (it keeps the owner's
  own sign-in), skips the Playwright browser, and reports `inventory.chromeRunner: true`. The head never sends it
  anything but browser tasks.
- Trade-off: agents in the runner act as the owner (their files and their Chrome profile's logged-in sites). That's
  the point for browser tasks, and why only browser tasks go there; the approval gate still applies.

## What agent-orch does with it

- **Capability** (chrome.mjs `detectChrome`, in every Mac worker's inventory as `inventory.chrome`): capable when
  Google Chrome.app is in /Applications or ~/Applications, the extension is in a profile, the native host manifest
  exists, this user owns the console (`stat -f %Su /dev/console`: a GUI session), and Claude isn't on a setup token.
  Otherwise `reason` says what's missing. Workers advertise feature `chrome`.
- **Routing** (orchestrator.mjs `place`, chrome.mjs `browserRoute`): while any chrome-capable node (inventory +
  features `chrome` and `approvals`) is online, a Claude browser task goes only to one, waiting for it if it's busy; a
  Browser-tab prompt drops its profile's machine pin for it. Only when no chrome node is online does it take the
  Playwright path as before. Codex-routed browser tasks keep Playwright. The job's `job.start.chrome: true` makes the
  worker run Claude with `CHROME_OPTIONS` and no Playwright MCP; `tasks.browser_runner` records 'chrome'/'builtin'.
- **Browser tab**: `/api/browser` returns `runner` (`orch.browserRunner()`), and the prompt hint reads "Using Chrome
  on Sanat's Macbook Pro" or "Built-in browser (no Chrome runner online) · <profile>".
- **"Don't allow" rules (#476)**: the extension's calls don't pass through gate-proxy.mjs, so agents.mjs `gateHooks`
  judges every `mcp__claude-in-chrome__*` call itself (chrome.mjs `judgeChrome`, gate.mjs `matchRule`): a match is
  written to the gate dir's `approvals/` and waits for the owner exactly like a Playwright hold (the worker relays it
  to the head); a denial reaches the model as the owner's words and the call never runs; every call is appended to
  `audit.jsonl`. The page can't be snapshotted before a call, so coordinate clicks, submit keys and `javascript_tool`
  are "unknown target" (any action or phrase rule holds them), url rules match the navigate target and the page the
  run last opened, and reads (screenshots, `read_page`, `find`, tabs context…) never hold. This runs in the
  **PreToolUse hook, not `canUseTool`**: runs use `permissionMode: 'bypassPermissions'`, under which the SDK never
  calls canUseTool, while PreToolUse hooks always run.
- **Screenshots**: `computer` screenshots come back as tool-result images; agents.mjs `claudeEvents` turns them into
  `image` events, which the worker streams and the head stores as the task's media, like any tool-result image.

## Not verified here

The MacBook's agentorch account has no GUI session and no extension, so no real end-to-end `--chrome` run was made
for #496; tests cover detection with stubbed paths, the SDK option, the rule hold on an extension tool and the
routing/fallback (test/chrome-runner.test.mjs). First real use: install with `--chrome-runner`, check the runner
shows "Chrome is ready", send a Browser-tab prompt and watch the head's log for `#N runs on Chrome on …`.
