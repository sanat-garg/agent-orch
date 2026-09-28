# Task #354: Browser tab ui: an Earlier prompts list under the activity panel with tap-to-show and Ask again

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:31  
- files: public/browser.js, public/browser.css, test/ui-browser-view.test.mjs

## Prompt

Feature in public/browser.js and public/browser.css only (app.js, app.css, index.html and server.mjs are held by other tasks: build the markup from browser.js with `el` inside #bxActivity). Read CONTEXT.md's public/ notes, browser.js from `const BX = …` (about line 457) through bxRenderActivity, and browser.css. BX.tasks already holds up to 100 recent screen prompts for the selected profile (GET /api/browser/tasks), but the panel shows only one (bxShown(): the pinned, running, queued or newest task). Add, after the shown task's content, a compact 'Earlier prompts' section (class bx-earlier) listing the other tasks newest first, at most 8 with a 'Show more' link-btn that reveals the rest: each row is a button showing a status dot (reuse the bx-st classes), `#id`, the title truncated to one line, and a relative time from finished_at or created_at via the shared fmtDur/withUntil helpers where they fit (never format dates on the server). Tapping a row sets BX.pin to that id and re-renders, so its steps, screenshots and result show; the shown task's head gets a 'Back to latest' link-btn when BX.pin points at a task that is not the live one (clears the pin). Each row also has a small 'Ask again' button (44px touch target under `@media (pointer: coarse)`, 16px field sizes unaffected) that copies the task's prompt (t.prompt, else its title) into #bxInput, focuses it and runs bxSyncSend(), without sending. Hide the section when there is one task or none. Styles go in browser.css using existing tokens (--border, --muted, --panel); keep rows 36px on desktop. Extend test/ui-browser-view.test.mjs's desktop test (copy its setup: it fakes /api/browser/tasks): with three tasks in the fake list, the section lists two rows, tapping a row shows that task's title in .bx-title, 'Back to latest' returns to the newest, and 'Ask again' fills #bxInput with the prompt and leaves the send unsent (no POST to /api/browser/task). Check ui-static.test.mjs still passes (no duplicate function names across public/*.js). Verify with `npm test -- test/ui-browser-view.test.mjs test/ui-static.test.mjs`.

## Done when

`npm test -- test/ui-browser-view.test.mjs test/ui-static.test.mjs` passes and `grep -q 'bx-earlier' public/browser.js` and `grep -q 'bx-earlier' public/browser.css`
