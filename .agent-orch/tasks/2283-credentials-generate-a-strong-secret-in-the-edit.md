# Task #2283: Credentials: generate a strong secret in the editor, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:41  
- files: public/credentials.js, public/credentials.css, test/ui-credentials-generate.test.mjs

## Prompt

Goal: in the Credentials sheet's editor (public/credentials.js, startEdit/fieldRow/input), each value field gets a 'Generate' button that fills it with a strong random secret, for setting up keys like SESSION_SECRET or a database password without leaving the app. Use crypto.getRandomValues (never Math.random). A small menu or segmented choice offers: 32-char letters+digits (default), 64-char hex, and a 24-char password with symbols. Filling a non-empty field asks confirm('Replace the current value?') first. The generated value is shown (not dotted) until saved, and saving uses the existing save path.

Edge cases: cancel on the confirm leaves the value unchanged; nothing is sent to the server until the owner presses Save. 44px targets on phones (public/credentials.css). Don't edit app.js.

Test: new test/ui-credentials-generate.test.mjs copying the setup of the existing credentials UI test (grep test/ for credentials): Generate fills an empty field with a 32-char [A-Za-z0-9] value, hex mode gives 64 [0-9a-f], and dismissing the confirm keeps an existing value.

## Done when

`npm test -- test/ui-credentials-generate.test.mjs` passes.
