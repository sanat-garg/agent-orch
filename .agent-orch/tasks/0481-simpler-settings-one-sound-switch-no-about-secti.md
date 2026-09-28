# Task #481: Simpler Settings: one sound switch, no About section

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 18:10  
- files: public/index.html, public/app.js, public/app.css, test/ui-settings-simple*.test.mjs, test/ui-static.test.mjs

## Prompt

Simplify the Settings sheet (public/index.html, public/app.js, app.css): 1) Sounds: replace all sound options (the sound picker, custom uploads, volume and similar) with ONE switch 'Play a sound when a task finishes'. Per-machine sound choice and custom sounds live in each machine's settings in the Machines window, so add the hint 'Choose each machine's sound in Machines'. Keep the underlying settings and APIs. 2) Remove the 'About' section entirely (the version now shows under the logo, #456); keep its data available via the logo tooltip. 3) Review the remaining sections for clutter: group them under at most 4 headings with one-line hints, and remove duplicates of things configured elsewhere. Update the static UI test ids. Tests: Settings has exactly one sound control (a switch) and no About section, and toggling the switch still controls playback. Run only the touched test files.

## Done when

`node --test test/ui-settings-simple*.test.mjs test/ui-static.test.mjs` passes (one sound switch, no About, switch controls playback)
