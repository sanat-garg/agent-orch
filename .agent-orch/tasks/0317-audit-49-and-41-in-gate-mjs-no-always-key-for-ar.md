# Task #317: AUDIT #49 and #41 in gate.mjs: no always key for arbitrary-code tools, argument hashes on connector keys, loopback navigation is outbound

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:34  
- files: gate.mjs, test/approval-gate.test.mjs, .agent-orch/AUDIT.md

## Prompt

Two classifier findings from AUDIT.md, both in gate.mjs `classify(tool, args, ctx)` (line ~118 onward; approvals.mjs uses the returned `key` for 'always allow' via `a.key && SELECT ... status='always'`, so a null key can never be auto-approved). (1) #49: for arbitrary-code browser tools (`browser_evaluate`, `browser_run_code`, anything matching /evaluate|run_code|execute/ ) return `key: null` so an earlier 'always' never covers different code, and put the first 120 chars of the code in `action`. For connector calls (kind !== 'browser') the key becomes `server|tool|<8-hex sha256 of the recipient-like args>` where recipient-like args are the values of keys matching /^(to|cc|bcc|recipient|recipients|email|channel|chat|phone|number|account|payee|url|path|id)s?$/i, JSON-stringified in key order (no such args → key stays `server|tool`), so 'always' on `send_email (to: bob@…)` does not cover `to: x@evil.com`. (2) #41: in the `browser_navigate` branch, a url whose host is loopback (localhost, 127.0.0.0/8, ::1), link-local (169.254.0.0/16, fe80::/10) or private (10/8, 172.16/12, 192.168/16, fc00::/7, or a bare hostname with no dot such as `caddy`) is `cls: 'outbound'` with reason 'opens a local or private service'; the same for `browser_click` on an element whose `url` points there. Keep the header comment accurate. Tests in test/approval-gate.test.mjs: evaluate has a null key; two send_email calls with different `to` have different keys and the same `to` the same key; navigate to http://127.0.0.1:7682 and http://192.168.1.5/ is outbound, https://example.com/ stays draft. Mark #49 and #41 **Fixed** in .agent-orch/AUDIT.md with a one-line note each (for #41 say the Chromium sandbox half is still open).

## Done when

`node --test test/approval-gate.test.mjs` passes and `grep -n 'local or private service' gate.mjs` prints a line

## Result — done (check passed) (2026-09-28 12:44)

AGENT-ORCH-STATUS: done — Code tools have no always key; local navigation now held
