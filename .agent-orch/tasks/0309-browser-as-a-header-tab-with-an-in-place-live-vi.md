# Task #309: Browser as a header tab with an in-place live view and an agent prompt box

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 11:07  
- files: public/index.html, public/browser.js, public/browser.css, public/app.js, test/ui-static.test.mjs, test/ui-browser-view*.test.mjs

## Prompt

UI: move the Browser from the sidebar to the top header and make it a working screen. 1) Remove the sidebar button (#browserBtn, public/index.html ~line 73) and add a 4th tab 'Browser' to the header segmented control (index.html ~lines 100-110, next to Chat/Files/Terminal, same style, with an icon). Selecting it sets #app data-view='browser' like the other tabs (public/app.js view switching). 2) The browser view renders IN PLACE, not as a modal: a slim toolbar (a profile/machine picker from GET /api/browser, the URL bar, back, reload, Watch/Take over/Hand back as today), then the live canvas (reuse the viewer code in public/browser.js and browser.css, refactored so the same viewer mounts either inline or in the existing modal; the modal stays for opening from task drawers), scaled to fit the width. 3) BELOW the canvas: a prompt box styled like the chat composer ('Tell an agent what to do on this screen…', multiline, Enter sends on desktop, a send button) that calls POST /api/browser/task {prompt, identity, node} for the currently shown profile. Under it, a compact activity panel for that profile's running or last task (GET /api/browser/tasks plus the live WebSocket updates): the status, a steps list ('Opened gmail.com', 'Clicked Archive', 'Typed in Search'), screenshot thumbnails using the standard thumbnail size, the final result text, inline approval cards (Approve/Deny) when the gate holds an action, and Stop. While an agent is working, the canvas shows a subtle 'Agent is working' ring, and the owner can still Take over. 4) Mobile: at 390px the canvas fits the width, and the prompt box sticks above the keyboard (reuse the composer keyboard handling). Keep the theme consistent (CSS vars, system font). Extend the static UI smoke test (the new ids exist, #browserBtn is gone), and a UI test with a mocked /api/browser/task confirms that sending the prompt posts the right body and renders returned steps. Screenshots via bin/shot.mjs on desktop and at 390px.

## Done when

`node --test test/ui-static.test.mjs test/ui-browser-view*.test.mjs` passes, the header has a Browser tab (data-view="browser"), `! grep -n 'id="browserBtn"' public/index.html`, and the prompt box posts to /api/browser/task
