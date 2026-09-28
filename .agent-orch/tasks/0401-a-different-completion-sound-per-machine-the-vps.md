# Task #401: A different completion sound per machine (the VPS and each worker)

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 13:51  
- files: public/sound.js, public/app.js, cluster.mjs, server.mjs, test/ui-sound-machines*.test.mjs

## Prompt

The owner wants a different task-completion sound for each machine, so they can tell by ear where a task finished. 1) Sounds: keep /sounds/task-done.mp3 as the VPS (oracle-vm) default. Add 6 distinct built-in sounds synthesized with the Web Audio API (no new downloads or licensing): short, pleasant chimes that differ in pitch and pattern ('Bell', 'Marimba', 'Pop', 'Glass', 'Rise', 'Two-tone'), each under 1 s, at a gentle volume. 2) Assignment: each machine gets a default by a stable hash of its node id across the palette (so workers differ automatically), and the owner can pick per machine in its settings in the Machines view ('Finish sound: [Bell ▾] ▶ Test'), stored server-side per node (nodes table or kv) so it syncs across devices. 3) Playback: when a task finishes live, play the sound of the machine that ran it (run.node_id; integrations and head tasks use the VPS sound). Keep the existing rules: the Settings master switch, the debounce (if several finish within 3 s, play each distinct machine's sound once, in sequence) and the audio unlock. 4) Tests: the default assignment is stable and distinct for 4 node ids; the chosen sound persists; a done event from node X plays X's sound (mock the audio). Run only the touched test files.

## Done when

`node --test test/ui-sound-machines*.test.mjs` passes (distinct stable defaults, per-node choice persisted, the event plays the machine's sound)

## Result — done (check passed) (2026-09-28 14:03)

AGENT-ORCH-STATUS: done — per-machine finish sounds work and tests pass; no screenshots (Chromium won't launch)
