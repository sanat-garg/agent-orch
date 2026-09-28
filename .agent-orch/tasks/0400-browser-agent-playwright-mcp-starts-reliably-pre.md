# Task #400: Browser agent: Playwright MCP starts reliably (pre-warm, longer connect timeout, auto-retry)

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 13:51  
- files: browser.mjs, bin/browser-mcp.mjs, agents.mjs, browser-task.mjs, test/browser-mcp-start*.test.mjs

## Prompt

Browser screen tasks fail with the agent saying: 'The Playwright browser tool server failed to connect (connection timeout)… playwright MCP server failed to connect (CONNECT_TIMEOUT)', so it can't open Google (the owner's task: search hotels in Ranthambore). Fix the startup path used for browser runs (browser.mjs MCP config builder, bin/browser-mcp.mjs, agents.mjs env for the Claude and Codex runs): 1) Never use `npx -y @playwright/mcp` at run time: always the pinned local install (node_modules/@playwright/mcp/cli.js), installing it at boot/update if missing, on the head AND on workers. 2) Pre-warm: before the agent starts, launch or attach the profile's browser (the supervisor from #348 if landed, else browser-live's launch) and wait until its CDP endpoint answers /json/version, so the MCP only has to attach. 3) Timeout: give the agent's MCP client enough startup time: for Claude set MCP_TIMEOUT (ms) in the run env, e.g. 90000, and the per-server timeout fields if the SDK config supports them; for Codex, its MCP startup_timeout in the config. Make the stdio wrapper print nothing to stdout before the MCP handshake (log to stderr only). 4) Auto-retry: if a browser run ends because the MCP failed to connect (detect CONNECT_TIMEOUT / 'failed to connect' in the result or the MCP status), restart the browser and retry the run up to 2 times automatically before surfacing it, with an owner-readable status 'Browser tool couldn't start: retried twice' instead of the agent's raw text. 5) Measure: log the MCP startup time per run, and show it in the browser activity panel's details. Test with a real Chromium: a browser task's MCP connects within the timeout on this VPS, a simulated slow start (delay the wrapper by 40 s) still connects with the raised timeout, and a forced failure triggers the retry. Run only the touched test files.

## Done when

`node --test test/browser-mcp-start*.test.mjs` passes (connects on this VPS, survives a 40 s slow start, retry on forced failure)
