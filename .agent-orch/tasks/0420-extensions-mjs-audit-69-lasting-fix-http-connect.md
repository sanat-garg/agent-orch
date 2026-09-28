# Task #420: extensions.mjs AUDIT #69 lasting fix: http connectors with outbound tools run through the gate proxy instead of being withheld

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:14  
- files: extensions.mjs, test/extensions.test.mjs, test/ext-gate-http.test.mjs

## Prompt

Goal: close AUDIT #69 properly. gate-proxy.mjs now speaks MCP streamable http upstream (`cfg.upstream = {url, headers}`; task #412, see its header comment and test/gate-proxy-http.test.mjs with test/fixtures/fake-http-mcp.mjs). extensions.mjs `mcpFor(agent, run)` still withholds every non-stdio server with `outbound` tools from a gated run (`WITHHELD_REASON`, `run.onWithheld`). Change it so that in a gated run an `http` server with outbound tools is routed through the proxy exactly like a stdio one: `gated(s, g)` writes the 0600 proxy config with `upstream: {url: s.url, headers: s.headers || {}}` for http servers (`{command, args, env}` for stdio, unchanged) and returns the same stdio proxy entry (node gate-proxy.mjs --config <file>, holdSec). Only `sse` servers (the legacy transport the proxy does not speak) stay withheld, with a reason that says so (rename/reword WITHHELD_REASON accordingly: "connector with outbound tools over sse cannot be gated; add it as http or a stdio command"). Update the header comment and the comments above mcpFor and saveMcp that say only stdio can be gated. Tests: extend test/extensions.test.mjs's gating cases (an http connector with outbound tools in a gated run becomes a stdio proxy entry whose config file holds `upstream.url` and `connector.outbound`; an sse one is still withheld with the new reason; an http server without outbound tools is passed through untouched), and add test/ext-gate-http.test.mjs that runs the whole path end to end: start test/fixtures/fake-http-mcp.mjs, build the run config with mcpFor for `claude` with a gate dir, spawn the proxy entry it returns over stdio, send initialize + tools/list and a read-only tools/call, and assert the fake http server received them and the audit.jsonl in the gate dir logged the call. Leave AUDIT.md alone (held by #397); the ledger note comes later.

## Done when

`npm test -- test/extensions.test.mjs test/ext-gate-http.test.mjs` passes and `! grep -q "over http cannot be gated" extensions.mjs`

## Result — done (check passed) (2026-09-28 14:16)

AGENT-ORCH-STATUS: done — http connectors now run through the gate proxy; sse still withheld
