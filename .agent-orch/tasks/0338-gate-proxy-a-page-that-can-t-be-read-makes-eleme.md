# Task #338: Gate proxy: a page that can't be read makes element tools, key presses and dialogs outbound, with tests

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:52  
- files: gate-proxy.mjs, test/fixtures/fake-browser-mcp.mjs, test/gate-proxy.test.mjs

## Prompt

Reliability fix in gate-proxy.mjs (the approval gate's stdio MCP proxy; read its header and .agent-orch/AGENTIC.md → Safety). Loophole (verified): check() calls browser_snapshot before classifying a non-read browser tool; when that call errors (r.error / result isError) or times out (callUp's fixed 60 s → null), snap becomes parseSnapshot('') and classify() sees no element names, so `browser_click {target:'e3', element:'the blue button'}` on a real Send button is classed draft and forwarded. gate.mjs is being edited by another task: change ONLY gate-proxy.mjs, test/fixtures/fake-browser-mcp.mjs and a NEW test/gate-proxy.test.mjs.

Change in gate-proxy.mjs: (1) remember whether the snapshot was usable (the call answered without error and resultText(r.result) parsed to a snapshot with a url or at least one ref); (2) when it was not usable and the tool is not a read (isBrowserRead false) and it is an element tool, browser_press_key, browser_handle_dialog, browser_fill_form or a mouse_*_xy tool, override the classification to {cls:'outbound', reason:'the page could not be read before this action'} keeping classify's action/key/target, so it is held for the owner like any outbound call (and audited with that reason); browser_navigate and browser_tabs keep their normal class; (3) read `snapshotMs` from the proxy config (default 60_000) and pass it to callUp for the snapshot so tests can use ~500 ms.

Fixture: in test/fixtures/fake-browser-mcp.mjs honour env FAKE_MCP_SNAPSHOT: 'error' → browser_snapshot returns {content:[{type:'text',text:'Error: page crashed'}], isError:true}; 'hang' → never answers browser_snapshot (all other tools unchanged). Keep existing behaviour when unset.

Tests (test/gate-proxy.test.mjs, copy the MCP client helper and layout from test/approval-gate-run.test.mjs, config written as extensions.mjs gated() does, upstream = the fixture, ttlMs small): (a) FAKE_MCP_SNAPSHOT=error: browser_navigate is forwarded; browser_click {target:'e3', element:'the blue button'} creates an approval file with reason 'the page could not be read before this action', the fixture log shows no browser_click until the test answers approve (gate.mjs answer()), and after a deny the click never runs and the client gets an isError result; (b) FAKE_MCP_SNAPSHOT=hang with snapshotMs 500: same hold within a few seconds, not 60 s; (c) unset: unchanged behaviour, browser_click on e4 'Save draft' is forwarded as draft; (d) hook ticket path with hook:true: a checks/ question answered allow is followed by the same tools/call, and the fixture log shows exactly one browser_snapshot for the pair (the ticket skips the second check). Run only `node --test test/gate-proxy.test.mjs` plus test/approval-gate-run.test.mjs while you work.

## Done when

`node --test test/gate-proxy.test.mjs test/approval-gate-run.test.mjs` and `grep -q 'could not be read' gate-proxy.mjs`
