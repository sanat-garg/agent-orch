# Task #2249: Save and reuse project prompts from the composer, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:17  
- files: public/prompts.js, public/prompts.css, public/index.html, server.mjs, test/ui-prompt-library.test.mjs

## Prompt

Add a small saved-prompt library in new public/prompts.js and public/prompts.css, inspired by winfunc/opcode's reusable instructions library. Read .agent-orch/AREAS.md first. Let the owner save the current composer draft with a required name, edit/delete saved prompts, and insert one at the cursor without replacing surrounding text or sending it. Store entries per signed-in user and project in this browser, clearly labelled as browser-local. Preserve unsent drafts and show storage/validation errors. Add a desktop composer control and a phone '+' sheet entry dynamically from the module, with its own click handler. Keep app.js and the queued slash-command implementation untouched. The only server.mjs/index.html edits should register the new script and stylesheet. Test save/reload/insert, empty input rejection, and project isolation using local fixtures.

## Done when

`npm test -- test/ui-prompt-library.test.mjs test/ui-static.test.mjs` passes.

## Result — done (check passed) (2026-10-19 16:13)

AGENT-ORCH-STATUS: done — Browser-local saved-prompt library in the composer, with passing tests
