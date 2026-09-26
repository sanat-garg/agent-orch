# Task #186: Kiro Connect: pick the login method; never hang on an unanswered CLI prompt

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-26 12:43  
- files: connections.mjs, public/app.js, public/app.css, public/index.html, test/connections*.test.mjs

## Prompt

Bug: Kiro's Connect hangs on 'Waiting for the sign-in link…'. connections.mjs runs `kiro-cli login --use-device-flow` in tmux (socket agent-orch-login, session login-kiro), but the CLI first shows an interactive menu that nobody answers:
```
? Select login method ›
❯ Use with Builder ID
  Use with Google
  Use with GitHub
  Use with Your Organization
```
(`kiro-cli login --help` offers --license free|pro, --identity-provider <url>, --region, and --use-device-flow.) Fix: 1) Connect on Kiro first shows a method picker in the Connections modal: Builder ID, Google, GitHub, or Your organization (the last asks for a start URL and region). Pass --license free for the first three, and --license pro --identity-provider <url> --region <r> for an organisation, and drive any remaining menu by detecting the '? Select login method' prompt in capture-pane and sending the right number of Down keys plus Enter (read the highlighted ❯ row to confirm the selection before pressing Enter). Then continue to the device URL + code as today. Verify which methods actually produce a device-flow URL headless. If Google/GitHub social login needs a localhost browser redirect that can't work on this server, grey it out with that explanation rather than letting it hang. 2) A generic safeguard for ALL login specs: if no URL or code is detected within ~10 s but the pane shows a prompt (a line starting with '?' or a '›'/'❯' selector, or '(y/N)'), switch the panel to 'The CLI is asking:' with the last ~12 pane lines rendered as text, plus Cancel. Also add a hard 3-minute 'no progress' timeout with a clear error. Never leave an indefinite 'Waiting…'. 3) Kill the stale login-kiro tmux session left from the stuck attempt on start. Tests: fixture pane text for the Kiro menu → the correct keys are sent for each method; the prompt-detection safeguard triggers on unknown prompts. Verify manually on a test server (separate port, CW_DATA_DIR=$(mktemp -d), CW_NO_ORCHESTRATOR=1) that choosing Builder ID reaches a device URL and code, then cancel it.

## Done when

`npm test` passes with Kiro menu-driving and prompt-safeguard tests, and on a test server starting Kiro with Builder ID yields a device URL (GET /api/connections shows kiro login with a url)
