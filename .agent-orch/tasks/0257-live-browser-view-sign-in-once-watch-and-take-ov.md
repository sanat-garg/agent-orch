# Task #257: Live browser view: sign in once, watch and take over from the app

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 01:58  
- starts after: #256  
- files: browser-live.mjs, server.mjs, cluster.mjs, worker.mjs, public/app.js, public/app.css, public/index.html, test/browser-live*.test.mjs

## Prompt

Let the owner see and control an agent-orch browser from the web UI (AGENTIC.md, Browser section). 1) Backend: for a profile on any node (controller or worker via the cluster socket), start or attach to Chromium with that persistent profile and stream it with the CDP Page.startScreencast (JPEG frames, throttled to ~5-10 fps, only while a viewer is open) over the existing authenticated WebSocket, forwarding the owner's mouse, keyboard, scroll and paste to Input.dispatch* events. Include navigation controls (URL bar, back, reload). Only one controller at a time: if a task is using the profile, the owner can 'Watch' (read-only) or 'Take over' (pauses the task's browser actions until 'Hand back'). 2) UI: a 'Browser' entry in the sidebar (or the Connections modal) lists profiles per machine with 'Open'. The viewer is a modal/sheet with the live canvas, which scales to fit and works on iPhone with touch-to-click and an on-screen keyboard input. Use this to sign in to Gmail, Canva and others once. Also add a 'Signed-in sites' list per profile (cookie domains, with no values shown) and 'Clear profile'. 3) Running browser tasks show a live thumbnail in their drawer with Watch/Take over. Theme-consistent, with prefers-reduced-motion respected. Test: a server test that the screencast frames flow for a local page, input dispatch reaches the page (typing into an input), and take-over pauses the task's MCP actions.

## Done when

`node --test test/browser-live*.test.mjs` passes (frames stream, typed input reaches a local page, take-over blocks task actions), and the UI has a Browser viewer reachable from the sidebar
