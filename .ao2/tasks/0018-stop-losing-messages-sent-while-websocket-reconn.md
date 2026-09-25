# Task #18: Stop losing messages sent while WebSocket reconnects (AUDIT #7)

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-24 23:37  
- starts after: #17

## Prompt

Fix AUDIT.md item #7 in /home/ubuntu/claude-web/public/app.js. send() (~line 1049) silently drops the message when ws.readyState !== 1, but the composer submit handler (~line 1276) clears the input and the saved draft anyway. Make send() return true/false. In the composer submit path, when send() returns false, keep the text and draft in the composer and show a visible notice (reuse any existing toast/notice helper in app.js) saying something like 'Not connected, reconnecting. Your message was kept.' Optionally queue it and resend in the ws onopen handler, but never send it twice. Keep vanilla JS with no build step, and match the existing style. Check syntax with `node --check public/app.js`. Mark #7 as **Fixed** in .ao2/AUDIT.md.

## Done when

`node --check public/app.js` succeeds, the composer submit handler only clears the input when send() returns true (visible in the diff), and AUDIT.md marks #7 Fixed

## Result — done (check passed) (2026-09-25 03:22)

AO2-STATUS: done — Unsent messages stay in composer with a reconnecting notice
