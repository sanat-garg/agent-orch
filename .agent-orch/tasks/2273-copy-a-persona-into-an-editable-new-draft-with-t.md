# Task #2273: Copy a persona into an editable new draft, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:35  
- files: public/ext.js, public/ext.css, test/ui-persona-copy.test.mjs

## Prompt

Add Copy to existing persona entries in public/ext.js. Open the normal persona editor prefilled with a distinct suggested name, summary and instructions, but without the original ID. Save must create a new persona through the existing API; Cancel creates nothing. Preserve the original persona and all chat assignments. Reuse existing validation, dirty-draft handling, search and editor controls, with scoped public/ext.css additions only if needed. Inspiration: [winfunc/opcode](https://github.com/winfunc/opcode)'s purpose-built agent library: make it easy to create a specialist variation of instructions that already work. Add test/ui-persona-copy.test.mjs covering editing and saving a copy, distinct identity and unchanged assignments, cancellation, required input and a failed save retaining the draft. Include a phone layout assertion and run the focused test with isolated fixtures.

## Done when

`npm test -- test/ui-persona-copy.test.mjs` passes.
