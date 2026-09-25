# Task #90: Screenshot helper and instructions for agents to capture UI screenshots

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 10:18  
- starts after: #89

## Prompt

Make screenshots easy and automatic for agents. 1) Add bin/shot.mjs: `node bin/shot.mjs <url> [out.png] [--full] [--width=1280] [--height=800] [--mobile] [--wait=ms] [--cookie=name=value]`. It uses Playwright's Chromium, which is already cached in ~/.cache/ms-playwright (chromium-1243; add `playwright-core` as a dependency pinned to the version matching that build, or point executablePath at the cached binary). By default it saves to <cwd>/.agent-orch/shots/<timestamp>-<slug>.png and prints the path. Support logging into agent-orch itself for self-screenshots: it should read a session cookie from an env var CW_SHOT_COOKIE if set; document how a test server with a temp CW_DATA_DIR can mint one. 2) Add to the worker system prompt in orchestrator.mjs (and to the chat memory prompt in server.mjs) one short paragraph: when a task changes anything visual, capture before/after screenshots with `node ~/agent-orch/bin/shot.mjs` (absolute path, so it works in any project) into .agent-orch/shots/, and they'll show up in the owner's chat. 3) Document it in README.md. Verify it by screenshotting a test server started on a separate port.

## Done when

`node bin/shot.mjs http://127.0.0.1:<test-port>/login /tmp/shot-check.png` exits 0 and /tmp/shot-check.png is a valid PNG (`file /tmp/shot-check.png` says PNG image data), and `npm test` passes

## Result — done (2026-09-25 13:24)

AGENT-ORCH-STATUS: done — bin/shot.mjs captures PNGs; prompts and README updated
