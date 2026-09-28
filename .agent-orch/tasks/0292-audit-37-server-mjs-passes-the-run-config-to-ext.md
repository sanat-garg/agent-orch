# Task #292: AUDIT #37: server.mjs passes the run config to ext.mcpRun so controller runs get the gate and browser

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 08:44  
- files: server.mjs, test/approval-gate-run.test.mjs, test/mcp-source-wiring.test.mjs, .agent-orch/AUDIT.md

## Prompt

Fix AUDIT.md Round 6 item #37 (read it first). In server.mjs (around line 676) `setMcpSource((agent) => ext.mcpRun(agent))` drops the second argument, but agents.mjs `mcpOf` calls `mcpSource(agent, {browser, gate})` for a gated or browser run. So on the controller every task run gets the plain extensions MCP list: no gate-proxy config is written, no Playwright server is added, and gateHooks then allows every MCP call. The worker path (worker.mjs) already passes the run explicitly.

Change it to `setMcpSource((agent, run) => ext.mcpRun(agent, run))`. Then add a regression check so this cannot silently regress: the minimum is an assertion in an existing static test (test/ui-static.test.mjs style is for public/; put it in test/approval-gate-run.test.mjs or a new small test/mcp-source-wiring.test.mjs) that reads server.mjs and requires the two-argument form. If cheap, also make test/approval-gate-run.test.mjs exercise the same lambda shape server.mjs uses rather than its own `(agent, run) => ext.mcpRun(agent, run)`, so the test would have caught this. Never import server.mjs in a test (it boots the app and takes port 3000); read it as text or spawn it on a free port with a temp CW_DATA_DIR like test/server.test.mjs does.

Mark #37 in .agent-orch/AUDIT.md as **Fixed** with a one-line note. Run `npm test -- test/approval-gate-run.test.mjs` plus whichever test file you added.

## Done when

`grep -q 'setMcpSource((agent, run) => ext.mcpRun(agent, run))' server.mjs` and `npm test -- test/approval-gate-run.test.mjs` passes

## Result — done (2026-09-28 08:46)

AGENT-ORCH-STATUS: done — Controller runs get gate/browser config; tests catch regressions
