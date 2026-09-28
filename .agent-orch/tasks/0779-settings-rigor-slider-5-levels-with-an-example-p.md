# Task #779: Settings: Rigor slider (5 levels) with an example prompt for each

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 23:18  
- files: public/app.js, public/index.html, public/app.css, test/ui-rigor*.test.mjs

## Prompt

UI for the per-project rigor level (public/app.js, public/index.html, app.css), under Settings → This project. Contract (the parallel backend task implements it; code exactly to it): GET /api/orch/rigor-levels → [{level, name, summary, example:{title, prompt, done_when}}]; the project's current level is projects.rigor (in the project payload), saved via the existing project PATCH {rigor}. Render a 'Rigor' control: a 5-step segmented slider labelled 1-5 with the level name shown for the selected step (e.g. '2 · Working product') and a one-line summary. Below it, an 'Example task at this level' card showing the example's title, a prompt excerpt (the first ~4 lines, expandable) and its done_when, which updates as the owner moves the slider (preview before saving is fine; save on release/click with a toast 'Rigor set to 2 · Working product: applies to new planning and reflection'). The hint says 'Used by the chat planner and reflection for this project. Lower = fewer, simpler tasks focused on working features.' It's keyboard accessible (arrow keys), 44pt on phones, and theme-consistent. Tests with mocked endpoints: the slider shows the project's level; moving it updates the example card; saving PATCHes {rigor}; the 5 steps render with names. Run only the touched test files.

## Done when

`node --test test/ui-rigor*.test.mjs` passes (current level shown, example updates per step, save PATCHes rigor, 5 named steps)
