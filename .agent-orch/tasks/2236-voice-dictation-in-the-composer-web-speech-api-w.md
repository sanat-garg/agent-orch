# Task #2236: Voice dictation in the composer (Web Speech API), with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:11  
- files: public/app.js, public/index.html, public/app.css, public/phone.css, test/ui-dictation.test.mjs

## Prompt

Let the owner dictate prompts, especially on the iPhone PWA. Add a mic button to the composer (public/index.html next to #send; on phones <768px a 'Dictate' row in #plusSheet instead, following the existing rows there, see test/ui-mobile-composer.test.mjs). Use `window.SpeechRecognition || window.webkitSpeechRecognition` with continuous + interimResults and lang = navigator.language. Interim text shows live in #input after what was already typed, final text is committed, and the field auto-grows as when typing. While listening the button shows a pulsing red state with aria-pressed=true and its label is 'Stop dictation'. Tapping it again, sending, or 30 s of silence stops. Edge cases: no API → hide the button and row entirely; 'not-allowed'/'service-not-allowed' errors → toast 'Microphone access is off for this site'; other errors → toast the error and reset the button. Never auto-focus #input on phones (CONTEXT.md). Code in public/app.js, styles in public/app.css + public/phone.css (44px target under pointer: coarse, no new public files). Write test/ui-dictation.test.mjs (playwright-core, with a fake webkitSpeechRecognition injected via addInitScript): interim then final results land in #input and send stops it; without the API the button is hidden.

## Done when

`npm test -- test/ui-dictation.test.mjs test/ui-static.test.mjs` passes.

## Result — done (check passed) (2026-10-19 14:30)

AGENT-ORCH-STATUS: done — Composer dictation works on desktop and phones; its tests pass
