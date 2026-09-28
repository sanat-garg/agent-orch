# Task #451: Simpler phone prompt window

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 14:49  
- starts after: #449  
- files: public/app.js, public/app.css, public/index.html, test/ui-mobile-composer*.test.mjs

## Prompt

Redesign the chat composer on phones (<768px) to be simpler, building on #449's single combined model + fallbacks pill. Following ~/.claude/skills/apple-design (text fields, keyboard), make it one clean rounded input area: the auto-growing text field (16px font) with a round send button inside its right edge; ONE small row above or inside it with only the model pill (truncated), and an attach '+' button that opens a sheet with the rest (attach file, image, effort if present, other composer options). Remove every other chip, label, hint text and secondary button from the phone composer (keep them reachable via '+'). It stays pinned above the keyboard (the existing visualViewport handling), with safe-area bottom padding, and hides the orchestrator bar while typing if that's already the behaviour. Desktop is unchanged. Before and after screenshots at 390x844 with and without the keyboard via bin/shot.mjs. Tests: at 390px the composer shows only the text field, send, model pill and '+'; the '+' sheet contains the moved options; sending still works. Run only the touched test files.

## Done when

`node --test test/ui-mobile-composer*.test.mjs` passes (only field, send, model pill and + visible at 390px; the + sheet holds the moved options; send works)

## Result — done (check passed) (2026-09-28 17:02)

AGENT-ORCH-STATUS: done — phone composer shows only field, send, model pill and '+'
