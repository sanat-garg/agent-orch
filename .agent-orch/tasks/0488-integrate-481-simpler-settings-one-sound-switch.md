# Task #488: Integrate #481: Simpler Settings: one sound switch, no About section

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-09-28 18:15  
- files: public/index.html, public/app.js, public/app.css, test/ui-settings-simple*.test.mjs, test/ui-static.test.mjs

## Prompt

Task #481 ("Simpler Settings: one sound switch, no About section") finished in its own git worktree, but its branch `agent-orch/task-481` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #481's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #481's instructions were:

Simplify the Settings sheet (public/index.html, public/app.js, app.css): 1) Sounds: replace all sound options (the sound picker, custom uploads, volume and similar) with ONE switch 'Play a sound when a task finishes'. Per-machine sound choice and custom sounds live in each machine's settings in the Machines window, so add the hint 'Choose each machine's sound in Machines'. Keep the underlying settings and APIs. 2) Remove the 'About' section entirely (the version now shows under the logo, #456); keep its data available via the logo tooltip. 3) Review the remaining sections for clutter: group them under at most 4 headings with one-line hints, and remove duplicates of things configured elsewhere. Update the static UI test ids. Tests: Settings has exactly one sound control (a switch) and no About section, and toggling the switch still controls playback. Run only the touched test files.

## Done when

`node --test test/ui-settings-simple*.test.mjs test/ui-static.test.mjs` passes (one sound switch, no About, switch controls playback)

## Result — done (check passed) (2026-09-28 18:15)

AGENT-ORCH-STATUS: done — CONTEXT.md conflict resolved; settings and static tests pass
