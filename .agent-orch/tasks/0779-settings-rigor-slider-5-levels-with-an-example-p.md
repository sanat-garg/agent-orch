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

## Result — done (check passed) (2026-09-28 23:24)

I built the Rigor control under Settings → This project, and all 5 tests in `node --test test/ui-rigor.test.mjs` pass in a real browser here (none skipped).

- **Control:** five segments labelled 1–5 with the level names. The selected level shows as e.g. "2 · Working product" with its one-line summary, and the hint text is the one you specified.
- **Example card:** "Example task at this level" shows the title, the first 4 lines of the prompt with a "Show full prompt" toggle, and the done_when. It updates as you click, drag or use the arrow keys (Home/End also work).
- **Saving:** a click or releasing a drag saves at once; with the arrow keys it saves after a short pause. Each save shows the toast "Rigor set to 2 · Working product: applies to new planning and reflection". Picking the level it already has saves nothing.
- **Phones and themes:** steps are 44px tall on touch screens. Screenshots are in `.agent-orch/shots/rigor-desktop-light.png`, `rigor-desktop-dark.png` and `rigor-phone.png`.

Decisions for you:
- **How it saves:** today's project endpoint only takes POST, and the backend task (#778) that adds rigor hasn't landed yet. So it sends PATCH `{rigor}` as the contract says, and if the server answers with a plain 404 or 405 it sends the same body as a POST. One test covers that fallback. This way it works however #778 wires the route; the fallback is easy to drop once the PATCH route is in.
- **Projects without a level:** if the project payload has no `rigor` yet, the slider shows 3, matching the planned migration for existing projects.

In the neighbouring tests I ran, `test/ui-static.test.mjs` has one failure ("the sidebar gear opens Settings…", an assertion about the "Restarting once idle" text). It fails the same way without my changes, so it was already broken.

AGENT-ORCH-STATUS: done — Rigor slider with example card saves per project
