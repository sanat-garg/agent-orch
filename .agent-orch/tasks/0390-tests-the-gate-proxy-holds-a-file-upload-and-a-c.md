# Task #390: tests: the gate proxy holds a file upload and a coordinate click end to end with the fake browser MCP

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 13:14  
- starts after: #389  
- files: test/gate-proxy-browser.test.mjs, test/fixtures/fake-browser-mcp.mjs

## Prompt

Add test/gate-proxy-browser.test.mjs: spawn gate-proxy.mjs with a browser-kind config whose upstream is test/fixtures/fake-browser-mcp.mjs (copy the setup from test/gate-proxy.test.mjs and test/approval-gate-browser.test.mjs; the fixture answers initialize, tools/list, browser_snapshot and tools/call). Drive it over stdio JSON-RPC: (a) a `browser_file_upload` call with paths ['/etc/hostname'] must write an approvals/<id>.json with cls 'outbound' and reason mentioning uploads, and after the test answers `{decision:'deny', reason:'no'}` the client gets an isError result containing 'NOT performed' and the upstream never saw the call; (b) a `browser_mouse_click_xy` call is likewise held, and after `{decision:'approve'}` it reaches the upstream and the audit.jsonl line has class 'outbound' and decision 'approve'; (c) a `browser_navigate` to 'javascript:alert(1)' is held with key null in the approval file (so no Always can cover it); (d) a `browser_click` on a named plain link in the fixture's snapshot is not held and goes straight through. Extend test/fixtures/fake-browser-mcp.mjs only if a tool name is missing from its TOOLS list. Use a temp gate dir under TMPDIR; kill the proxy in a finally block. Run only `npm test -- test/gate-proxy-browser.test.mjs`.

## Done when

`npm test -- test/gate-proxy-browser.test.mjs`
