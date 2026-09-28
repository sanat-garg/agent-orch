# Task #412: gate-proxy.mjs: a streamable-http upstream, so http connectors can be gated instead of withheld (AUDIT #69's lasting fix)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:00  
- files: gate-proxy.mjs, test/gate-proxy-http.test.mjs, test/fixtures/fake-http-mcp.mjs

## Prompt

gate-proxy.mjs (read its header) always spawns a stdio upstream (`cfg.upstream.command/args/env`), which is why http/sse MCP connectors with outbound tools cannot be gated (AUDIT #69; #393 withholds them from gated runs as a stop-gap). Add an http upstream: when `cfg.upstream.url` is set (with optional `cfg.upstream.headers`), the proxy speaks MCP streamable http to it instead of spawning: every JSON-RPC message the proxy would write to the upstream's stdin becomes a POST to the url with headers `Content-Type: application/json`, `Accept: application/json, text/event-stream`, the configured headers, and `Mcp-Session-Id` once the initialize response carried one; a response with `Content-Type: application/json` is one JSON-RPC message (or a batch array), a `text/event-stream` response is read as SSE and each `data:` line is a message, until the stream ends; a 202/204 with no body is a delivered notification; a non-2xx status or network error becomes a JSON-RPC error `{code: -32603, message: 'gate: <server> http <status/err>'}` to the client for requests with an id (and a stderr line for notifications). Every message that comes back is fed into the same `lines`-style dispatcher (own / waiting / lateIds / toClient) as stdio responses, so classification, holding, audit and the callMs timeout work unchanged; refactor toUp into an `upstream` object `{send(m), close()}` with a stdio and an http implementation and keep the stdio path byte-for-byte in behaviour. Use node:http/https only (no deps). Tests: a NEW fixture test/fixtures/fake-http-mcp.mjs (a node http server on a free port passed via argv or printed on stdout; answers initialize with a Mcp-Session-Id header, tools/list with two tools including `send_message` (outbound) and `read_inbox`, tools/call as JSON, and, when the request has a `?sse=1` query or the tool is `read_inbox`, as an SSE body; rejects a request without the session id with 400; records every request for assertions), and a NEW test/gate-proxy-http.test.mjs modelled on test/gate-proxy.test.mjs: a `read` call passes through and the answer reaches the client; an outbound `send_message` is held (an approvals/<id>.json appears) and a deny makes it a tool error with no request reaching the fixture; the SSE-shaped answer is delivered; a 500 from the fixture becomes a JSON-RPC error; the session id is sent on the second request. Do NOT edit extensions.mjs, gate.mjs or AUDIT.md (held); routing http connectors through the proxy is a later task. Run only the new test file and test/gate-proxy.test.mjs.

## Done when

`npm test -- test/gate-proxy-http.test.mjs test/gate-proxy.test.mjs` passes

## Result — done (check passed) (2026-09-28 14:04)

AGENT-ORCH-STATUS: done — gate-proxy gates streamable-http upstreams; both test files pass
