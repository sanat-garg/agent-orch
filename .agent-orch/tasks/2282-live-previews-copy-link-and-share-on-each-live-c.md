# Task #2282: Live previews: Copy link and Share on each live card, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:41  
- files: public/previews.js, public/previews.css, test/ui-preview-share.test.mjs

## Prompt

Goal: in the sidebar's Live previews manager (public/previews.js, liveRow), each project with an address gets 'Copy link' and, where navigator.share exists (phones), 'Share' so the owner can send a preview to a client or open it on another device. Copy uses the app's copyToClipboard helper if present (grep app.js) else navigator.clipboard, then toast 'Link copied'. Share calls navigator.share({ title: <project name>, url }); a user cancel (AbortError) is silent, any other error toasts. Hide Share when navigator.share is absent. Also add Copy link next to 'Open in new tab' in the inspector bar (openInspector).

Edge cases: a project with no address shows neither button; clipboard failure toasts 'Couldn't copy the link'. Keep the row compact: icon buttons with aria-labels and titles, 44px under @media (pointer: coarse) (public/previews.css). Don't edit app.js or server.mjs.

Test: new test/ui-preview-share.test.mjs copying test/ui-previews.test.mjs's setup: Copy link writes the preview URL to the clipboard (grant permissions or stub navigator.clipboard) and toasts; Share is hidden without navigator.share and calls it with the URL when stubbed.

## Done when

`npm test -- test/ui-preview-share.test.mjs` passes.

## Result — in progress (1) (2026-10-19 15:49)

AGENT-ORCH-STATUS: continue — tool calls now denied; share test failed, needs debugging

## Result — done (check passed) (2026-10-19 16:05)

Both views look right: the copy icon sits compact between the address and the pill, with a 44pt target on the phone, and Share is correctly absent in a browser without `navigator.share`. Tests, static checks and the inspector suite all pass.

AGENT-ORCH-STATUS: done — Copy link and Share on live cards, tests pass
