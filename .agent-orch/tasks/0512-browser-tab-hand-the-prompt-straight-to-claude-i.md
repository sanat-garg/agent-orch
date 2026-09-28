# Task #512: Browser tab: hand the prompt straight to Claude in Chrome; setup card when no runner

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 19:15  
- files: browser-task.mjs, agents.mjs, chrome.mjs, server.mjs, public/browser.js, public/browser.css, test/chrome-direct*.test.mjs

## Prompt

Simplify browser tasks per the owner: 'use the extension and just pass on the prompt to it'. Context: .agent-orch/CHROME.md (#496). No node currently reports chrome capability (inventory.chrome is null, or capable:false on Soham's Air: 'Google Chrome is not installed'), because the owner hasn't installed the owner-session Chrome runner (`install-worker-macos.sh --chrome-runner`). 1) Direct mode: when a chrome-capable runner is online, a Browser tab prompt (POST /api/browser/task) runs on that runner as a Claude run with the Chrome integration (extraArgs {chrome: null}) and the owner's prompt passed through nearly verbatim, with only a short fixed preface: 'Use the Claude in Chrome tools to do this in the browser. Stop and ask if a login or 2FA is needed.' plus the owner's 'Don't allow' rules as text. No Playwright MCP, no CDP pre-warm, no live-stream setup in this mode. The deny rules are still enforced on mcp__claude-in-chrome__* tool calls in canUseTool (#476/#496). 2) The Browser tab in direct mode: the prompt box, the running task's step list derived from the extension's tool calls (navigate, click, type, read), screenshots from the extension's `computer screenshot` results shown as thumbnails, the final answer, and a header 'Running in Chrome on <machine>'. Replace the live canvas with the latest screenshot (the owner sees the real window on the Mac itself). 3) No runner online: the Browser tab shows a clear setup card instead of a black or broken view: the 3 steps (install the Claude in Chrome extension and sign in; run `claude login` as yourself on that Mac; run the --chrome-runner install command) with the command pre-filled with the head URL and a FRESH multi-use pairing code (a 'Generate command' button calling the existing pair API) and copy-on-click, plus a status line per Mac ('Chrome not installed' / 'extension missing' / 'no desktop session' / 'ready'). Keep the built-in-browser path available only behind a small 'Use built-in browser instead' link. 4) Tests: with a chrome runner online, a prompt produces a Claude run with the chrome option and the verbatim prompt plus preface, and no Playwright MCP; with none online, the setup card renders with a generated command; a deny rule still holds an extension tool call. Run only the touched test files.

## Done when

`node --test test/chrome-direct*.test.mjs` passes (direct mode passes the prompt with the chrome option and no Playwright, setup card with fresh command when no runner, deny rule enforced)

## Result — done (check passed) (2026-09-28 19:21)

AGENT-ORCH-STATUS: done — Browser prompts go straight to Chrome; setup card shows without runner
