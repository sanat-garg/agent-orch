# Task #496: Browser tasks via Claude in Chrome (claude --chrome) on a Mac

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 18:40  
- files: .agent-orch/CHROME.md, agents.mjs, orchestrator.mjs, worker.mjs, browser-task.mjs, gate.mjs, bin/install-worker-macos.sh, public/browser.js, test/chrome-runner*.test.mjs

## Prompt

The owner wants browser tasks to use the Claude in Chrome extension instead of our own Playwright/CDP stack. The Claude Code CLI on this machine shows `--chrome  Enable Claude in Chrome integration` / `--no-chrome`. Study and integrate: 1) Research (write .agent-orch/CHROME.md): how `claude --chrome` connects to the extension (native messaging host, which Chrome profile, requirements: Chrome installed with the Claude extension signed in, a GUI session), the tool names it exposes (e.g. mcp__claude-in-chrome__*), how to enable it from the Agent SDK (query options such as extraArgs {chrome: null}, or the equivalent), headless limits, and whether it works for a macOS user WITHOUT a GUI login. Our Mac workers run as the hidden 'agentorch' user, which has no desktop session, so decide and document the supported setup: e.g. an opt-in 'Chrome runner' mode where a lightweight worker process runs under the OWNER's own logged-in macOS account (a LaunchAgent in the owner's session, with Chrome + extension), taking only browser tasks. 2) Implement: a node capability 'chrome' (detected: Chrome present, the extension's native host registered, a GUI session active); browser tasks (the screen prompts from the Browser tab, capabilities ['browser']) prefer a chrome-capable node and run Claude with the Chrome integration enabled, falling back to the existing Playwright path only when no chrome node is online (with a note in the UI). The owner's 'Don't allow' rules (#476) still apply: intercept the extension's tool calls in canUseTool by tool name plus args, and hold matching ones for approval. Screenshots from the extension flow into the task's media if available. 3) The installer (bin/install-worker-macos.sh) gets an optional `--chrome-runner` that installs the owner-session LaunchAgent (bash 3.2-safe; see CONTEXT.md). 4) The Browser tab shows which runner is used ('Using Chrome on Sanat's Macbook Pro' vs 'Built-in browser'). 5) Tests: capability detection with stubbed paths; a browser task routes to a chrome node with the right SDK option; a deny-rule match on an extension tool is held; the fallback happens when no chrome node is online. Run only the touched test files.

## Done when

`node --test test/chrome-runner*.test.mjs` passes (detection, routing with the chrome option, deny rule holds extension tool, fallback), and .agent-orch/CHROME.md documents the setup
