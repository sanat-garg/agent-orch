# Task #389: gate.mjs AUDIT #68: file uploads, javascript:/data: navigation and coordinate clicks are outbound; Enter's always key names the field

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-28 13:14  
- files: gate.mjs, test/gate-classify.test.mjs

## Prompt

Close four loopholes in gate.mjs `classify` (the approval gate for browser tasks; read the module header and AGENTIC.md → Safety). Verified: (1) `browser_file_upload` is in BROWSER_DRAFT, so a task can hand any local file (the head's data dir, ~/.codex/auth.json) to a web page without approval: make it outbound with reason 'uploads local files', action 'Upload <paths, clipped>' and key `server|tool|<sha of the sorted paths>` (never a bare always). (2) `browser_mouse_click_xy` and `browser_mouse_drag_xy` are draft, so a click on Send by coordinates skips the element classifier: make them outbound with reason 'clicks by coordinates, target unknown' and key null. (3) `browser_navigate` to a `javascript:`, `data:`, `blob:` or `vbscript:` URL is draft because isLocalUrl throws on the fake port: classify these as outbound with reason 'runs code in the page' and key null (arbitrary code, like browser_evaluate); keep file:/chrome: behaving as today (they already come out outbound via isLocalUrl) and add an explicit check so that stays true if isLocalUrl changes. (4) `browser_press_key`'s key is `key(args.key)`, so one Always on Enter in a search box covers every later Enter: include the focused element's role and name (or 'none') in the key, like the element tools do. Update the header comment and BROWSER_DRAFT accordingly. Tests in a NEW file test/gate-classify.test.mjs (plain node:test over classify/parseSnapshot, copy the style of test/approval-gate.test.mjs's classify assertions): one assertion per loophole plus the unchanged cases (browser_click on a named link stays draft, browser_navigate to https://example.com stays draft, browser_type without submit stays draft). Do not edit .agent-orch/AUDIT.md (held by another task); the ledger task follows.

## Done when

`npm test -- test/gate-classify.test.mjs test/approval-gate-browser.test.mjs`
