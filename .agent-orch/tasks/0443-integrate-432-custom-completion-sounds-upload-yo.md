# Task #443: Integrate #432: Custom completion sounds: upload your own, per machine or for all

- kind: work  
- source: planner  
- priority: 95 (normal)  
- created: 2026-09-28 14:35  
- files: sounds.mjs, server.mjs, public/sound.js, public/app.js, public/app.css, test/sounds-custom*.test.mjs

## Prompt

Task #432 ("Custom completion sounds: upload your own, per machine or for all") finished in its own git worktree, but its branch `agent-orch/task-432` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md, public/app.js, public/index.html, server.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #432's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #432's instructions were:

Extend the task-completion sounds (the Web Audio built-ins plus /sounds/task-done.mp3, with per-machine selection from #401; if #401's per-node picker isn't on main yet, build the minimal per-node choice here) with CUSTOM sounds. 1) Upload: in Settings → Sounds (and in each machine's 'Finish sound' picker), '+ Add custom sound' accepts an audio file (mp3, m4a/aac, wav or ogg; at most 1 MB and 10 s, checked client-side via decodeAudioData and server-side by size, type and magic bytes) or an https URL, which the server downloads once with the same limits (no hotlinking at play time). Stored under <DATA>/sounds/<sha>.<ext>, served at /api/sounds/<id> (login-protected, long cache), and listed via GET /api/sounds with its name (editable), duration and size, plus DELETE. 2) Use: custom sounds appear in every sound picker alongside the built-ins, with ▶ preview, trim-free playback, and a per-sound volume slider (0-100%). A sound can be the default for all machines ('Use for all machines') or chosen per machine. Deleting a sound in use falls back to that machine's built-in default. 3) Playback keeps the existing rules (master switch, the debounce with one play per distinct machine, the audio unlock), and preloads the chosen custom sounds after the unlock so they play instantly. 4) Tests: an upload is accepted and rejected over the limits or for a non-audio file; the URL import is stored locally; GET/DELETE work; a done event plays the machine's custom sound (mocked audio); deleting it falls back. Run only the touched test files.

## Done when

`node --test test/sounds-custom*.test.mjs` passes (upload limits and validation, URL import stored locally, list/delete, per-machine custom playback, fallback after delete)

## Result — done (check passed) (2026-09-28 14:38)

AGENT-ORCH-STATUS: done — merge conflicts resolved; custom-sound and machine-settings tests pass
