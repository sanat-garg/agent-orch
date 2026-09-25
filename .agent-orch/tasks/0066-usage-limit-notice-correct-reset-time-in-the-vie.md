# Task #66: Usage-limit notice: correct reset time in the viewer's timezone

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 08:21

## Prompt

Bug: when the owner sends a chat message while rate-limited, orchestrator.mjs planTurn (~line 1236) emits the notice "Saved. You're at your usage limit until <time>", with the time formatted on the SERVER (UTC, no date) via toLocaleTimeString. It's also wrong when blocked_until is only a backoff guess (unknown_limit_streak path, ~line 968). Fix: 1) Emit the notice with a structured field, e.g. {t:'notice', text, until: <epoch s>, untilKnown: bool}. In public/app.js's notice rendering (~line 759) format `until` in the BROWSER's local timezone, include the weekday/date when it isn't today, and show relative time too (e.g. 'Fri 1:50 PM (in 5h 30m)'). 2) Compute the real reset from the most specific data available: the reset of the currently-rejected limit in the limits table (upsertLimit rows written from rate_limit_info, ~line 965) and the usage windows the server already has (server.mjs ~lines 463-583: five_hour/seven_day resets_at). Use the actual limit's reset, minus the internal resetBufferSec, for display. 3) If the reset isn't known, say 'Saved. You're at your usage limit; the reset time isn't known yet. Retrying around <time>.' Also fix the same server-side formatting in the other user-visible messages: orchestrator.mjs ~line 978 logEvent and server.mjs ~line 862. Pass epochs and format them client-side, or at least include the date and timezone. Add unit tests for the reset-selection function.

## Done when

`npm test` passes with tests for reset selection, and `! grep -n "toLocaleTimeString" orchestrator.mjs` finds no user-facing server-side time formatting in the limit notice

## Result — done (check passed) (2026-09-25 08:26)

AGENT-ORCH-STATUS: done — Usage-limit notices show the real reset in the viewer's timezone; tests pass
