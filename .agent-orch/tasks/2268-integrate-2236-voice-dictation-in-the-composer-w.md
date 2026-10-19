# Task #2268: Integrate #2236: Voice dictation in the composer (Web Speech API), with tests (ui)

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-10-19 14:31  
- files: public/app.js, public/index.html, public/app.css, public/phone.css, test/ui-dictation.test.mjs

## Prompt

Task #2236 ("Voice dictation in the composer (Web Speech API), with tests (ui)") finished in its own git worktree, but its branch `agent-orch/task-2236` conflicts with `main`, which changed meanwhile (conflicting files: public/app.js). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #2236's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #2236's instructions were:

Let the owner dictate prompts, especially on the iPhone PWA. Add a mic button to the composer (public/index.html next to #send; on phones <768px a 'Dictate' row in #plusSheet instead, following the existing rows there, see test/ui-mobile-composer.test.mjs). Use `window.SpeechRecognition || window.webkitSpeechRecognition` with continuous + interimResults and lang = navigator.language. Interim text shows live in #input after what was already typed, final text is committed, and the field auto-grows as when typing. While listening the button shows a pulsing red state with aria-pressed=true and its label is 'Stop dictation'. Tapping it again, sending, or 30 s of silence stops. Edge cases: no API → hide the button and row entirely; 'not-allowed'/'service-not-allowed' errors → toast 'Microphone access is off for this site'; other errors → toast the error and reset the button. Never auto-focus #input on phones (CONTEXT.md). Code in public/app.js, styles in public/app.css + public/phone.css (44px target under pointer: coarse, no new public files). Write test/ui-dictation.test.mjs (playwright-core, with a fake webkitSpeechRecognition injected via addInitScript): interim then final results land in #input and send stops it; without the API the button is hidden.

## Done when

`npm test -- test/ui-dictation.test.mjs test/ui-static.test.mjs` passes.

## Result — done (check passed) (2026-10-19 14:37)

AGENT-ORCH-STATUS: done — app.js conflict resolved; submit stops dictation and hides slash menu
