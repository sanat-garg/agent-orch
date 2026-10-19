# Task #2290: Integrate #2282: Live previews: Copy link and Share on each live card, with tests (ui)

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-10-19 16:06  
- files: public/previews.js, public/previews.css, test/ui-preview-share.test.mjs

## Prompt

Task #2282 ("Live previews: Copy link and Share on each live card, with tests (ui)") finished in its own git worktree, but its branch `agent-orch/task-2282` conflicts with `main`, which changed meanwhile (conflicting files: public/previews.css, public/previews.js). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #2282's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #2282's instructions were:

Goal: in the sidebar's Live previews manager (public/previews.js, liveRow), each project with an address gets 'Copy link' and, where navigator.share exists (phones), 'Share' so the owner can send a preview to a client or open it on another device. Copy uses the app's copyToClipboard helper if present (grep app.js) else navigator.clipboard, then toast 'Link copied'. Share calls navigator.share({ title: <project name>, url }); a user cancel (AbortError) is silent, any other error toasts. Hide Share when navigator.share is absent. Also add Copy link next to 'Open in new tab' in the inspector bar (openInspector).

Edge cases: a project with no address shows neither button; clipboard failure toasts 'Couldn't copy the link'. Keep the row compact: icon buttons with aria-labels and titles, 44px under @media (pointer: coarse) (public/previews.css). Don't edit app.js or server.mjs.

Test: new test/ui-preview-share.test.mjs copying test/ui-previews.test.mjs's setup: Copy link writes the preview URL to the clipboard (grant permissions or stub navigator.clipboard) and toasts; Share is hidden without navigator.share and calls it with the URL when stubbed.

## Done when

`npm test -- test/ui-preview-share.test.mjs` passes.

## Result — done (check passed) (2026-10-19 16:18)

The lock is already documented, so nothing new for CONTEXT.md. Both conflicts are resolved, the share test and both sibling preview tests pass, and the resolved files are staged with the merge left uncommitted.

AGENT-ORCH-STATUS: done — merge resolved; share icons sit in folded rows; tests pass
