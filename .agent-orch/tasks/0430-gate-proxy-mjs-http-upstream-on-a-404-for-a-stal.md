# Task #430: gate-proxy.mjs http upstream: on a 404 for a stale session, initialize again once and retry the call

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:20  
- files: gate-proxy.mjs, test/gate-proxy-http.test.mjs, test/gate-proxy-http-session.test.mjs, test/fixtures/fake-http-mcp.mjs

## Prompt

Make the gate proxy's http transport survive a restarted MCP server. In gate-proxy.mjs `httpUpstream` (read the header: streamable http per the MCP spec, `Mcp-Session-Id` from initialize is sent on every later POST), a POST that answers a non-2xx status is failed to the client with `gate: <server> http <status>`. When the upstream restarts (hosted connectors and local http servers do), it no longer knows the session and answers 404 to every request, so every tool call of the run fails until the whole run is restarted. The spec says the client must start a new session by sending initialize again. Implement: keep the last initialize request message (params) the client sent; when a POST with a session id gets 404, once per stale session, clear `session`, re-send that initialize (and `notifications/initialized`) with the same headers, swallow their answers (do not forward them to the client; the client already initialized), then retry the original message once with the new session id; if the retry fails too, fail as today. Serialize this through the existing `ready` promise so parallel in-flight calls wait for the one re-initialize rather than each starting their own. Keep stdio behaviour untouched. Test in test/gate-proxy-http.test.mjs (or a new test/gate-proxy-http-session.test.mjs copying its setup): extend test/fixtures/fake-http-mcp.mjs with a control to forget its session (e.g. a `POST /reset` or a special tool that makes it answer 404 to the old session id and issue `fake-session-2` on the next initialize; keep every existing test passing), then assert: after the reset, a tools/list from the client still succeeds, the log shows initialize sent again with no session, the retried call carried `fake-session-2`, and the client saw exactly one answer for its request and no stray initialize result. Also assert a genuine 404 that persists after one re-initialize is reported to the client as an error, not retried forever. Run only the gate-proxy test files.

## Done when

`node --test test/gate-proxy-http.test.mjs test/gate-proxy.test.mjs`

## Result — done (check passed) (2026-09-28 14:23)

AGENT-ORCH-STATUS: done — http gate proxy re-initializes after a stale-session 404 and retries
