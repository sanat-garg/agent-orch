# Task #450: Simpler phone header

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 14:49  
- files: public/index.html, public/app.css, public/app.js, test/ui-mobile-header*.test.mjs, test/ui-static.test.mjs

## Prompt

Redesign the top header on phones (<768px; public/index.html header, public/app.css, and header logic in public/app.js) to be much simpler, following ~/.claude/skills/apple-design (navigation bars). One row, 44pt tall below the safe-area inset: on the left the sidebar/menu button; in the centre the current project/chat title (truncated) with a small chevron that opens the view switcher (Chat / Files / Terminal / Browser) as a compact menu or sheet, replacing the full segmented control on phones; on the right at most ONE action (the most useful for the current view, e.g. new chat in Chat), with everything else moved into a '⋯' overflow menu (repo link, etc.). Remove secondary badges, labels and duplicate status from the phone header (the orchestrator bar already shows status). Desktop layout unchanged. Keep every id the static UI test needs (update it where ids move). Before and after screenshots at 390x844 and 430x932 via bin/shot.mjs. Tests: at 390px the header has at most 3 visible interactive controls, the view switcher opens and switches views, and there's no horizontal overflow. Run only the touched test files.

## Done when

`node --test test/ui-mobile-header*.test.mjs test/ui-static.test.mjs` passes (≤3 visible header controls at 390px, view switcher works, no overflow)

## Result — done (check passed) (2026-09-28 15:06)

AGENT-ORCH-STATUS: done — phone header: one 44pt row, title menu switches views; tests pass
