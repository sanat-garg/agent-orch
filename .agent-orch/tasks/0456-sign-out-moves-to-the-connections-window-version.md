# Task #456: Sign out moves to the Connections window; version shown under the logo

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 14:53  
- starts after: #407  
- files: public/index.html, public/app.js, public/app.css, test/ui-signout-version*.test.mjs, test/ui-static.test.mjs

## Prompt

Two sidebar changes (public/index.html, public/app.js, public/app.css). 1) Remove the 'Sign out' button from the sidebar footer (index.html ~line 91, <button class="link-btn" id="logout">) and put it in the Connections window (the modal opened from the sidebar footer's connection status): at the bottom, separated from the agent rows, as an 'agent-orch account' row saying 'Signed in to agent-orch on this device', with a 'Sign out' button (danger style) that keeps the existing logout behaviour (the same handler and endpoint, with a confirmation 'Sign out of agent-orch on this device?'). Keep id="logout" on the new button so existing code and tests still find it, and update the static UI test for its new location. 2) Show the running version under the logo: in .side-head (index.html ~lines 31-33: the logo img plus .side-title 'agent-orch'), stack the title and a small muted second line with the running version from /api/version (the v-format from #407, e.g. 'v3.52'), 11-12px, tabular figures, with the full 'v3.52 · a1b2c3d · restarted 13:05' in its title attribute; tapping it opens Settings → About. Remove the separate 'build N' / version label from the sidebar footer so it isn't shown twice. It updates after a restart (the WebSocket hello), and the header height stays tidy. Tests: the sidebar footer has no #logout; the Connections modal contains #logout, and clicking it asks for confirmation then calls logout; .side-head shows the version text from a mocked /api/version; the footer has no version label. Run only the touched test files.

## Done when

`node --test test/ui-signout-version*.test.mjs test/ui-static.test.mjs` passes (logout in Connections with confirmation, none in the footer, version under the logo)
