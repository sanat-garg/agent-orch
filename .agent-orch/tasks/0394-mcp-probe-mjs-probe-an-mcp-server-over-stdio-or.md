# Task #394: mcp-probe.mjs: probe an MCP server over stdio or streamable http and report its tools or the error

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 13:14  
- files: mcp-probe.mjs, test/mcp-probe.test.mjs, test/fixtures/fake-mcp.mjs

## Prompt

New module mcp-probe.mjs (plain node ESM, node built-ins only, no deps; header comment in the repo's style) exporting `probeMcp(server, {timeoutMs = 15000, env = process.env} = {})` for a server record as extensions.mjs stores it ({name, type: 'stdio'|'http'|'sse', command, args, env, url, headers}). stdio: spawn the command through helpers.mjs `spawnHelper` (so leftovers are killed), send JSON-RPC `initialize` (protocolVersion '2025-06-18', capabilities {}, clientInfo {name:'agent-orch', version:'probe'}), then `notifications/initialized`, then `tools/list`; resolve `{ok: true, serverInfo, protocolVersion, tools: [{name, description}], ms}`; kill the child on completion. http: POST the same messages to `url` with `Accept: application/json, text/event-stream` and the server's headers, honouring an `Mcp-Session-Id` response header on later requests, parsing either a JSON body or a text/event-stream body's `data:` lines. sse type: return `{ok: false, error: 'SSE servers cannot be probed yet'}`. Any failure (spawn error, non-zero exit before an answer, timeout, malformed JSON, HTTP status ≥ 400, missing tools array) resolves `{ok: false, error: <one line, clipped to 300 chars, with the last stderr line for stdio>, ms}`; never rejects, never leaves a process running. Tests in test/mcp-probe.test.mjs: stdio against test/fixtures/fake-mcp.mjs (add a tools/list answer to that fixture returning two tools; keep its existing behaviour), a stdio command that does not exist (ok false, error names it), a stdio server that never answers (a `node -e 'setInterval(()=>{},1000)'` stub; timeoutMs 500 → ok false, error mentions timeout, and its pid is gone afterwards), and http against a tiny node:http server in the test that answers initialize and tools/list as JSON (and one that answers 500). Wiring the route and the Skills & tools button is a later task; do not touch server.mjs. Run only `npm test -- test/mcp-probe.test.mjs`.

## Done when

`npm test -- test/mcp-probe.test.mjs` && `node --check mcp-probe.mjs`
