# Task #428: gate.mjs AUDIT #68 (re-run, browser-free check): uploads, coordinate clicks and javascript:/data: navigation are outbound; Enter's Always key names the field

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:20  
- files: gate.mjs, test/gate-classify.test.mjs

## Prompt

Close four loopholes in gate.mjs `classify` (the approval gate for browser tasks; read the module header and .agent-orch/AGENTIC.md → Safety). This is a re-run of task #389, which failed only because its check ran a Chromium test on a Mac with no browser: this task's check is the pure classifier test alone and must not launch a browser, so it passes on any machine. Verified on main d99af1f, all four are still open: (1) `browser_file_upload` is in BROWSER_DRAFT, so a task can hand any local file (the head's data dir, ~/.codex/auth.json) to a web page without approval: make it outbound with reason 'uploads local files', action 'Upload <paths, clipped>' and key `<server>|<tool>|<sha256 of the sorted paths>` (never a bare Always). (2) `browser_mouse_click_xy` and `browser_mouse_drag_xy` are draft, so a click on Send by coordinates skips the element classifier: make them outbound with reason 'clicks by coordinates, target unknown' and key null. (3) `browser_navigate` to a `javascript:`, `data:`, `blob:` or `vbscript:` URL is draft because isLocalUrl throws on the fake port: classify these as outbound with reason 'runs code in the page' and key null (arbitrary code, like browser_evaluate); keep file:/chrome: outbound as today (they come out outbound via isLocalUrl) and add an explicit check so that stays true if isLocalUrl changes. (4) `browser_press_key`'s key is `key(args.key)`, so one Always on Enter in a search box covers every later Enter: include the focused element's role and name (or 'none') in the key, like the element tools do. Update the header comment and BROWSER_DRAFT accordingly. Tests in a NEW file test/gate-classify.test.mjs (plain node:test over classify/parseSnapshot, copy the style of test/approval-gate.test.mjs's classify assertions; no playwright, no browser): one assertion per loophole plus the unchanged cases (browser_click on a named link stays draft, browser_navigate to https://example.com stays draft, browser_type without submit stays draft). Verify with `node --test test/gate-classify.test.mjs test/approval-gate.test.mjs` (both browser-free). Do not edit .agent-orch/AUDIT.md: the ledger task follows.

## Done when

`node --test test/gate-classify.test.mjs test/approval-gate.test.mjs`
