# Task #357: gate-proxy.mjs: a forwarded tools/call times out after callMs with an audited tool error, late answers dropped

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:35  
- files: gate-proxy.mjs, test/gate-proxy.test.mjs, test/fixtures/fake-browser-mcp.mjs

## Prompt

Reliability fix in gate-proxy.mjs (the approval gate's MCP proxy; read its header comment and gate.mjs's exports first). Problem: `handle()` forwards an allowed tools/call with `await new Promise((resolve) => { waiting.set(m.id, resolve); toUp(m); })` and no timeout. Calls run one at a time through `chain`, so when the upstream (the Playwright MCP or a connector) never answers one call (a hung page, a dialog it is stuck on, a crashed tab), every later call of the run, including the Claude hook's `checks/` requests, waits for good and the agent sits until the task's own timeout. The proxy's own snapshot calls already have `snapshotMs`; forwarded calls need the same.

Change:
1. Read `callMs` from the config (`cfg.callMs`, default 5 * 60_000; clamp to at least 10_000). Document it in the header comment's Config line.
2. In `handle()`, race the forwarded call against a timer of `callMs`. On timeout: `waiting.delete(m.id)`, remember the id in a small `lateIds` set (bounded, e.g. keep the last 200), audit the call with `{ok: false, result: 'timed out: <server> did not answer within <N> s', ms}` and answer the client with `{result: {content: [{type: 'text', text: 'gate: <server> did not answer within <N> s; the page may be stuck, take a snapshot before retrying'}], isError: true}}` so the chain moves on. Clear the timer when the answer arrives normally.
3. In the upstream `lines(up.stdout, ...)` handler, a response whose id is in `lateIds` is dropped (delete it from the set), never forwarded, so the client never receives two responses for one id. Anything else keeps its current behaviour.
4. Fixture: test/fixtures/fake-browser-mcp.mjs gains `FAKE_MCP_HANG=<tool name>`: a tools/call for that tool is logged but never answered (mirror how `FAKE_MCP_SNAPSHOT=hang` is done for browser_snapshot). Update its header comment.
5. Tests in test/gate-proxy.test.mjs (copy the existing `proxy()` helper pattern; let it accept `hang` and `callMs` options written into the config): (a) with `FAKE_MCP_HANG=browser_navigate` and `callMs: 10000` (use the minimum so the test stays fast; if you prefer a faster test, let the clamp floor be 2_000 and set callMs 2000), a `browser_navigate` call returns an isError result mentioning 'did not answer' within a few seconds instead of hanging, the audit line for it has `ok: false` and a 'timed out' result, and a following `browser_snapshot` call still succeeds (the chain moved on); (b) a normal call is unaffected and its audit has `ok: true`. Keep the four existing tests passing.

Constraints: no new dependencies; match the terse style; do not touch gate.mjs (another task holds it) or extensions.mjs. Never import server.mjs. Run only `node --test test/gate-proxy.test.mjs` to verify.

## Done when

`node --test test/gate-proxy.test.mjs` passes and `grep -n "callMs" gate-proxy.mjs` prints at least one line
