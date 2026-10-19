# Task #2280: Screenshots: attach a screenshot to the project chat, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:41  
- files: public/shots.js, public/shots.css, test/ui-shots-attach.test.mjs

## Prompt

Goal: in the Screenshots sheet (public/shots.js), each screenshot (the large newest one and each grid thumbnail's lightbox or a small button) gets 'Attach to chat'. It fetches the image, wraps it in a File named '<task>-<name>.png' (keep the real extension/type), closes the sheet, opens the project's main chat (openConvo(cid) if not open, setView('chat'), closeSidebar()), and calls app.js's global addAttachments([file]) so it appears in the composer's attachment tray, ready to send with a note like 'this button is misaligned'. Don't send anything.

Find the project's chat id the same way shots.js already knows the open project (SH.pid; look for convo_id in orchestrator project data in app.js). Edge cases: fetch fails or non-OK → toast an error ('Couldn't attach that screenshot') and keep the sheet open; no project chat → explain inline. Respect Compare mode (button not shown while comparing). 44px targets on phones (public/shots.css). Don't edit app.js.

Test: new test/ui-shots-attach.test.mjs copying test/ui-shots.test.mjs's setup: pressing Attach to chat adds a tray item with the screenshot's name; a 404 image shows the error toast and adds nothing.

## Done when

`npm test -- test/ui-shots-attach.test.mjs` passes (attach adds the screenshot to the tray; a failed fetch shows an error and adds nothing).
