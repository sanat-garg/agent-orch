# Task #181: Fix AUDIT #34: forbid framing and harden the session cookie against same-site sslip.io hosts

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-26 10:52  
- files: server.mjs, test/server.test.mjs, test/security-headers.test.mjs, Caddyfile

## Prompt

Read .agent-orch/AUDIT.md finding #34. In server.mjs `handleRequest`, next to the existing `X-Content-Type-Options` header, send `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` on every response (including static files, login page, 401s). Make the session cookie un-shadowable: when the cookie is set with `Secure` (HTTPS / behind Caddy), name it `__Host-cw_session` (Secure, Path=/, no Domain); keep plain `cw_session` only where the server sets a non-Secure cookie (plain-http local/test use), so tests and local dev still work. Reading: prefer the `__Host-` cookie. When several cookies share a name, use the FIRST occurrence (the browser sends the most specific host cookie first), not the last. Logout must clear whichever name is in use. Existing owner sessions will be signed out once; that is acceptable. Also add matching `header` lines for `/shell/` (ttyd) in the Caddyfile if the repo has one (find it; if it lives outside the repo, just note the suggested snippet in AUDIT.md instead of editing it). Update test/server.test.mjs where it references `cw_session`, and add assertions in test/security-headers.test.mjs: both frame headers are present on `/`, `/login.html` and a 401 `/api/*` response; with two `cw_session` cookies in one header, the first valid one wins. Append a `- **Fixed** (task #<this id>): ...` line under #34 in .agent-orch/AUDIT.md.

## Done when

`node --test test/security-headers.test.mjs test/server.test.mjs` passes
