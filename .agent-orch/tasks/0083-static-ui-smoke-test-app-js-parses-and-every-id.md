# Task #83: Static UI smoke test: app.js parses and every $('id') exists in index.html

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 09:36

## Prompt

Add test/ui-static.test.mjs (node:test, no new dependencies). It should: (1) read public/app.js and check it parses. Use `new vm.Script(src)` from node:vm, or spawn `node --check public/app.js` and assert exit code 0. (2) Collect every string-literal id passed to the `$` helper in public/app.js (`const $ = (id) => document.getElementById(id)`, so calls look like `$('send')`). Assert that each id appears as `id="..."` in public/index.html. If an id is created dynamically in JS rather than in the HTML, allow it through a small explicit allowlist in the test with a comment. As of 2026-09-25 a manual check found no missing ids, so the allowlist should start empty. (3) Also assert that every `<script src>` and `<link href>` in public/index.html and public/login.html that points to a local file exists under public/, or is served by a route in server.mjs (check how server.mjs serves vendor files like marked/dompurify before asserting). Keep it fast (well under 1 s) and match the style of the existing tests in test/. Don't change public/ or server code unless the test finds a real bug; if it does, fix it and note it in .agent-orch/AUDIT.md. Never restart the live server on port 3000.

## Done when

`node --test test/ui-static.test.mjs` passes and `npm test` passes
