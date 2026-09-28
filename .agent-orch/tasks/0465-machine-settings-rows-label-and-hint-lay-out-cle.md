# Task #465: Machine settings rows: label and hint lay out cleanly next to their controls

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 16:56  
- files: public/app.js, public/app.css, test/ui-machine-settings-rows*.test.mjs

## Prompt

In the machine settings panel (public/app.js ~line 4579, the `row(sec, label, hint, control)` helper, used e.g. at ~4638 `row(manage, 'Finish sound', 'Plays when a task finishes here', machineSoundPicker(n))`), the text renders poorly: the label and hint get squeezed by the wide control (the sound <select> from machineSoundPicker ~4668 plus ▶ Test), so words wrap one per line or the text overlaps. Fix the row layout in public/app.css (plus markup tweaks in the helper if needed) for ALL rows built by this helper: 1) A two-column flex row: the text block (label on top at 15px/600, hint below at 13px muted, normal wrapping, `min-width: 0; flex: 1 1 12rem`) and the control block (`flex: 0 1 auto; max-width: 55%`), vertically centred, with an 8-12px gap. Selects get `max-width: 100%; text-overflow: ellipsis`, and the sound picker's select plus test button stay on one line. 2) When the row is narrower than ~420px (a container query on the panel, or a media query at 600px), the control drops BELOW the text at full width instead of squeezing it. 3) There's no mid-word breaking or overlap; hints read as one sentence. Check dark mode. 4) Screenshots via bin/shot.mjs of the machine settings panel at 1280px and 390px (a seeded node with custom sounds so the select is wide), saved to .agent-orch/shots/. Test: at 390px and 1280px, each settings row's label and hint elements have no overlap with the control's bounding box, and the hint's height is at most 2 lines at 1280px (a Playwright UI test). Run only the touched test files.

## Done when

`node --test test/ui-machine-settings-rows*.test.mjs` passes (no text/control overlap at 390 and 1280, hint ≤2 lines at 1280), with before/after screenshots in .agent-orch/shots/
