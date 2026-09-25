# Task #145: Play a completion sound when a task finishes while the tab is in the background

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 23:50

## Prompt

Add an audible cue for finished tasks. 1) Download https://cdn.pixabay.com/audio/2025/01/20/audio_9afb73ceb5.mp3 into public/sounds/task-done.mp3 (serve it locally; add the audio/mpeg MIME in server.mjs's static MIME map if it's missing, with long cache headers). If the download fails, stop and report it; don't substitute another sound. 2) In public/app.js, when a WebSocket update shows a task (work or reflect kind, not plan) transitioning to status 'done' for the first time, while document.visibilityState === 'hidden' OR !document.hasFocus(), play the sound once. Debounce so several tasks finishing within 3 s play a single sound. Don't play for events replayed on page load or reconnect (only live transitions observed after the initial state sync). 3) Autoplay policy: create one HTMLAudioElement (preload='auto', volume 0.6) and 'unlock' it on the first pointerdown/keydown (a muted play()+pause(), or resume an AudioContext) so later background plays are allowed. Catch and ignore play() rejections. 4) A toggle 'Sound when tasks finish' (default on) in the orchestrator settings popover (#obPop), persisted in localStorage, with a small 'Test' button that plays it. 5) Optionally also flash the document title ('✓ Task done · agent-orch') until the tab regains focus. Test on a separate port with CW_DATA_DIR=$(mktemp -d) and CW_NO_ORCHESTRATOR=1.

## Done when

public/sounds/task-done.mp3 exists (`file public/sounds/task-done.mp3` reports MPEG audio), `node --check public/app.js && npm test` passes, and app.js plays it only on a live done transition when the document is hidden or unfocused
