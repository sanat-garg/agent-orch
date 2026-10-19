# Task #2272: Download Markdown code blocks as files, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:35  
- files: public/code-download.js, public/code-download.css, public/index.html, server.mjs, test/ui-code-download.test.mjs

## Prompt

Create public/code-download.js and public/code-download.css to add a Download action to Markdown code blocks in chat replies and task output. Keep the action outside the pre/code text and existing shell-copy capture target. Download the exact code text, including whitespace, through a Blob with a conservative language-to-extension mapping and .txt fallback. Disable empty-block downloads and provide a useful failure message. Handle streamed replacements and reopened task output without duplicate controls or a polling timer; limit observation to relevant output containers. Preserve shell click-to-copy and text selection. Only add asset tags in public/index.html and static allowlist entries in server.mjs; do not modify app.js or other active feature sections. Inspiration: [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)'s integrated chat/file workflow; downloading snippets is our adaptation. Add test/ui-code-download.test.mjs verifying downloaded bytes and filename, unknown-language fallback, streamed replacement without duplicates, empty content and phone reachability.

## Done when

`npm test -- test/ui-code-download.test.mjs` passes.

## Result — in progress (1) (2026-10-19 16:37)

AGENT-ORCH-STATUS: continue — code-download files and test written; test run not yet verified

## Result — done (check passed) (2026-10-19 16:45)

AGENT-ORCH-STATUS: done — code blocks in chat and task output now have a Download button; 4 tests pass
