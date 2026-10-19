# Task #2251: Inspect existing live previews at phone and desktop widths, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:17  
- files: public/previews.js, public/previews.css, test/ui-preview-inspector.test.mjs

## Prompt

Add an Inspect action to configured preview cards in public/previews.js, inspired by BloopAI/vibe-kanban's embedded preview. Open a dynamically created inspector with an iframe and 390px, 768px and 1280px viewport choices. Preserve the selected CSS viewport width when scaling it to fit the available screen; label this as layout inspection, not full device emulation. Load only the existing owner-configured URL after an explicit click, provide Open in new tab, and unload the iframe on close. Keep a visible fallback explanation for sites that refuse embedding; do not claim cross-origin load events prove success. Projects without an address get no inspector action. Never create addresses, restart/deploy projects, alter Caddy, or bypass framing restrictions. Test viewport switching and absent-address behaviour using mocked preview data and a localhost fixture only.

## Done when

`npm test -- test/ui-preview-inspector.test.mjs` passes.
