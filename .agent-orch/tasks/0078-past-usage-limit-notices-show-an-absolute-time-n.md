# Task #78: Past usage-limit notices show an absolute time, not 'now' (AUDIT #26)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 09:09  
- starts after: #77

## Prompt

Fix AUDIT.md item #26 in /home/ubuntu/agent-orch/public/app.js (withUntil / fmtResetAt, around lines 1770-1780). Right now, when a persisted limit notice is replayed with an `until` that has already passed, it says 'until now', 'Retrying around now.' or 'it resets now.'. When `until` is in the past, show the absolute local time instead, e.g. 'until Thu 3:10 PM', with no relative part. Future times should render as they do today. If the formatting logic is pure, move it to a small function that test/limit-reset.test.mjs can import or evaluate, following how that test already covers limit-reset formatting, and add cases for a past and a future `until`. Run `node --check public/app.js`. Mark #26 Fixed in AUDIT.md.

## Done when

`npm test` passes with a new case that a past `until` renders an absolute time and not 'now', and AUDIT.md marks #26 Fixed.
