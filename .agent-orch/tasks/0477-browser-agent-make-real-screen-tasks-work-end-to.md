# Task #477: Browser agent: make real screen tasks work end to end, with a fix-until-green suite

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 18:10  
- files: bin/browser-e2e.mjs, browser-task.mjs, browser-live.mjs, browser.mjs, bin/browser-mcp.mjs, .agent-orch/BROWSER-E2E.md, test/browser-e2e-fixes*.test.mjs

## Prompt

The owner says browser access 'doesn't work properly'; it should be a fully working system. Build bin/browser-e2e.mjs, which runs REAL screen prompts through the same path as the Browser tab (POST /api/browser/task on a test server with CW_DATA_DIR temp, or the browser-task.mjs internals directly) with a real agent (Claude, cheapest capable model) on the shared per-profile browser (#348) and a real Chromium: (a) 'Open google.com and search for hotels in Ranthambore; list the first 5 results with links'; (b) fill and submit a local test form (served by the script) and verify the server received the values; (c) open two tabs and copy text from one into a field in the other; (d) download a file from a local page and report its name; (e) upload a local file to a local upload page; (f) scroll a long page and extract an item near the bottom; (g) handle a cookie/consent banner. For each, verify the OUTCOME independently (the local server logs or page state), not just the agent's words. Record the pass/fail, time and tool events in .agent-orch/BROWSER-E2E.md. Then fix every root cause in our stack (MCP startup, the CDP attach, tab following, downloads dir, file upload paths, viewport, timeouts, prompt/system guidance for browser runs, the result parsing in browser-task.mjs) and re-run until all 7 pass. Document any external limits honestly (CAPTCHAs). Keep the unit tests passing and add regression tests for each fix. Run only the touched test files plus the e2e script.

## Done when

`node bin/browser-e2e.mjs` exits 0 with all 7 scenarios passing, recorded in .agent-orch/BROWSER-E2E.md
