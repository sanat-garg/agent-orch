# Task #393: extensions.mjs AUDIT #69: http and sse servers keep their outbound list, and a gated run withholds a connector the proxy cannot gate

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 13:14  
- files: extensions.mjs, public/ext.js, test/extensions.test.mjs

## Prompt

Verified gap in extensions.mjs `saveMcp`: the `outbound` tool list is parsed only inside the `type === 'stdio'` branch, so an http/sse connector's outbound tools are silently dropped and `mcpFor(agent, {gate})` hands that server to task runs ungated (gate-proxy.mjs proxies stdio upstreams only; see the gate header in gate.mjs). Fix: (1) parse and keep `outbound` for every type (move the parsing out of the stdio branch). (2) In `mcpFor`, when `run.gate` is set, leave out any non-stdio server that has outbound tools, and record why: return the reason on the result via a new `mcpFor.lastWithheld` is not acceptable; instead make `mcpFor` accept an optional `run.onWithheld(name, reason)` callback (reason: 'connector with outbound tools over http cannot be gated yet; add it as a stdio command') and have `mcpRun` pass it through; runs without a gate are unchanged. (3) `publicMcp` gains `gated: boolean` (stdio with outbound or browser) and `ungatedOutbound: boolean` (non-stdio with outbound) so the UI can say it. (4) public/ext.js's MCP form (`exMcpFields`): show the outbound field for every type, and under it a hint 'Outbound tools are held for your approval only on stdio servers; over http this server stays out of task runs until then' when type is http/sse; in `exRow` show a small 'not gated' tag when `ungatedOutbound`. Tests in test/extensions.test.mjs: save an http server with outbound 'send_mail', assert the list keeps it, `mcpFor('claude', {gate:{dir, onWithheld}})` omits it and calls onWithheld with its name, `mcpFor('claude')` (no gate) still includes it, and a stdio connector is still gated. Update the module header. Do not edit AUDIT.md (held). Run only `npm test -- test/extensions.test.mjs test/ui-ext.test.mjs`.

## Done when

`npm test -- test/extensions.test.mjs test/ui-ext.test.mjs`

## Result — done (check passed) (2026-09-28 13:55)

AGENT-ORCH-STATUS: done — gated runs withhold http outbound connectors; UI tests skipped, no Chromium
